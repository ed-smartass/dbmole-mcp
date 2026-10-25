import { connect } from 'node:net'
import { Duplex } from 'node:stream'
import { BackendDisposedError, DEFAULT_QUERY_TIMEOUT_MS, type Truncation } from '@dbmole/core'
import mysql from 'mysql2'
import { normalizeCell } from '../format.js'
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
import { HINT_TIMEOUT_MS, type HintQuery, mysqlHint } from './mysqlHints.js'
import { mysqlSsl } from './tls.js'

const NO_DATABASE = ''
const KILL_TIMEOUT_MS = 5_000
const RESET_TIMEOUT_MS = 5_000

type Streamed = {
    columns: string[]
    rows: unknown[][]
    header?: mysql.ResultSetHeader
    truncated: boolean
}

type Run = (sql: string, values?: unknown[], rowLimit?: number) => Promise<Streamed>

const checkout = (pool: mysql.Pool): Promise<mysql.PoolConnection> =>
    new Promise((resolve, reject) => {
        pool.getConnection((error, conn) => {
            if (error) {
                reject(error)
                return
            }
            resolve(conn)
        })
    })

const endPool = (pool: mysql.Pool): Promise<void> =>
    new Promise((resolve) => {
        pool.end(() => resolve())
    })

// mysql2's destroy() only half-closes the socket (stream.end()): the client
// keeps parsing the rest of a big result and the server keeps sending it.
// Destroying the socket as well makes the server abort on its next write.
// Takes any connection: pool checkouts and the one-off hint connection (Task 11).
const destroy = (conn: mysql.Connection): void => {
    conn.destroy()
    // ponytail: `stream` is mysql2 internals with no typing; instanceof keeps it safe.
    const socket: unknown = Reflect.get(conn, 'stream')
    if (socket instanceof Duplex) {
        socket.destroy()
    }
}

// COM_RESET_CONNECTION, then back to the pool: rolls back, resets autocommit,
// session variables, transaction characteristics and temp tables. It keeps the
// current database, hence USE on every checkout. Done here, not with the
// pool's resetOnRelease: that waits on the reset with no timeout, so a stalled
// reply would strand the pool slot (with pool size 1, every later call hangs).
// A failed or stalled reset destroys the connection instead. Never rejects.
const resetAndRelease = (conn: mysql.PoolConnection): Promise<void> =>
    new Promise((resolve) => {
        let settled = false
        const finish = (reusable: boolean): void => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timer)
            if (reusable) {
                conn.release()
            } else {
                destroy(conn)
            }
            resolve()
        }
        const timer = setTimeout(() => finish(false), RESET_TIMEOUT_MS)
        conn.reset((error) => finish(!error))
    })

