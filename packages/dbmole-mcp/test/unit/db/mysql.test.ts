import { createServer, Socket } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SetScript = {
    // Row set when present; otherwise an OK packet carrying `header`.
    fields?: string[]
    rows?: unknown[][]
    header?: { affectedRows: number; insertId: number }
}
type QueryScript = {
    sets?: SetScript[]
    // Query-level error (SQL error or PROTOCOL_SEQUENCE_TIMEOUT).
    error?: Error
    // Connection dies: mysql2 emits 'error' on the connection, not the query.
    lost?: Error
}

const mysqlState = await vi.hoisted(async () => {
    const { EventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')

    type State = {
        pools: FakePool[]
        connections: FakeConnection[]
        // Ordered trace: 'checkout', each SQL string, 'release' / 'destroy'.
        log: string[]
        // Options passed to conn.query, in order.
        queries: Array<Record<string, unknown>>
        // Scripts by exact SQL; other non-setup statements consume `queue`.
        scripts: Map<string, QueryScript>
        queue: QueryScript[]
        checkoutError?: Error
        // Options of the short-lived connections (KILL QUERY and hint lookups),
        // the options of their queries, and what those queries answer.
        killers: Array<Record<string, unknown>>
        killerQueries: Array<Record<string, unknown>>
        killError?: Error
        oneOffRows: unknown[][]
        // Every one-off connection, and where it stalls (never answers).
        oneOffs: FakeKiller[]
        oneOffHang?: 'handshake' | 'query'
        // createConnection itself throws (synchronously) for the KILL connection.
        killThrows?: Error
        // How conn.reset (COM_RESET_CONNECTION) answers: ok by default.
        resetMode?: 'fail' | 'hang'
        nextThreadId: number
    }

    const state: State = {
        pools: [],
        connections: [],
        log: [],
        queries: [],
        scripts: new Map(),
        queue: [],
        killers: [],
        killerQueries: [],
        oneOffRows: [],
        oneOffs: [],
        nextThreadId: 1
    }

    const SETUP = /^(USE |SET SESSION TRANSACTION READ ONLY$)/

    // Like mysql2's Query: `timeout` arms `queryTimeout` at start, cleared only
    // when the query ends or errors, never by destroying the connection.
    class FakeQuery extends EventEmitter {
        queryTimeout?: ReturnType<typeof setTimeout>
    }

    const play = (conn: FakeConnection, query: FakeQuery, script: QueryScript) => {
        setImmediate(() => {
            if (script.lost) {
                conn.emit('error', script.lost)
                return
            }
            if (script.error) {
                clearTimeout(query.queryTimeout)
                query.emit('error', script.error)
                query.emit('end')
                return
            }
            const sets = script.sets ?? [{ header: { affectedRows: 0, insertId: 0 } }]
            sets.forEach((set, index) => {
                if (set.fields) {
                    query.emit(
                        'fields',
                        set.fields.map((name) => ({ name }))
                    )
                    for (const row of set.rows ?? []) {
                        query.emit('result', row, index)
                    }
                    return
                }
                query.emit('fields', undefined)
                query.emit('result', set.header ?? { affectedRows: 0, insertId: 0 })
            })
            clearTimeout(query.queryTimeout)
            query.emit('end')
        })
    }

    class FakeConnection extends EventEmitter {
        stream = new PassThrough()
        threadId = state.nextThreadId++

        query(options: Record<string, unknown>) {
            const sql = String(options.sql)
            state.log.push(sql)
            state.queries.push(options)
            const script =
                state.scripts.get(sql) ?? (SETUP.test(sql) ? {} : state.queue.shift()) ?? {}
            const query = new FakeQuery()
            if (typeof options.timeout === 'number') {
                query.queryTimeout = setTimeout(() => {
                    query.emit('error', new Error('Query inactivity timeout'))
                }, options.timeout)
            }
            play(this, query, script)
            return query
        }

        reset(cb: (error: Error | null) => void) {
            state.log.push('reset')
            if (state.resetMode === 'hang') {
                return
            }
            const error = state.resetMode === 'fail' ? new Error('reset failed') : null
            setImmediate(() => cb(error))
        }

        release() {
            state.log.push('release')
        }

        destroy() {
            state.log.push('destroy')
        }
    }

    // Every short-lived mysql.createConnection: KILL QUERY on timeout and the
    // hint lookups. A real Duplex as `stream` makes the socket destroy observable.
    // `oneOffHang`: 'handshake' never connects, 'query' connects but never answers.
    class FakeKiller extends EventEmitter {
        stream = new PassThrough()

        constructor(options: Record<string, unknown>) {
            super()
            state.killers.push(options)
            state.oneOffs.push(this)
            if (state.oneOffHang !== 'handshake') {
                setImmediate(() => this.emit('connect'))
            }
        }

        query(
            options: Record<string, unknown>,
            cb: (error: Error | null, rows?: unknown[][]) => void
        ) {
            state.log.push('killer ' + String(options.sql))
            state.killerQueries.push(options)
            if (state.oneOffHang) {
                return
            }
            setImmediate(() => cb(state.killError ?? null, state.oneOffRows))
        }

        destroy() {
            state.log.push('killer destroy')
        }
    }

    class FakePool {
        options: Record<string, unknown>
        ended = false

        constructor(options: Record<string, unknown>) {
            this.options = options
            state.pools.push(this)
        }

        getConnection(cb: (error: Error | null, conn?: FakeConnection) => void) {
            setImmediate(() => {
                if (state.checkoutError) {
                    cb(state.checkoutError)
                    return
                }
                state.log.push('checkout')
                const conn = new FakeConnection()
                state.connections.push(conn)
                cb(null, conn)
            })
        }

        end(cb: () => void) {
            this.ended = true
            cb()
        }
    }

    return { state, FakePool, FakeKiller }
})

vi.mock('mysql2', async () => {
    // Real identifier escaping; only the pool is faked.
    const actual = await vi.importActual<{ default: { escapeId: (value: string) => string } }>(
        'mysql2'
    )
    return {
        default: {
            escapeId: actual.default.escapeId,
            createPool: (options: Record<string, unknown>) => new mysqlState.FakePool(options),
            createConnection: (options: Record<string, unknown>) => {
                if (mysqlState.state.killThrows) {
                    throw mysqlState.state.killThrows
                }
                return new mysqlState.FakeKiller(options)
            }
        }
    }
})

import { BackendDisposedError } from '@dbmole/core'
import type { DriverTarget } from '../../../src/db/driver.js'
import { createMysqlDriver } from '../../../src/db/mysql.js'
import { HINT_TIMEOUT_MS } from '../../../src/db/mysqlHints.js'
import type { ConnectionConfig } from '../../../src/schema.js'

const config = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    name: 'my',
    type: 'mysql',
    host: 'real-host',
    user: 'root',
    password: 'pw',
    database: 'main',
    readonly: false,
    ...extra
})

