import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeField = { name: string }
type FakeResult = { fields: FakeField[]; rowCount: number | null }
type CursorScript = FakeResult & {
    rows: unknown[][]
    error?: Error
    clientError?: Error
    // Simulates the server entering COPY OUT (CopyData) or COPY IN (CopyInResponse).
    copy?: 'out' | 'in'
    // The connection drops while close() waits: the client emits this event and
    // close() never settles, as pg-cursor's does.
    dropOnClose?: 'end' | 'error'
}

const pgState = vi.hoisted(() => {
    type State = {
        pools: FakePool[]
        cursors: FakeCursor[]
        // Ordered trace of everything the driver does to clients and cursors.
        log: string[]
        // Config objects passed to client.query (helper queries).
        configs: unknown[]
        // What the next cursor read returns.
        cursor: CursorScript
        // Results for helper queries, in order; empty → { rows: [] }.
        results: Array<{ rows: unknown[][] }>
        // Plain-string queries that reject (e.g. 'DISCARD ALL').
        failing: Set<string>
        // 'error' listeners currently attached to checked-out clients.
        clientListeners: Array<{ event: string; fn: (error?: Error) => void }>
    }

    const state: State = {
        pools: [],
        cursors: [],
        log: [],
        configs: [],
        cursor: { rows: [], fields: [], rowCount: null },
        results: [],
        failing: new Set(),
        clientListeners: []
    }

    const emit = (event: string, error?: Error): void => {
        for (const listener of state.clientListeners) {
            if (listener.event === event) {
                listener.fn(error)
            }
        }
    }

    class FakeCursor {
        text: string
        values: unknown[]
        config: unknown

        constructor(text: string, values: unknown[], config: unknown) {
            this.text = text
            this.values = values
            this.config = config
            state.cursors.push(this)
        }

        read(
            count: number,
            cb: (error: Error | undefined, rows: unknown[][], result: FakeResult) => void
        ) {
            state.log.push('read ' + count)
            const script = state.cursor
            setImmediate(() => {
                // pg calls these on the active query; the driver's cursor must define them.
                const hook = (name: string, arg: unknown): void => {
                    const fn: unknown = Reflect.get(this, name)
                    if (typeof fn !== 'function') {
                        throw new TypeError('cursor.' + name + ' is not a function')
                    }
                    fn.call(this, arg)
                }
                if (script.copy === 'out') {
                    hook('handleCopyData', {})
                }
                if (script.copy === 'in') {
                    const connection = {
                        sendCopyFail: (message: string) => {
                            state.log.push('copyFail ' + message)
                        }
                    }
                    hook('handleCopyInResponse', connection)
                    cb(new Error('COPY from stdin failed'), [], { fields: [], rowCount: null })
                    return
                }
                // A dying backend: pg emits 'error' on the client, then fails the query.
                if (script.clientError) {
                    emit('error', script.clientError)
                }
                if (script.error) {
                    cb(script.error, [], { fields: [], rowCount: null })
                    return
                }
                cb(undefined, script.rows.slice(0, count), {
                    fields: script.fields,
                    rowCount: script.rowCount
                })
            })
        }

        close() {
            state.log.push('close')
            const drop = state.cursor.dropOnClose
            if (drop) {
                emit(drop, drop === 'error' ? new Error('read ECONNRESET') : undefined)
                return new Promise<void>(() => {})
            }
            return Promise.resolve()
        }
    }

    class FakeClient {
        query(arg: unknown) {
            if (arg instanceof FakeCursor) {
                state.log.push('cursor ' + arg.text)
                return arg
            }
            if (typeof arg !== 'string') {
                state.log.push('query')
                state.configs.push(arg)
                return Promise.resolve(state.results.shift() ?? { rows: [] })
            }
            state.log.push(arg)
            if (state.failing.has(arg)) {
                return Promise.reject(new Error(arg + ' failed'))
            }
            return Promise.resolve({ rows: [] })
        }

        on(event: string, fn: (error?: Error) => void) {
            state.clientListeners.push({ event, fn })
            return this
        }

        off(event: string, fn: (error?: Error) => void) {
            state.clientListeners = state.clientListeners.filter(
                (other) => other.event !== event || other.fn !== fn
            )
            return this
        }

        release(destroy?: boolean) {
            state.log.push(destroy ? 'destroy' : 'release')
        }
    }

    class FakePool {
        options: Record<string, unknown>
        errorHandlers: unknown[] = []
        ended = false

        constructor(options: Record<string, unknown>) {
            this.options = options
            state.pools.push(this)
        }

        on(event: string, fn: unknown) {
            if (event === 'error') {
                this.errorHandlers.push(fn)
            }
            return this
        }

        async connect() {
            state.log.push('connect')
            return new FakeClient()
        }

        async end() {
            this.ended = true
        }
    }

    return { state, FakePool, FakeCursor }
})