// One statement through the callback API's row events, keeping at most
// rowLimit + 1 rows of the first result set; CALL's later sets and its status
// packet are skipped. Overflow, timeout and a lost connection call stop(),
// which destroys the connection: mysql2 cannot cancel a running query. A
// timeout first awaits cancel() (KILL QUERY): the server keeps running a
// statement that produces no output (SLEEP, a big sort) after the socket is gone.
const streamQuery = (
    conn: mysql.PoolConnection,
    query: { sql: string; values: unknown[]; rowLimit: number; timeout: number },
    stop: () => void,
    cancel: () => Promise<void>
): Promise<Streamed> =>
    new Promise((resolve, reject) => {
        const rows: unknown[][] = []
        let columns: string[] | undefined
        let firstSet = -1
        let sets = 0
        let header: mysql.ResultSetHeader | undefined
        let settled = false

        const settle = (): boolean => {
            if (settled) {
                return false
            }
            settled = true
            conn.off('error', onLost)
            // mysql2 clears the query's timeout timer only when the query ends
            // or times out; after an early stop or a lost connection the armed
            // timer would keep the query, these listeners (with the rows read
            // so far) and the connection alive until queryTimeoutMs.
            // ponytail: `queryTimeout` is mysql2 internals; clearTimeout
            // ignores anything that is not a timer, so a rename is a no-op.
            Reflect.apply(clearTimeout, undefined, [Reflect.get(running, 'queryTimeout')])
            return true
        }
        const fail = (error: Error, kill: boolean): void => {
            if (settle()) {
                if (kill) {
                    stop()
                }
                reject(error)
            }
        }
        const succeed = (truncated: boolean): void => {
            if (settle()) {
                if (truncated) {
                    stop()
                }
                resolve({
                    columns: columns ?? [],
                    rows: rows.slice(0, query.rowLimit),
                    header,
                    truncated
                })
            }
        }
        // When the connection dies, mysql2 tells the connection, not the
        // running query (which would otherwise wait for its timeout).
        const onLost = (error: Error): void => {
            fail(error, true)
        }

        conn.on('error', onLost)
        const running = conn.query({
            sql: query.sql,
            values: query.values,
            rowsAsArray: true,
            timeout: query.timeout
        })
        // One 'fields' event per result set: an array for a row set, undefined
        // for an OK packet. Its position matches the index on row events.
        running.on('fields', (fields: mysql.FieldPacket[] | undefined) => {
            if (columns === undefined && fields) {
                columns = fields.map((field) => field.name)
                firstSet = sets
            }
            sets += 1
        })
        running.on('result', (row: unknown[] | mysql.ResultSetHeader, index?: number) => {
            if (settled) {
                return
            }
            if (!Array.isArray(row)) {
                header ??= row
                return
            }
            if (index !== firstSet) {
                return
            }
            rows.push(row)
            if (rows.length > query.rowLimit) {
                succeed(true)
            }
        })
        running.on('error', (error: mysql.QueryError) => {
            if (error.code !== 'PROTOCOL_SEQUENCE_TIMEOUT') {
                fail(error, false)
                return
            }
            if (settle()) {
                const done = (): void => {
                    stop()
                    reject(error)
                }
                // Settle even if cancel() breaks its never-throws promise.
                cancel().then(done, done)
            }
        })
        running.on('end', () => {
            succeed(false)
        })
    })

