import { BackendDisposedError, DEFAULT_QUERY_TIMEOUT_MS, type Truncation } from '@dbmole/core'
import pg from 'pg'
import Cursor from 'pg-cursor'
import { normalizeCell } from '../format.js'
import type { ConnectionConfig } from '../schema.js'
import {
    type DatabaseInfo,
    DEFAULT_POOL_SIZE,
    type Driver,
    type DriverOptions,
    type DriverTarget,
    type QueryArgs,
    type QueryResult,
    resolveDatabase,
    resolveQualified,
    type TableDescription,
    type TableInfo
} from './driver.js'
import { pgSsl } from './tls.js'

const MAINTENANCE_DB = 'postgres'

const DATE_OID = 1082
const TIMESTAMP_OID = 1114
// Widened to number: the literal 1009 is not a member of pg-types' TypeId enum,
// but a plain number is assignable to it.
const TEXT_ARRAY_OID: number = 1009
const DATE_ARRAY_OID = 1182
const TIMESTAMP_ARRAY_OID = 1115

const identityParser = (value: string): string => value

// pg-types parses DATE and TIMESTAMP-without-tz (and their arrays) to LOCAL JS
// Dates, so a later toISOString() shifts the calendar day in non-UTC zones. Keep
// these wall-clock types as raw strings; arrays reuse pg's text[] parser (NULL
// elements stay null). TIMESTAMPTZ and its array keep the default Date parser.
// The pool hands these to every client, and pg applies the client's types to
// pg-cursor results too.
export const buildTypeOverrides = (): pg.TypeOverrides => {
    const types = new pg.TypeOverrides()
    types.setTypeParser(DATE_OID, identityParser)
    types.setTypeParser(TIMESTAMP_OID, identityParser)
    // TypeOverrides' d.ts types getTypeParser as a number parser; through
    // CustomTypesConfig it is `any`, which is what it is.
    const defaults: pg.CustomTypesConfig = types
    const textArray: (value: string) => unknown = defaults.getTypeParser(TEXT_ARRAY_OID, 'text')
    types.setTypeParser(DATE_ARRAY_OID, textArray)
    types.setTypeParser(TIMESTAMP_ARRAY_OID, textArray)
    return types
}

// Startup options become the session defaults, so DISCARD ALL after every call
// restores them instead of clearing them.
const startupOptions = (config: ConnectionConfig): string => {
    const timeout = '-c statement_timeout=' + (config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS)
    return config.readonly ? '-c default_transaction_read_only=on ' + timeout : timeout
}

// pg hands COPY protocol messages to the active query, and pg-cursor has no
// handlers for them: a COPY would throw inside pg's socket handler and kill
// the process. COPY FROM STDIN is refused with CopyFail: the server answers
// with an error and the cursor syncs as for any failed statement. COPY TO
// STDOUT output is dropped as it arrives; the statement then completes
// normally (within statement_timeout), so the session stays clean, and the
// call fails afterwards.
class CopyRefusingCursor extends Cursor<unknown[]> {
    copiedOut = false

    handleCopyInResponse(connection: { sendCopyFail: (message: string) => void }): void {
        connection.sendCopyFail('not supported; use INSERT')
    }

    handleCopyData(): void {
        this.copiedOut = true
    }
}

// Callback form of cursor.read: the promise form drops the Result, which carries
// the column list and the command tag's affected-row count.
const readCursor = (
    cursor: Cursor<unknown[]>,
    count: number
): Promise<{ rows: unknown[][]; result: pg.QueryResult }> =>
    new Promise((resolve, reject) => {
        cursor.read(count, (error, rows, result) => {
            if (error) {
                reject(error)
                return
            }
            resolve({ rows, result })
        })
    })

// pg fails only the queries it still counts as running when the connection
// drops; pg-cursor's close() (and a read the server already completed) waits
// for a ReadyForQuery that never comes. Settle with the connection instead: the
// caller's cleanup then fails on the dead client and destroys it.
const unlessLost = <T>(client: pg.PoolClient, work: Promise<T>): Promise<T> => {
    let detach = (): void => {}
    const lost = new Promise<never>((_, reject) => {
        const onEnd = (): void => {
            reject(new Error('Connection terminated'))
        }
        client.on('error', reject)
        client.on('end', onEnd)
        detach = () => {
            client.off('error', reject)
            client.off('end', onEnd)
        }
    })
    return Promise.race([work, lost]).finally(detach)
}

// ROLLBACK ends whatever transaction the call left open (the readonly BEGIN, or
// a user's BEGIN); DISCARD ALL then resets session state to the startup
// defaults. DISCARD ALL cannot run inside a transaction block, so the two are
// separate round trips. A client that fails either is destroyed, not reused.
const resetAndRelease = async (client: pg.PoolClient): Promise<void> => {
    try {
        await client.query('ROLLBACK')
        await client.query('DISCARD ALL')
    } catch {
        client.release(true)
        return
    }
    client.release()
}