vi.mock('pg', async () => {
    // Use the real TypeOverrides so the driver's date/timestamp parser overrides
    // are exercised against pg's genuine default parsers (e.g. timestamptz).
    const actual = await vi.importActual<{ default: { TypeOverrides: unknown } }>('pg')
    return {
        default: { Pool: pgState.FakePool, TypeOverrides: actual.default.TypeOverrides }
    }
})

vi.mock('pg-cursor', () => ({ default: pgState.FakeCursor }))

import { BackendDisposedError } from '@dbmole/core'
import type { DriverTarget } from '../../../src/db/driver.js'
import { createPostgresDriver } from '../../../src/db/postgres.js'
import type { ConnectionConfig } from '../../../src/schema.js'

const config = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    name: 'pg',
    type: 'postgres',
    host: 'real-host',
    user: 'postgres',
    password: 'pw',
    database: 'main',
    readonly: false,
    ...extra
})

const target = (extra: Partial<ConnectionConfig> = {}): DriverTarget => ({
    config: config(extra),
    host: '127.0.0.1',
    port: 15432,
    serverName: 'real-host'
})

const CLEANUP = ['ROLLBACK', 'DISCARD ALL', 'release']

describe('createPostgresDriver', () => {
    beforeEach(() => {
        const { state } = pgState
        state.pools.length = 0
        state.cursors.length = 0
        state.log.length = 0
        state.configs.length = 0
        state.cursor = { rows: [], fields: [], rowCount: null }
        state.results.length = 0
        state.failing.clear()
        state.clientListeners = []
    })

    it('creates one pool per database and reuses it', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        await driver.query({ sql: 'select 2', rowLimit: 10 })
        await driver.query({ sql: 'select 3', database: 'other', rowLimit: 10 })
        expect(pgState.state.pools).toHaveLength(2)
        expect(pgState.state.pools[0].options).toMatchObject({
            host: '127.0.0.1',
            port: 15432,
            database: 'main',
            max: 4,
            connectionTimeoutMillis: 10_000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000
        })
        expect(pgState.state.pools[1].options).toMatchObject({ database: 'other' })
    })

    it('honors the poolSize option', async () => {
        const driver = createPostgresDriver(target(), { poolSize: 1 })
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.pools[0].options.max).toBe(1)
    })

    it('returns wall-clock date/timestamp types as raw strings, keeps tz absolute', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        const types = pgState.state.pools[0].options.types as {
            getTypeParser: (oid: number, format?: string) => (value: string) => unknown
        }
        // DATE (1082) and TIMESTAMP without tz (1114) stay raw strings.
        expect(types.getTypeParser(1082)('2026-06-11')).toBe('2026-06-11')
        expect(types.getTypeParser(1114)('2026-06-11 12:34:56')).toBe('2026-06-11 12:34:56')
        // TIMESTAMPTZ (1184) keeps the default parser, which is not identity.
        expect(types.getTypeParser(1184)('2026-06-11 12:34:56+00')).not.toBe(
            '2026-06-11 12:34:56+00'
        )
    })

    it('sets the default statement_timeout as a startup option', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.pools[0].options.options).toBe('-c statement_timeout=60000')
    })

    it('uses queryTimeoutMs for statement_timeout', async () => {
        const driver = createPostgresDriver(target({ queryTimeoutMs: 1500 }))
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.pools[0].options.options).toBe('-c statement_timeout=1500')
    })

    it('adds the readonly default next to the timeout when readonly', async () => {
        const driver = createPostgresDriver(target({ readonly: true }))
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.pools[0].options.options).toBe(
            '-c default_transaction_read_only=on -c statement_timeout=60000'
        )
    })

    it('runs a writable query on one client: cursor, close, rollback, discard, release', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.log).toEqual([
            'connect',
            'cursor select 1',
            'read 11',
            'close',
            ...CLEANUP
        ])
    })

    it('wraps a readonly query in BEGIN READ ONLY before the same cleanup', async () => {
        const driver = createPostgresDriver(target({ readonly: true }))
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.log).toEqual([
            'connect',
            'BEGIN READ ONLY',
            'cursor select 1',
            'read 11',
            'close',
            ...CLEANUP
        ])
    })

    it('passes params and array row mode to the cursor', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select $1', params: [42], rowLimit: 10 })
        const cursor = pgState.state.cursors[0]
        expect(cursor.text).toBe('select $1')
        expect(cursor.values).toEqual([42])
        expect(cursor.config).toEqual({ rowMode: 'array' })
    })

    it('maps columns and normalizes cells', async () => {
        pgState.state.cursor = {
            rows: [[1n, new Date('2026-01-01T00:00:00Z')]],
            fields: [{ name: 'id' }, { name: 'created' }],
            rowCount: 1
        }
        const driver = createPostgresDriver(target())
        const result = await driver.query({ sql: 'select * from t', rowLimit: 10 })
        expect(result).toEqual({
            columns: ['id', 'created'],
            rows: [['1', '2026-01-01T00:00:00.000Z']],
            rowCount: 1
        })
        expect(result.truncated).toBeUndefined()
    })

    it('reads rowLimit + 1 rows and reports a rowLimit truncation', async () => {
        pgState.state.cursor = {
            rows: [[1], [2], [3], [4]],
            fields: [{ name: 'n' }],
            rowCount: null
        }
        const driver = createPostgresDriver(target())
        const result = await driver.query({ sql: 'select n', rowLimit: 2 })
        expect(pgState.state.log).toContain('read 3')
        expect(result.rows).toEqual([[1], [2]])
        expect(result.rowCount).toBe(2)
        expect(result.truncated).toEqual({ reason: 'rowLimit', limit: 2 })
    })

    it('does not truncate when exactly rowLimit rows exist', async () => {
        pgState.state.cursor = { rows: [[1], [2]], fields: [{ name: 'n' }], rowCount: 2 }
        const driver = createPostgresDriver(target())
        const result = await driver.query({ sql: 'select n', rowLimit: 2 })
        expect(result.rows).toEqual([[1], [2]])
        expect(result.truncated).toBeUndefined()
    })

    it('reports affected rows for commands without columns', async () => {
        pgState.state.cursor = { rows: [], fields: [], rowCount: 3 }
        const driver = createPostgresDriver(target())
        const result = await driver.query({ sql: 'update t set a = 1', rowLimit: 10 })
        expect(result).toEqual({ columns: [], rows: [], rowCount: 3 })
    })

    it('reports 0 rows for DDL (null command count)', async () => {
        pgState.state.cursor = { rows: [], fields: [], rowCount: null }
        const driver = createPostgresDriver(target())
        const result = await driver.query({ sql: 'create table x (a int)', rowLimit: 10 })
        expect(result.rowCount).toBe(0)
    })

    it('cleans up and reuses the client after a failed statement', async () => {
        pgState.state.cursor = {
            rows: [],
            fields: [],
            rowCount: null,
            error: new Error('cannot insert multiple commands into a prepared statement')
        }
        const driver = createPostgresDriver(target())
        await expect(driver.query({ sql: 'select 1; select 2', rowLimit: 10 })).rejects.toThrow(
            /multiple commands/
        )
        // The errored portal is already gone, so no close; cleanup still runs.
        expect(pgState.state.log).toEqual([
            'connect',
            'cursor select 1; select 2',
            'read 11',
            ...CLEANUP
        ])
    })

    it('destroys the client when cleanup fails, still returning the result', async () => {
        pgState.state.failing.add('DISCARD ALL')
        pgState.state.cursor = { rows: [[1]], fields: [{ name: 'n' }], rowCount: 1 }
        const driver = createPostgresDriver(target())
        const result = await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(result.rows).toEqual([[1]])
        expect(pgState.state.log.slice(-3)).toEqual(['ROLLBACK', 'DISCARD ALL', 'destroy'])
    })

    it('destroys the client when ROLLBACK fails and skips DISCARD ALL', async () => {
        pgState.state.failing.add('ROLLBACK')
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(pgState.state.log.slice(-2)).toEqual(['ROLLBACK', 'destroy'])
    })

    it('destroys the client when BEGIN READ ONLY fails, even if cleanup would work', async () => {
        pgState.state.failing.add('BEGIN READ ONLY')
        const driver = createPostgresDriver(target({ readonly: true }))
        await expect(driver.query({ sql: 'select 1', rowLimit: 10 })).rejects.toThrow(
            /BEGIN READ ONLY failed/
        )
        // A client that fails setup is never reset and reused, only destroyed.
        expect(pgState.state.log).toEqual(['connect', 'BEGIN READ ONLY', 'destroy'])
        expect(pgState.state.clientListeners).toHaveLength(0)
    })

    it('handles client errors while checked out and detaches the handler after', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        const lost = new Error('Connection terminated unexpectedly')
        pgState.state.cursor = {
            rows: [],
            fields: [],
            rowCount: null,
            error: lost,
            clientError: lost
        }
        pgState.state.failing.add('ROLLBACK')
        const driver = createPostgresDriver(target())
        await expect(driver.query({ sql: 'select pg_sleep(10)', rowLimit: 1 })).rejects.toThrow(
            /Connection terminated/
        )
        expect(logged).toHaveBeenCalledWith(
            'dbmole: postgres connection error: Connection terminated unexpectedly'
        )
        expect(pgState.state.log.slice(-2)).toEqual(['ROLLBACK', 'destroy'])
        expect(pgState.state.clientListeners).toHaveLength(0)
        logged.mockRestore()
    })

    it('fails COPY TO STDOUT after it completes, leaving the client clean', async () => {
        pgState.state.cursor = { rows: [], fields: [], rowCount: 3, copy: 'out' }
        const driver = createPostgresDriver(target())
        await expect(driver.query({ sql: 'copy t to stdout', rowLimit: 10 })).rejects.toThrow(
            'COPY TO STDOUT is not supported; use SELECT'
        )
        expect(pgState.state.log).toEqual([
            'connect',
            'cursor copy t to stdout',
            'read 11',
            'close',
            ...CLEANUP
        ])
    })

    it('refuses COPY FROM STDIN with CopyFail, leaving the client clean', async () => {
        pgState.state.cursor = { rows: [], fields: [], rowCount: null, copy: 'in' }
        const driver = createPostgresDriver(target())
        await expect(driver.query({ sql: 'copy t from stdin', rowLimit: 10 })).rejects.toThrow(
            /COPY from stdin failed/
        )
        expect(pgState.state.log).toEqual([
            'connect',
            'cursor copy t from stdin',
            'read 11',
            'copyFail not supported; use INSERT',
            ...CLEANUP
        ])
    })

    it.each([
        'end',
        'error'
    ] as const)('rejects and destroys when the client emits %s during close', async (drop) => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        pgState.state.cursor = {
            rows: [[1]],
            fields: [{ name: 'n' }],
            rowCount: 1,
            dropOnClose: drop
        }
        // A dead client fails every later query, so cleanup ends in destroy.
        pgState.state.failing.add('ROLLBACK')
        const driver = createPostgresDriver(target())
        await expect(driver.query({ sql: 'select 1', rowLimit: 10 })).rejects.toThrow(
            drop === 'end' ? 'Connection terminated' : 'read ECONNRESET'
        )
        expect(pgState.state.log.slice(-3)).toEqual(['close', 'ROLLBACK', 'destroy'])
        expect(pgState.state.clientListeners).toHaveLength(0)
        logged.mockRestore()
    })

    it('registers a pool error listener', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 1 })
        expect(pgState.state.pools[0].errorHandlers).toHaveLength(1)
    })

    it('runs schema helpers through the same checkout and cleanup', async () => {
        const driver = createPostgresDriver(target({ readonly: true }))
        await driver.listTables({})
        expect(pgState.state.log).toEqual(['connect', 'BEGIN READ ONLY', 'query', ...CLEANUP])
        expect(pgState.state.configs[0]).toMatchObject({ values: [null], rowMode: 'array' })
    })

    it('describeTable groups composite fks and multi-column indexes', async () => {
        pgState.state.results.push(
            // columns
            {
                rows: [
                    ['id', 'integer', 'NO', null],
                    ['name', 'text', 'YES', null]
                ]
            },
            // primary key
            { rows: [['id']] },
            // indexes: one index 'idx_ab' with two key columns
            {
                rows: [
                    ['idx_ab', false, 'a'],
                    ['idx_ab', false, 'b']
                ]
            },
            // foreign keys: one composite fk 'fk1' with two column pairs
            {
                rows: [
                    ['fk1', 'a', 'other', 'x'],
                    ['fk1', 'b', 'other', 'y']
                ]
            }
        )
        const driver = createPostgresDriver(target())
        const description = await driver.describeTable({ table: 't' })
        expect(description.primaryKey).toEqual(['id'])
        expect(description.indexes).toEqual([
            { name: 'idx_ab', unique: false, columns: ['a', 'b'] }
        ])
        expect(description.foreignKeys).toEqual([
            {
                name: 'fk1',
                columns: ['a', 'b'],
                referencedTable: 'other',
                referencedColumns: ['x', 'y']
            }
        ])
    })

    it('describeTable falls back to pg_catalog columns (materialized views)', async () => {
        pgState.state.results.push(
            // information_schema.columns omits materialized views
            { rows: [] },
            { rows: [['n', 'bigint', 'YES', null]] }
        )
        const driver = createPostgresDriver(target())
        const description = await driver.describeTable({ table: 'user_count' })
        expect(description.columns).toEqual([
            { name: 'n', type: 'bigint', nullable: true, default: null }
        ])
        expect(pgState.state.configs[1]).toMatchObject({
            text: expect.stringContaining('pg_attribute'),
            values: ['public', 'user_count']
        })
    })

    it('describeTable queries the split name of a qualified table', async () => {
        pgState.state.results.push({ rows: [['id', 'integer', 'NO', null]] })
        const driver = createPostgresDriver(target())
        await driver.describeTable({ table: '"app"."users"' })
        expect(pgState.state.configs).toEqual(
            Array(4).fill(expect.objectContaining({ values: ['app', 'users'] }))
        )
    })

    it('describeTable rejects a conflicting qualifier before any query', async () => {
        const driver = createPostgresDriver(target())
        await expect(driver.describeTable({ table: 'app.users', schema: 'other' })).rejects.toThrow(
            "table qualifier 'app' conflicts with schema 'other'"
        )
        expect(pgState.state.log).toEqual([])
    })

    it('describeTable throws when the table has no columns', async () => {
        const driver = createPostgresDriver(target())
        await expect(driver.describeTable({ table: 'missing' })).rejects.toThrow(/not found/)
    })

    it('lists databases against the maintenance db and maps sizes', async () => {
        pgState.state.results.push({
            rows: [
                ['app', 1024],
                ['postgres', 2048]
            ]
        })
        const driver = createPostgresDriver(target({ database: undefined }))
        const databases = await driver.listDatabases()
        expect(databases).toEqual([
            { name: 'app', sizeBytes: 1024 },
            { name: 'postgres', sizeBytes: 2048 }
        ])
        expect(pgState.state.pools[0].options.database).toBe('postgres')
        expect(pgState.state.log.slice(-3)).toEqual(CLEANUP)
    })

    it('maps relkind to a table/view type and reltuples=-1 to null in listTables', async () => {
        pgState.state.results.push({
            rows: [
                ['public', 'fresh', '-1', 'r'],
                ['public', 'analyzed', '42', 'p'],
                ['public', 'names', '-1', 'v'],
                ['public', 'old_names', '0', 'v'],
                ['public', 'counts', '3', 'm']
            ]
        })
        const driver = createPostgresDriver(target())
        const tables = await driver.listTables({})
        expect(tables).toEqual([
            { schema: 'public', name: 'fresh', type: 'table', rowEstimate: null },
            { schema: 'public', name: 'analyzed', type: 'table', rowEstimate: 42 },
            { schema: 'public', name: 'names', type: 'view', rowEstimate: null },
            { schema: 'public', name: 'old_names', type: 'view', rowEstimate: null },
            { schema: 'public', name: 'counts', type: 'view', rowEstimate: 3 }
        ])
    })

    it('serverVersion returns the reported version', async () => {
        pgState.state.results.push({ rows: [['17.2']] })
        const driver = createPostgresDriver(target())
        expect(await driver.serverVersion()).toBe('17.2')
    })

    it('dispose ends every pool', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 1 })
        await driver.query({ sql: 'select 1', database: 'other', rowLimit: 1 })
        await driver.dispose()
        expect(pgState.state.pools.every((pool) => pool.ended)).toBe(true)
    })

    it('rejects queries after dispose with BackendDisposedError', async () => {
        const driver = createPostgresDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 1 })
        await driver.dispose()
        await expect(driver.query({ sql: 'select 1', rowLimit: 1 })).rejects.toBeInstanceOf(
            BackendDisposedError
        )
    })

    it('dispose racing a query creates no new pool into the cleared map', async () => {
        const driver = createPostgresDriver(target())
        // Mark disposed first, then a late query must not allocate a fresh pool.
        const disposing = driver.dispose()
        const racing = driver.query({ sql: 'select 1', database: 'late', rowLimit: 1 })
        await disposing
        await expect(racing).rejects.toBeInstanceOf(BackendDisposedError)
        // No pool was ever created for 'late'.
        expect(pgState.state.pools).toHaveLength(0)
    })

    it('passes TLS options that verify against the real server name', async () => {
        const driver = createPostgresDriver({
            config: config({ ssl: { rejectUnauthorized: false } }),
            host: '127.0.0.1',
            port: 15432,
            serverName: 'db.example'
        })
        await driver.serverVersion().catch(() => {})
        expect(pgState.state.pools[0].options.ssl).toMatchObject({
            rejectUnauthorized: false,
            servername: 'db.example'
        })
    })

    it('connects without TLS by default', async () => {
        const driver = createPostgresDriver(target())
        await driver.serverVersion().catch(() => {})
        expect(pgState.state.pools[0].options.ssl).toBeUndefined()
    })
})