export const createMysqlDriver = (target: DriverTarget, options: DriverOptions = {}): Driver => {
    const pools = new Map<string, mysql.Pool>()
    const timeout = target.config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
    let disposed = false

    const ssl = mysqlSsl(target.config)
    // Through a tunnel, dial the local forward but keep `host` = the real server:
    // mysql2 takes the TLS servername and identity check from `host`.
    const tunneled = target.host !== target.serverName

    // Shared by the pools and the one-off KILL QUERY and hint-lookup connections.
    const connectOptions = {
        host: target.serverName,
        port: target.port,
        // mysql2 skips its own setNoDelay/setKeepAlive on a supplied stream.
        ...(tunneled
            ? {
                  stream: () =>
                      connect(target.port, target.host).setNoDelay(true).setKeepAlive(true)
              }
            : {}),
        ...(ssl ? { ssl } : {}),
        user: target.config.user,
        password: target.config.password,
        connectTimeout: 10_000,
        enableKeepAlive: true
    }

    // A short-lived connection outside the pools (KILL QUERY, hint lookups): no
    // pool slot may be free (pool size 1), and a stuck one must not hold a slot.
    // No database is selected; connect and query share timeoutMs. The caller
    // must close() it, which tears down the socket too. createConnection can
    // throw synchronously.
    const oneOff = (timeoutMs: number) => {
        const conn = mysql.createConnection({ ...connectOptions, connectTimeout: timeoutMs })
        // Connect failures also reach the query callback; this keeps them from
        // being an unhandled 'error' event.
        conn.on('error', () => {})
        const query = (sql: string, values: unknown[] = []): Promise<unknown[][]> =>
            new Promise((resolve, reject) => {
                conn.query<mysql.RowDataPacket[][]>(
                    { sql, values, rowsAsArray: true, timeout: timeoutMs },
                    (error, rows) => {
                        if (error) {
                            reject(error)
                            return
                        }
                        resolve(rows)
                    }
                )
            })
        return { query, close: () => destroy(conn) }
    }

    // Kills the statement running on `threadId` from a one-off connection.
    // Never throws.
    const killQuery = async (threadId: number): Promise<void> => {
        let killer: ReturnType<typeof oneOff> | undefined
        try {
            killer = oneOff(KILL_TIMEOUT_MS)
            await killer.query('KILL QUERY ' + threadId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error('dbmole: mysql KILL QUERY ' + threadId + ' failed: ' + message)
        } finally {
            killer?.close()
        }
    }

    const getPool = (database: string | null): mysql.Pool => {
        if (disposed) {
            throw new BackendDisposedError()
        }
        const key = database ?? NO_DATABASE
        const existing = pools.get(key)
        if (existing) {
            return existing
        }
        const pool = mysql.createPool({
            ...connectOptions,
            ...(database ? { database } : {}),
            connectionLimit: options.poolSize ?? DEFAULT_POOL_SIZE,
            maxIdle: 1,
            idleTimeout: 60_000,
            // withConnection resets with a bound instead (resetAndRelease).
            resetOnRelease: false,
            multipleStatements: false,
            supportBigNumbers: true,
            bigNumberStrings: true,
            // Wall-clock strings as the server renders them: no tz shift from
            // normalizeCell's toISOString().
            dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP']
        })
        pools.set(key, pool)
        return pool
    }

    // Every call runs on one checked-out connection. Setup re-selects the
    // database and re-applies readonly; if it fails the connection is
    // destroyed. reuse=false destroys the connection after the call instead of
    // releasing it (database-less execute_sql: nothing restores "no database
    // selected" after a USE).
    const withConnection = async <T>(
        database: string | null,
        fn: (run: Run) => Promise<T>,
        reuse = true
    ): Promise<T> => {
        const conn = await checkout(getPool(database))
        let open = true
        const stop = (): void => {
            if (open) {
                open = false
                destroy(conn)
            }
        }
        const cancel = (): Promise<void> => killQuery(conn.threadId)
        const run: Run = (sql, values = [], rowLimit = Number.POSITIVE_INFINITY) =>
            streamQuery(conn, { sql, values, rowLimit, timeout }, stop, cancel)
        try {
            if (database !== null) {
                await run('USE ' + mysql.escapeId(database))
            }
            if (target.config.readonly) {
                await run('SET SESSION TRANSACTION READ ONLY')
            }
        } catch (error) {
            stop()
            throw error
        }
        try {
            return await fn(run)
        } finally {
            if (!reuse) {
                stop()
            } else if (open) {
                await resetAndRelease(conn)
            }
        }
    }

    const runArray = (database: string | null, sql: string, params: unknown[] = []) =>
        withConnection(database, (run) => run(sql, params))

    const runStatement = async (
        { sql, params = [], rowLimit }: QueryArgs,
        db: string | null
    ): Promise<QueryResult> => {
        const result = await withConnection(db, (run) => run(sql, params, rowLimit), db !== null)
        if (result.header && result.columns.length === 0) {
            return {
                columns: [],
                rows: [],
                rowCount: result.header.affectedRows ?? 0,
                ...(result.header.insertId ? { lastInsertId: String(result.header.insertId) } : {})
            }
        }
        const truncated: Truncation | undefined = result.truncated
            ? { reason: 'rowLimit', limit: rowLimit }
            : undefined
        return {
            columns: result.columns,
            rows: result.rows.map((row) => row.map(normalizeCell)),
            rowCount: result.rows.length,
            truncated
        }
    }

    // Adds `hint` to errors the agent can fix itself (unknown column/table, reserved
    // word). Runs after the failed statement's connection is released. Lookups run
    // on one-off connections, opened only when a lookup runs and always closed,
    // even when mysqlHint's 2 s cap gives up on a lookup still in flight.
    // information_schema lookups are fully qualified, so no database is needed.
    const attachHint = async (error: unknown, sql: string, database: string | null) => {
        const opened: Array<() => void> = []
        const run: HintQuery = (hintSql, params) => {
            const conn = oneOff(HINT_TIMEOUT_MS)
            opened.push(conn.close)
            return conn.query(hintSql, params)
        }
        try {
            const hint = await mysqlHint(error, { sql, database, run })
            if (hint && error instanceof Error) {
                Object.assign(error, { hint })
            }
        } finally {
            for (const close of opened) {
                close()
            }
        }
    }

    const query = async (args: QueryArgs): Promise<QueryResult> => {
        const db = args.database ?? target.config.database ?? null
        try {
            return await runStatement(args, db)
        } catch (error) {
            await attachHint(error, args.sql, db)
            throw error
        }
    }

    const listDatabases = async (): Promise<DatabaseInfo[]> => {
        const result = await runArray(
            null,
            `
                SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0)
                FROM information_schema.schemata s
                LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
                WHERE s.schema_name NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
                GROUP BY s.schema_name
                ORDER BY s.schema_name
            `
        )
        return result.rows.map((row) => ({
            name: String(row[0]),
            sizeBytes: row[1] === null ? null : Number(row[1])
        }))
    }

    const effectiveSchema = (args: { database?: string; schema?: string }): string =>
        args.schema ?? resolveDatabase(target.config, args.database)

    const listTables = async (args: {
        database?: string
        schema?: string
    }): Promise<TableInfo[]> => {
        const schema = effectiveSchema(args)
        const result = await runArray(
            null,
            `
                SELECT table_schema, table_name, table_rows, table_type
                FROM information_schema.tables
                WHERE table_schema = ? AND table_type IN ('BASE TABLE', 'VIEW')
                ORDER BY table_name
            `,
            [schema]
        )
        return result.rows.map((row) => ({
            schema: String(row[0]),
            name: String(row[1]),
            type: row[3] === 'VIEW' ? 'view' : 'table',
            rowEstimate: row[2] === null ? null : Number(row[2])
        }))
    }

    const describeTable = async (args: {
        table: string
        database?: string
        schema?: string
    }): Promise<TableDescription> => {
        const { qualifier, table } = resolveQualified(
            args.table,
            args.schema ?? args.database,
            'database'
        )
        const schema = qualifier ?? resolveDatabase(target.config, undefined)

        const columns = await runArray(
            null,
            `
                SELECT column_name, column_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = ? AND table_name = ?
                ORDER BY ordinal_position
            `,
            [schema, table]
        )
        if (columns.rows.length === 0) {
            throw new Error("table '" + schema + '.' + table + "' not found")
        }

        const indexRows = await runArray(
            null,
            `
                SELECT index_name, non_unique, column_name
                FROM information_schema.statistics
                WHERE table_schema = ? AND table_name = ?
                ORDER BY index_name, seq_in_index
            `,
            [schema, table]
        )

        const fkRows = await runArray(
            null,
            `
                SELECT constraint_name, column_name, referenced_table_name, referenced_column_name
                FROM information_schema.key_column_usage
                WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL
                ORDER BY constraint_name, ordinal_position
            `,
            [schema, table]
        )

        const primaryKey: string[] = []
        const indexMap = new Map<string, { unique: boolean; columns: string[] }>()
        for (const row of indexRows.rows) {
            const name = String(row[0])
            if (name === 'PRIMARY') {
                primaryKey.push(String(row[2]))
                continue
            }
            const entry = indexMap.get(name) ?? { unique: !Number(row[1]), columns: [] }
            entry.columns.push(String(row[2]))
            indexMap.set(name, entry)
        }

        const fkMap = new Map<
            string,
            { columns: string[]; referencedTable: string; referencedColumns: string[] }
        >()
        for (const row of fkRows.rows) {
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
            primaryKey,
            indexes: [...indexMap.entries()].map(([name, entry]) => ({ name, ...entry })),
            foreignKeys: [...fkMap.entries()].map(([name, entry]) => ({ name, ...entry }))
        }
    }

    const serverVersion = async (): Promise<string> => {
        const result = await runArray(null, 'SELECT VERSION()')
        return String(result.rows[0]?.[0] ?? 'unknown')
    }

    const dispose = async (): Promise<void> => {
        disposed = true
        const all = [...pools.values()]
        pools.clear()
        await Promise.all(all.map(endPool))
    }

    return { query, listDatabases, listTables, describeTable, serverVersion, dispose }
}