const target = (extra: Partial<ConnectionConfig> = {}): DriverTarget => ({
    config: config(extra),
    host: '127.0.0.1',
    port: 13306,
    serverName: 'real-host'
})

const withCode = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code })

describe('createMysqlDriver', () => {
    beforeEach(() => {
        const { state } = mysqlState
        state.pools.length = 0
        state.connections.length = 0
        state.log.length = 0
        state.queries.length = 0
        state.scripts.clear()
        state.queue.length = 0
        state.checkoutError = undefined
        state.killers.length = 0
        state.killerQueries.length = 0
        state.oneOffRows = []
        state.oneOffs.length = 0
        state.oneOffHang = undefined
        state.killError = undefined
        state.killThrows = undefined
        state.resetMode = undefined
        state.nextThreadId = 1
    })

    it('creates pools with keepalive and no multi-statements', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(mysqlState.state.pools[0].options).toMatchObject({
            host: 'real-host',
            port: 13306,
            database: 'main',
            connectionLimit: 4,
            maxIdle: 1,
            connectTimeout: 10_000,
            enableKeepAlive: true,
            multipleStatements: false,
            supportBigNumbers: true,
            bigNumberStrings: true
        })
    })

    it('honors the poolSize option', async () => {
        const driver = createMysqlDriver(target(), { poolSize: 1 })
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(mysqlState.state.pools[0].options.connectionLimit).toBe(1)
    })

    it('returns DATE, DATETIME and TIMESTAMP as strings', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(mysqlState.state.pools[0].options.dateStrings).toEqual([
            'DATE',
            'DATETIME',
            'TIMESTAMP'
        ])
    })

    it('reuses pools per database', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        await driver.query({ sql: 'select 2', rowLimit: 10 })
        await driver.query({ sql: 'select 3', database: 'other', rowLimit: 10 })
        expect(mysqlState.state.pools).toHaveLength(2)
        expect(mysqlState.state.pools[1].options.database).toBe('other')
    })

    it('re-selects the database on every checkout and releases after', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        await driver.query({ sql: 'select 2', database: 'other', rowLimit: 10 })
        expect(mysqlState.state.log).toEqual([
            'checkout',
            'USE `main`',
            'select 1',
            'reset',
            'release',
            'checkout',
            'USE `other`',
            'select 2',
            'reset',
            'release'
        ])
        // The driver resets with a bounded wait, not via the pool.
        expect(mysqlState.state.pools[0].options.resetOnRelease).toBe(false)
    })

    it('destroys instead of releasing when the reset fails', async () => {
        mysqlState.state.resetMode = 'fail'
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(result.rowCount).toBe(0)
        expect(mysqlState.state.log.slice(-2)).toEqual(['reset', 'destroy'])
    })

    it('destroys the connection when the reset stalls past its bound', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            mysqlState.state.resetMode = 'hang'
            const driver = createMysqlDriver(target())
            const pending = driver.query({ sql: 'select 1', rowLimit: 10 })
            await vi.waitFor(() => {
                expect(mysqlState.state.log).toContain('reset')
            })
            expect(mysqlState.state.log).not.toContain('destroy')
            await vi.advanceTimersByTimeAsync(5_000)
            await pending
            expect(mysqlState.state.log.slice(-2)).toEqual(['reset', 'destroy'])
            expect(mysqlState.state.log).not.toContain('release')
        } finally {
            vi.useRealTimers()
        }
    })

    it('escapes the database identifier', async () => {
        const driver = createMysqlDriver(target({ database: 'we`ird' }))
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(mysqlState.state.log[1]).toBe('USE `we``ird`')
    })

    it('applies SET SESSION TRANSACTION READ ONLY on every readonly checkout', async () => {
        const driver = createMysqlDriver(target({ readonly: true }))
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        await driver.query({ sql: 'select 2', rowLimit: 10 })
        const sets = mysqlState.state.log.filter(
            (entry) => entry === 'SET SESSION TRANSACTION READ ONLY'
        )
        expect(sets).toHaveLength(2)
        expect(mysqlState.state.log.slice(0, 4)).toEqual([
            'checkout',
            'USE `main`',
            'SET SESSION TRANSACTION READ ONLY',
            'select 1'
        ])
    })

    it('does not set readonly for writable connections', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(mysqlState.state.log).not.toContain('SET SESSION TRANSACTION READ ONLY')
    })

    it('destroys the connection when setup fails and never runs the statement', async () => {
        mysqlState.state.scripts.set('USE `main`', {
            error: withCode("Unknown database 'main'", 'ER_BAD_DB_ERROR')
        })
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'select 1', rowLimit: 10 })).rejects.toThrow(
            /Unknown database/
        )
        expect(mysqlState.state.log).toEqual(['checkout', 'USE `main`', 'destroy'])
        expect(mysqlState.state.connections[0].stream.destroyed).toBe(true)
    })

    it('propagates a checkout failure', async () => {
        mysqlState.state.checkoutError = withCode('connect ECONNREFUSED', 'ECONNREFUSED')
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'select 1', rowLimit: 10 })).rejects.toThrow(
            /ECONNREFUSED/
        )
    })

    it('passes values, array rows and the default timeout to the query', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select ?', params: [42], rowLimit: 10 })
        expect(mysqlState.state.queries[1]).toEqual({
            sql: 'select ?',
            values: [42],
            rowsAsArray: true,
            timeout: 60_000
        })
    })

    it('uses queryTimeoutMs as the query timeout', async () => {
        const driver = createMysqlDriver(target({ queryTimeoutMs: 1500 }))
        await driver.query({ sql: 'select 1', rowLimit: 10 })
        expect(mysqlState.state.queries[1].timeout).toBe(1500)
    })

    it('maps SELECT results with columns and normalized cells', async () => {
        mysqlState.state.scripts.set('select * from t', {
            sets: [{ fields: ['id', 'label'], rows: [[1n, 'x']] }]
        })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'select * from t', rowLimit: 10 })
        expect(result).toEqual({ columns: ['id', 'label'], rows: [['1', 'x']], rowCount: 1 })
        expect(result.truncated).toBeUndefined()
    })

    it('stops at rowLimit + 1 rows and destroys the connection', async () => {
        mysqlState.state.scripts.set('select n', {
            sets: [{ fields: ['n'], rows: [[1], [2], [3], [4], [5]] }]
        })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'select n', rowLimit: 2 })
        expect(result.rows).toEqual([[1], [2]])
        expect(result.rowCount).toBe(2)
        expect(result.truncated).toEqual({ reason: 'rowLimit', limit: 2 })
        expect(mysqlState.state.log.slice(-1)).toEqual(['destroy'])
        expect(mysqlState.state.log).not.toContain('release')
        expect(mysqlState.state.connections[0].stream.destroyed).toBe(true)
    })

    it('clears the query timer after an early stop or a lost connection', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            mysqlState.state.scripts.set('select n', {
                sets: [{ fields: ['n'], rows: [[1], [2], [3]] }]
            })
            mysqlState.state.scripts.set('select lost', {
                lost: withCode('Connection lost', 'PROTOCOL_CONNECTION_LOST')
            })
            const driver = createMysqlDriver(target())
            await driver.query({ sql: 'select n', rowLimit: 1 })
            // An armed timer would hold the query, its rows and the connection.
            expect(vi.getTimerCount()).toBe(0)
            await expect(driver.query({ sql: 'select lost', rowLimit: 1 })).rejects.toThrow(
                /Connection lost/
            )
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    it('releases when exactly rowLimit rows exist', async () => {
        mysqlState.state.scripts.set('select n', { sets: [{ fields: ['n'], rows: [[1], [2]] }] })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'select n', rowLimit: 2 })
        expect(result.truncated).toBeUndefined()
        expect(mysqlState.state.log.slice(-1)).toEqual(['release'])
    })

    it('maps DML results to rowCount and lastInsertId', async () => {
        mysqlState.state.scripts.set('insert into t values (1)', {
            sets: [{ header: { affectedRows: 3, insertId: 7 } }]
        })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'insert into t values (1)', rowLimit: 10 })
        expect(result).toEqual({ columns: [], rows: [], rowCount: 3, lastInsertId: '7' })
    })

    it('omits lastInsertId when zero', async () => {
        mysqlState.state.scripts.set('update t set a=1', {
            sets: [{ header: { affectedRows: 1, insertId: 0 } }]
        })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'update t set a=1', rowLimit: 10 })
        expect(result.lastInsertId).toBeUndefined()
        expect(result.rowCount).toBe(1)
    })

    it('CALL returns the first result set and skips the rest', async () => {
        mysqlState.state.scripts.set('CALL two()', {
            sets: [
                { fields: ['a'], rows: [['first']] },
                { fields: ['b'], rows: [['second']] },
                { header: { affectedRows: 0, insertId: 0 } }
            ]
        })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'CALL two()', rowLimit: 10 })
        expect(result).toEqual({ columns: ['a'], rows: [['first']], rowCount: 1 })
    })

    it('CALL keeps an empty first result set', async () => {
        mysqlState.state.scripts.set('CALL empty_first()', {
            sets: [
                { fields: ['v'], rows: [] },
                { fields: ['c'], rows: [['2']] },
                { header: { affectedRows: 0, insertId: 0 } }
            ]
        })
        const driver = createMysqlDriver(target())
        const result = await driver.query({ sql: 'CALL empty_first()', rowLimit: 10 })
        expect(result).toEqual({ columns: ['v'], rows: [], rowCount: 0 })
    })

    it('releases the connection after a SQL error', async () => {
        mysqlState.state.scripts.set('selec 1', {
            error: withCode('You have an error in your SQL syntax', 'ER_PARSE_ERROR')
        })
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'selec 1', rowLimit: 10 })).rejects.toThrow(/SQL syntax/)
        expect(mysqlState.state.log.slice(-1)).toEqual(['release'])
    })

    it('on timeout kills the query server-side, then destroys the connection', async () => {
        mysqlState.state.scripts.set('select sleep(5)', {
            error: withCode('Query inactivity timeout', 'PROTOCOL_SEQUENCE_TIMEOUT')
        })
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'select sleep(5)', rowLimit: 10 })).rejects.toThrow(
            /timeout/
        )
        expect(mysqlState.state.log.slice(-4)).toEqual([
            'select sleep(5)',
            'killer KILL QUERY 1',
            'killer destroy',
            'destroy'
        ])
        expect(mysqlState.state.killers[0]).toMatchObject({
            host: 'real-host',
            port: 13306,
            user: 'root',
            password: 'pw',
            connectTimeout: 5_000
        })
        expect(mysqlState.state.killers[0]).not.toHaveProperty('database')
        expect(mysqlState.state.connections[0].stream.destroyed).toBe(true)
        expect(mysqlState.state.oneOffs[0].stream.destroyed).toBe(true)
    })

    it('logs and swallows a failed KILL QUERY, still rejecting with the timeout', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        mysqlState.state.killError = withCode('Access denied', 'ER_KILL_DENIED_ERROR')
        mysqlState.state.scripts.set('select sleep(5)', {
            error: withCode('Query inactivity timeout', 'PROTOCOL_SEQUENCE_TIMEOUT')
        })
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'select sleep(5)', rowLimit: 10 })).rejects.toThrow(
            /Query inactivity timeout/
        )
        expect(logged).toHaveBeenCalledWith('dbmole: mysql KILL QUERY 1 failed: Access denied')
        expect(mysqlState.state.log.slice(-2)).toEqual(['killer destroy', 'destroy'])
        logged.mockRestore()
    })

    it('still rejects and destroys on timeout when the KILL connection throws', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        mysqlState.state.killThrows = new Error('bad options')
        mysqlState.state.scripts.set('select sleep(5)', {
            error: withCode('Query inactivity timeout', 'PROTOCOL_SEQUENCE_TIMEOUT')
        })
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'select sleep(5)', rowLimit: 10 })).rejects.toThrow(
            /Query inactivity timeout/
        )
        expect(logged).toHaveBeenCalledWith('dbmole: mysql KILL QUERY 1 failed: bad options')
        expect(mysqlState.state.log.slice(-1)).toEqual(['destroy'])
        expect(mysqlState.state.connections[0].stream.destroyed).toBe(true)
        logged.mockRestore()
    })

    it('rejects and destroys when the connection is lost mid-query', async () => {
        mysqlState.state.scripts.set('select sleep(5)', {
            lost: withCode(
                'Connection lost: The server closed the connection.',
                'PROTOCOL_CONNECTION_LOST'
            )
        })
        const driver = createMysqlDriver(target())
        await expect(driver.query({ sql: 'select sleep(5)', rowLimit: 10 })).rejects.toThrow(
            /Connection lost/
        )
        expect(mysqlState.state.log.slice(-1)).toEqual(['destroy'])
        expect(mysqlState.state.connections[0].listenerCount('error')).toBe(0)
    })

    it('runs on the database-less pool when no database resolves, then destroys', async () => {
        const driver = createMysqlDriver(target({ database: undefined }))
        await driver.query({ sql: 'select 1 from performance_schema.global_status', rowLimit: 1 })
        expect(mysqlState.state.pools[0].options).not.toHaveProperty('database')
        expect(mysqlState.state.log).toEqual([
            'checkout',
            'select 1 from performance_schema.global_status',
            'destroy'
        ])
    })

    it('releases database-less helper connections', async () => {
        const driver = createMysqlDriver(target())
        await driver.listDatabases()
        expect(mysqlState.state.pools[0].options).not.toHaveProperty('database')
        expect(mysqlState.state.log[0]).toBe('checkout')
        expect(mysqlState.state.log.slice(-1)).toEqual(['release'])
    })

    it('listTables resolves schema > database > connection default', async () => {
        const driver = createMysqlDriver(target())
        await driver.listTables({})
        await driver.listTables({ database: 'db-param' })
        await driver.listTables({ schema: 'schema-param' })
        expect(mysqlState.state.queries.map((q) => q.values)).toEqual([
            ['main'],
            ['db-param'],
            ['schema-param']
        ])
    })

    it('listTables maps table_type to table/view and null table_rows to null', async () => {
        mysqlState.state.queue.push({
            sets: [
                {
                    fields: ['table_schema', 'table_name', 'table_rows', 'table_type'],
                    rows: [
                        ['main', 'users', 7, 'BASE TABLE'],
                        ['main', 'names', null, 'VIEW']
                    ]
                }
            ]
        })
        const driver = createMysqlDriver(target())
        expect(await driver.listTables({})).toEqual([
            { schema: 'main', name: 'users', type: 'table', rowEstimate: 7 },
            { schema: 'main', name: 'names', type: 'view', rowEstimate: null }
        ])
    })

    it('lists databases and maps sizes', async () => {
        mysqlState.state.queue.push({
            sets: [
                {
                    fields: ['schema_name', 'size'],
                    rows: [
                        ['app', 2048],
                        ['shop', null]
                    ]
                }
            ]
        })
        const driver = createMysqlDriver(target())
        const databases = await driver.listDatabases()
        expect(databases).toEqual([
            { name: 'app', sizeBytes: 2048 },
            { name: 'shop', sizeBytes: null }
        ])
    })

    it('describeTable groups pk, composite fks and multi-column indexes', async () => {
        mysqlState.state.queue.push(
            // columns
            {
                sets: [
                    {
                        fields: ['c'],
                        rows: [
                            ['id', 'int', 'NO', null],
                            ['name', 'varchar(20)', 'YES', null]
                        ]
                    }
                ]
            },
            // index statistics: PRIMARY plus a composite secondary index
            {
                sets: [
                    {
                        fields: ['c'],
                        rows: [
                            ['PRIMARY', 0, 'id'],
                            ['idx_ab', 1, 'a'],
                            ['idx_ab', 1, 'b']
                        ]
                    }
                ]
            },
            // foreign keys: one composite fk with two column pairs
            {
                sets: [
                    {
                        fields: ['c'],
                        rows: [
                            ['fk1', 'a', 'other', 'x'],
                            ['fk1', 'b', 'other', 'y']
                        ]
                    }
                ]
            }
        )
        const driver = createMysqlDriver(target())
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
        expect(description.columns).toEqual([
            { name: 'id', type: 'int', nullable: false, default: null },
            { name: 'name', type: 'varchar(20)', nullable: true, default: null }
        ])
    })

    it('describeTable queries the split name of a qualified table', async () => {
        mysqlState.state.queue.push({
            sets: [{ fields: ['c'], rows: [['id', 'int', 'NO', null]] }]
        })
        const driver = createMysqlDriver(target())
        await driver.describeTable({ table: '`shop`.`orders`' })
        expect(mysqlState.state.queries.map((q) => q.values)).toEqual([
            ['shop', 'orders'],
            ['shop', 'orders'],
            ['shop', 'orders']
        ])
    })

    it('describeTable rejects a conflicting qualifier before any query', async () => {
        const driver = createMysqlDriver(target())
        await expect(
            driver.describeTable({ table: 'shop.orders', database: 'crm' })
        ).rejects.toThrow("table qualifier 'shop' conflicts with database 'crm'")
        expect(mysqlState.state.log).toEqual([])
    })

    it('describeTable throws when the table has no columns', async () => {
        mysqlState.state.queue.push({ sets: [{ fields: ['c'], rows: [] }] })
        const driver = createMysqlDriver(target())
        await expect(driver.describeTable({ table: 'missing' })).rejects.toThrow(/not found/)
    })

    it('serverVersion returns the reported version', async () => {
        mysqlState.state.queue.push({ sets: [{ fields: ['VERSION()'], rows: [['8.4.3']] }] })
        const driver = createMysqlDriver(target())
        expect(await driver.serverVersion()).toBe('8.4.3')
    })

    it('dispose ends all pools', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 1 })
        await driver.listDatabases()
        await driver.dispose()
        expect(mysqlState.state.pools).toHaveLength(2)
        expect(mysqlState.state.pools.every((pool) => pool.ended)).toBe(true)
    })

    it('rejects queries after dispose with BackendDisposedError', async () => {
        const driver = createMysqlDriver(target())
        await driver.query({ sql: 'select 1', rowLimit: 1 })
        await driver.dispose()
        await expect(driver.query({ sql: 'select 1', rowLimit: 1 })).rejects.toBeInstanceOf(
            BackendDisposedError
        )
    })

    it('dispose racing a query creates no new pool into the cleared map', async () => {
        const driver = createMysqlDriver(target())
        const disposing = driver.dispose()
        const racing = driver.query({ sql: 'select 1', database: 'late', rowLimit: 1 })
        await disposing
        await expect(racing).rejects.toBeInstanceOf(BackendDisposedError)
        expect(mysqlState.state.pools).toHaveLength(0)
    })

    it('looks up hints on a one-off connection, never on the pool', async () => {
        mysqlState.state.scripts.set('SELECT nme FROM users', {
            error: Object.assign(new Error("Unknown column 'nme' in 'field list'"), {
                errno: 1054,
                code: 'ER_BAD_FIELD_ERROR'
            })
        })
        mysqlState.state.oneOffRows = [
            ['main', 'users', 'id'],
            ['main', 'users', 'name']
        ]
        const driver = createMysqlDriver(target())
        await expect(
            driver.query({ sql: 'SELECT nme FROM users', rowLimit: 10 })
        ).rejects.toMatchObject({
            code: 'ER_BAD_FIELD_ERROR',
            hint: 'columns of users: id, name'
        })
        expect(mysqlState.state.connections).toHaveLength(1)
        expect(mysqlState.state.log.filter((entry) => entry === 'checkout')).toHaveLength(1)
        expect(mysqlState.state.log.slice(-3)).toEqual([
            'release',
            expect.stringMatching(/^killer SELECT table_schema, table_name, column_name /),
            'killer destroy'
        ])
        expect(mysqlState.state.killers[0]).toMatchObject({
            port: 13306,
            user: 'root',
            password: 'pw',
            connectTimeout: HINT_TIMEOUT_MS
        })
        expect(mysqlState.state.killers[0]).not.toHaveProperty('database')
        expect(mysqlState.state.killerQueries[0]).toMatchObject({
            values: ['main', 'users'],
            rowsAsArray: true,
            timeout: HINT_TIMEOUT_MS
        })
        expect(mysqlState.state.oneOffs[0].stream.destroyed).toBe(true)
    })

    it.each([
        'handshake',
        'query'
    ] as const)('returns the original error when a hint lookup stalls in the %s', async (stall) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            mysqlState.state.scripts.set('SELECT x FROM t', {
                error: Object.assign(new Error("Unknown column 'x' in 'field list'"), {
                    errno: 1054,
                    code: 'ER_BAD_FIELD_ERROR'
                })
            })
            mysqlState.state.oneOffHang = stall
            const driver = createMysqlDriver(target())
            const failed = driver
                .query({ sql: 'SELECT x FROM t', rowLimit: 10 })
                .catch((error: unknown) => error)
            await vi.waitFor(() => {
                expect(mysqlState.state.killerQueries).toHaveLength(1)
            })
            expect(mysqlState.state.oneOffs[0].stream.destroyed).toBe(false)
            await vi.advanceTimersByTimeAsync(HINT_TIMEOUT_MS)
            const error = await failed
            expect(error).toMatchObject({ code: 'ER_BAD_FIELD_ERROR' })
            expect(error).not.toHaveProperty('hint')
            expect(mysqlState.state.log.slice(-1)).toEqual(['killer destroy'])
            expect(mysqlState.state.oneOffs[0].stream.destroyed).toBe(true)
            expect(mysqlState.state.connections).toHaveLength(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps the real host and dials the tunnel through a stream factory', async () => {
        const driver = createMysqlDriver({
            config: config({ ssl: true }),
            host: '127.0.0.1',
            port: 13306,
            serverName: 'real-host'
        })
        await driver.serverVersion().catch(() => {})
        const options = mysqlState.state.pools[0].options
        expect(options).toMatchObject({
            host: 'real-host',
            port: 13306,
            ssl: { rejectUnauthorized: true, verifyIdentity: true }
        })
        expect(typeof options.stream).toBe('function')
    })

    it('connects directly, without TLS, when there is no tunnel and no ssl', async () => {
        const driver = createMysqlDriver({
            config: config(),
            host: 'real-host',
            port: 3306,
            serverName: 'real-host'
        })
        await driver.serverVersion().catch(() => {})
        const options = mysqlState.state.pools[0].options
        expect(options.host).toBe('real-host')
        expect(options.stream).toBeUndefined()
        expect(options.ssl).toBeUndefined()
    })

    it('the stream factory dials the tunnel forward with nodelay and keepalive', async () => {
        const server = createServer()
        // mysql2 skips setNoDelay/setKeepAlive on a caller-supplied stream.
        const noDelay = vi.spyOn(Socket.prototype, 'setNoDelay')
        const keepAlive = vi.spyOn(Socket.prototype, 'setKeepAlive')
        let socket: unknown
        try {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            const accepted = new Promise<void>((resolve) => {
                server.once('connection', () => resolve())
            })
            const driver = createMysqlDriver({
                config: config(),
                host: '127.0.0.1',
                port,
                serverName: 'real-host'
            })
            await driver.serverVersion().catch(() => {})
            const stream = mysqlState.state.pools[0].options.stream
            expect(typeof stream).toBe('function')
            socket = typeof stream === 'function' ? stream() : undefined
            expect(socket).toBeInstanceOf(Socket)
            expect(noDelay).toHaveBeenCalledWith(true)
            expect(keepAlive).toHaveBeenCalledWith(true)
            await accepted
        } finally {
            noDelay.mockRestore()
            keepAlive.mockRestore()
            if (socket instanceof Socket) {
                socket.destroy()
            }
            await new Promise((resolve) => server.close(resolve))
        }
    })
})