export const createPostgresDriver = (target: DriverTarget, options: DriverOptions = {}): Driver => {
    const pools = new Map<string, pg.Pool>()
    const types = buildTypeOverrides()
    // Read once: a bad ca path fails the connection build, not every call.
    const ssl = pgSsl(target.config, target.serverName)
    let disposed = false

    const getPool = (database: string): pg.Pool => {
        if (disposed) {
            throw new BackendDisposedError()
        }
        const existing = pools.get(database)
        if (existing) {
            return existing
        }
        const pool = new pg.Pool({
            host: target.host,
            port: target.port,
            user: target.config.user,
            password: target.config.password,
            ...(ssl ? { ssl } : {}),
            database,
            max: options.poolSize ?? DEFAULT_POOL_SIZE,
            connectionTimeoutMillis: 10_000,
            // statement_timeout is server-side: on a silent network drop only TCP
            // keepalive notices the dead peer and fails the pending query.
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            types,
            options: startupOptions(target.config)
        })
        pool.on('error', (error) => {
            console.error('dbmole: postgres pool error: ' + error.message)
        })
        pools.set(database, pool)
        return pool
    }

    // Every call, helpers included, runs on one checked-out client and leaves it
    // clean. Readonly calls run inside BEGIN READ ONLY, which also stops a DO
    // block from COMMITting its way out of the read-only transaction.
    const withClient = async <T>(
        database: string,
        fn: (client: pg.PoolClient) => Promise<T>
    ): Promise<T> => {
        const client = await getPool(database).connect()
        // pg-pool drops its error listener while a client is checked out, so a
        // backend dying mid-call would be an unhandled 'error' event and crash the
        // process. The pending query rejects on its own; this only logs.
        const onError = (error: Error): void => {
            console.error('dbmole: postgres connection error: ' + error.message)
        }
        client.on('error', onError)
        if (target.config.readonly) {
            try {
                await client.query('BEGIN READ ONLY')
            } catch (error) {
                // Failed setup: the session state is unknown, so destroy, never reuse.
                client.release(true)
                client.off('error', onError)
                throw error
            }
        }
        try {
            return await fn(client)
        } finally {
            await resetAndRelease(client)
            client.off('error', onError)
        }
    }

    const maintenanceDb = (): string => target.config.database ?? MAINTENANCE_DB

    const runArray = (
        database: string,
        sql: string,
        params: unknown[] = []
    ): Promise<{ rows: unknown[][] }> =>
        withClient(database, (client) =>
            client.query<unknown[]>({ text: sql, values: params, rowMode: 'array' })
        )

    const query = async ({
        sql,
        params = [],
        database,
        rowLimit
    }: QueryArgs): Promise<QueryResult> =>
        withClient(resolveDatabase(target.config, database), async (client) => {
            // Parse/Bind accepts exactly one statement: a multi-statement string
            // fails at Parse, before anything runs.
            const cursor = client.query(new CopyRefusingCursor(sql, params, { rowMode: 'array' }))
            // ponytail: one read of rowLimit + 1 rows; rowLimit <= MAX_ROW_LIMIT,
            // so batching would not lower peak memory. On a read error the portal
            // is already gone (pg-cursor synced), so close only after success.
            const { rows, result } = await unlessLost(
                client,
                readCursor(cursor, rowLimit + 1).then(async (read) => {
                    await cursor.close()
                    return read
                })
            )
            if (cursor.copiedOut) {
                throw new Error('COPY TO STDOUT is not supported; use SELECT')
            }
            const columns = result.fields.map((field) => field.name)
            const kept = rows.slice(0, rowLimit)
            const truncated: Truncation | undefined =
                rows.length > rowLimit ? { reason: 'rowLimit', limit: rowLimit } : undefined
            return {
                columns,
                rows: kept.map((row) => row.map(normalizeCell)),
                // No columns: a command, so report its affected rows (null for DDL).
                rowCount: columns.length > 0 ? kept.length : (result.rowCount ?? 0),
                truncated
            }
        })

    const listDatabases = async (): Promise<DatabaseInfo[]> => {
        const result = await runArray(
            maintenanceDb(),
            `
                SELECT datname, pg_database_size(datname)
                FROM pg_database
                WHERE NOT datistemplate
                ORDER BY datname
            `
        )
        return result.rows.map((row) => ({
            name: String(row[0]),
            sizeBytes: row[1] === null ? null : Number(row[1])
        }))
    }

    const listTables = async (args: {
        database?: string
        schema?: string
    }): Promise<TableInfo[]> => {
        const db = resolveDatabase(target.config, args.database)
        const result = await runArray(
            db,
            `
                SELECT n.nspname, c.relname, c.reltuples::bigint, c.relkind
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p', 'v', 'm')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND ($1::text IS NULL OR n.nspname = $1)
                ORDER BY n.nspname, c.relname
            `,
            [args.schema ?? null]
        )
        return result.rows.map((row) => {
            const estimate = Number(row[2])
            // A plain view has no estimate: its reltuples is -1 on PG 14+, 0 before.
            return {
                schema: String(row[0]),
                name: String(row[1]),
                type: row[3] === 'v' || row[3] === 'm' ? 'view' : 'table',
                rowEstimate: estimate < 0 || row[3] === 'v' ? null : estimate
            }
        })
    }

    const describeTable = async (args: {
        table: string
        database?: string
        schema?: string
    }): Promise<TableDescription> => {
        const db = resolveDatabase(target.config, args.database)
        const { qualifier, table } = resolveQualified(args.table, args.schema, 'schema')
        const schema = qualifier ?? 'public'

        let columns = await runArray(
            db,
            `
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = $1 AND table_name = $2
                ORDER BY ordinal_position
            `,
            [schema, table]
        )
        // information_schema omits materialized views; read their columns from
        // pg_catalog. ponytail: fallback only, so tables and views keep the
        // information_schema type names (format_type would differ, e.g. varchar(n)).
        if (columns.rows.length === 0) {
            columns = await runArray(
                db,
                `
                    SELECT a.attname,
                           format_type(a.atttypid, a.atttypmod),
                           CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
                           pg_get_expr(d.adbin, d.adrelid)
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE n.nspname = $1 AND c.relname = $2
                      AND c.relkind IN ('r', 'p', 'v', 'm')
                      AND a.attnum > 0 AND NOT a.attisdropped
                    ORDER BY a.attnum
                `,
                [schema, table]
            )
        }
        if (columns.rows.length === 0) {
            throw new Error("table '" + schema + '.' + table + "' not found")
        }

        const primaryKey = await runArray(
            db,
            `
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name = tc.constraint_name
                 AND kcu.table_schema = tc.table_schema
                 AND kcu.table_name = tc.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = $1 AND tc.table_name = $2
                ORDER BY kcu.ordinal_position
            `,
            [schema, table]
        )

        const indexes = await runArray(
            db,
            `
                SELECT i.relname, ix.indisunique, pg_get_indexdef(ix.indexrelid, k.i, true)
                FROM pg_index ix
                JOIN pg_class i ON i.oid = ix.indexrelid
                JOIN pg_class t ON t.oid = ix.indrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                JOIN generate_series(1, ix.indnkeyatts) AS k(i) ON true
                WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
                ORDER BY i.relname, k.i
            `,
            [schema, table]
        )

        const foreignKeys = await runArray(
            db,
            `
                SELECT con.conname,
                       att.attname,
                       confrel.relname,
                       fatt.attname
                FROM pg_constraint con
                JOIN pg_class rel ON rel.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = rel.relnamespace
                JOIN pg_class confrel ON confrel.oid = con.confrelid
                JOIN unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON true
                JOIN unnest(con.confkey) WITH ORDINALITY AS dst(attnum, ord) ON dst.ord = src.ord
                JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = src.attnum
                JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = dst.attnum
                WHERE con.contype = 'f' AND n.nspname = $1 AND rel.relname = $2
                ORDER BY con.conname, src.ord
            `,
            [schema, table]
        )

        const indexMap = new Map<string, { unique: boolean; columns: string[] }>()
        for (const row of indexes.rows) {
            const name = String(row[0])
            const entry = indexMap.get(name) ?? { unique: Boolean(row[1]), columns: [] }
            entry.columns.push(String(row[2]))
            indexMap.set(name, entry)
        }

        const fkMap = new Map<
            string,
            { columns: string[]; referencedTable: string; referencedColumns: string[] }
        >()
        for (const row of foreignKeys.rows) {
            const name = String(row[0])
            const entry = fkMap.get(name) ?? {
                columns: [],
                referencedTable: String(row[2]),
                referencedColumns: []
            }
            entry.columns.push(String(row[1]))
            entry.referencedColumns.push(String(row[3]))
            fkMap.set(name, entry)
        }

        return {
            columns: columns.rows.map((row) => ({
                name: String(row[0]),
                type: String(row[1]),
                nullable: row[2] === 'YES',
                default: row[3] === null ? null : String(row[3])
            })),
            primaryKey: primaryKey.rows.map((row) => String(row[0])),
            indexes: [...indexMap.entries()].map(([name, entry]) => ({ name, ...entry })),
            foreignKeys: [...fkMap.entries()].map(([name, entry]) => ({ name, ...entry }))
        }
    }

    const serverVersion = async (): Promise<string> => {
        const result = await runArray(maintenanceDb(), 'SHOW server_version')
        return String(result.rows[0]?.[0] ?? 'unknown')
    }

    const dispose = async (): Promise<void> => {
        disposed = true
        const all = [...pools.values()]
        pools.clear()
        await Promise.all(all.map((pool) => pool.end().catch(() => {})))
    }

    return { query, listDatabases, listTables, describeTable, serverVersion, dispose }
}
