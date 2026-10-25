import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Driver } from '../../src/db/driver.js'
import { createMysqlDriver } from '../../src/db/mysql.js'
import type { ConnectionConfig } from '../../src/schema.js'
import {
    createDbManager,
    createDbRegistry,
    type DbManager,
    type DbRegistry
} from '../../src/wiring.js'

// Ordering contract: vitest runs in-file `it` blocks sequentially in
// declaration order, and these tests share tables across blocks by design
// (e.g. `users` created early is read by later cases). Do not reorder.
describe('mysql integration', () => {
    let container: StartedMySqlContainer | undefined
    let dir: string | undefined
    let registry: DbRegistry
    let manager: DbManager | undefined

    beforeAll(async () => {
        container = await new MySqlContainer('mysql:8.4').start()
        dir = mkdtempSync(join(tmpdir(), 'dbmole-int-my-'))
        registry = createDbRegistry({
            cwd: dir,
            env: { DBMOLE_STORE: join(dir, 'connections.json') }
        })
        manager = createDbManager(registry)
        registry.add(
            {
                name: 'my',
                type: 'mysql',
                host: container.getHost(),
                port: container.getPort(),
                user: container.getUsername(),
                password: container.getUserPassword(),
                database: container.getDatabase(),
                readonly: false
            },
            'global'
        )
        registry.add(
            {
                name: 'my-ro',
                type: 'mysql',
                host: container.getHost(),
                port: container.getPort(),
                user: container.getUsername(),
                password: container.getUserPassword(),
                database: container.getDatabase(),
                readonly: true
            },
            'global'
        )
    })

    afterAll(async () => {
        await manager?.disposeAll().catch(() => {})
        await container?.stop().catch(() => {})
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    const db = (): DbManager => {
        if (!manager) {
            throw new Error('setup failed: manager not initialized')
        }
        return manager
    }

    const my = (): StartedMySqlContainer => {
        if (!container) {
            throw new Error('setup failed: container not initialized')
        }
        return container
    }

    it('runs DDL, DML with lastInsertId and SELECT with params', async () => {
        const { backend: driver } = await db().get('my')
        await driver.query({
            sql: 'CREATE TABLE users (id int AUTO_INCREMENT PRIMARY KEY, name varchar(64) NOT NULL)',
            rowLimit: 10
        })
        const insert = await driver.query({
            sql: "INSERT INTO users (name) VALUES ('ada'), ('bob')",
            rowLimit: 10
        })
        expect(insert.rowCount).toBe(2)
        expect(insert.lastInsertId).toBe('1')
        const select = await driver.query({
            sql: 'SELECT name FROM users WHERE id = ?',
            params: [2],
            rowLimit: 10
        })
        expect(select.columns).toEqual(['name'])
        expect(select.rows).toEqual([['bob']])
    })

    it('preserves BIGINT precision beyond 2^53', async () => {
        const { backend: driver } = await db().get('my')
        await driver.query({
            sql: 'CREATE TABLE big (v bigint)',
            rowLimit: 10
        })
        await driver.query({
            sql: 'INSERT INTO big (v) VALUES (9007199254740993)',
            rowLimit: 10
        })
        const result = await driver.query({ sql: 'SELECT v FROM big', rowLimit: 10 })
        expect(result.rows[0][0]).toBe('9007199254740993')
    })

    it('returns DATE and DATETIME as strings, no tz day-shift', async () => {
        const { backend: driver } = await db().get('my')
        await driver.query({
            sql: 'CREATE TABLE events (id int AUTO_INCREMENT PRIMARY KEY, day date, at datetime)',
            rowLimit: 10
        })
        await driver.query({
            sql: "INSERT INTO events (day, at) VALUES ('2026-06-11', '2026-06-11 12:34:56')",
            rowLimit: 10
        })
        const result = await driver.query({ sql: 'SELECT day, at FROM events', rowLimit: 10 })
        expect(result.rows[0][0]).toBe('2026-06-11')
        expect(result.rows[0][1]).toBe('2026-06-11 12:34:56')
    })

    it('rejects multi-statement sql at the server', async () => {
        const { backend: driver } = await db().get('my')
        await expect(driver.query({ sql: 'SELECT 1; SELECT 2', rowLimit: 10 })).rejects.toThrow(
            /SQL syntax/
        )
    })

    it('lists databases and tables, describes a table', async () => {
        const { backend: driver } = await db().get('my')
        const databases = await driver.listDatabases()
        expect(databases.map((d) => d.name)).toContain(my().getDatabase())

        await driver.query({
            sql: `CREATE TABLE orders (
                id int AUTO_INCREMENT PRIMARY KEY,
                user_id int NOT NULL,
                note text,
                KEY orders_user_idx (user_id),
                CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
            )`,
            rowLimit: 10
        })

        const tables = await driver.listTables({})
        expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['orders', 'users']))

        const description = await driver.describeTable({ table: 'orders' })
        expect(description.primaryKey).toEqual(['id'])
        expect(description.columns.map((c) => c.name)).toEqual(['id', 'user_id', 'note'])
        expect(description.indexes).toContainEqual(
            expect.objectContaining({ name: 'orders_user_idx', unique: false })
        )
        expect(description.foreignKeys).toContainEqual(
            expect.objectContaining({
                name: 'fk_orders_user',
                columns: ['user_id'],
                referencedTable: 'users'
            })
        )
    })

    it('describe_table of a missing table fails clearly', async () => {
        const { backend: driver } = await db().get('my')
        await expect(driver.describeTable({ table: 'ghost' })).rejects.toThrow(/not found/)
    })

    it('enforces readonly: INSERT and DDL fail, SELECT works', async () => {
        const { backend: driver } = await db().get('my-ro')
        const select = await driver.query({ sql: 'SELECT count(*) FROM users', rowLimit: 10 })
        expect(Number(select.rows[0][0])).toBe(2)
        await expect(
            driver.query({ sql: "INSERT INTO users (name) VALUES ('mallory')", rowLimit: 10 })
        ).rejects.toThrow(/READ ONLY/i)
        await expect(
            driver.query({ sql: 'CREATE TABLE hacked (id int)', rowLimit: 10 })
        ).rejects.toThrow(/READ ONLY/i)
    })

    it('reports server version', async () => {
        const { backend: driver } = await db().get('my')
        expect(await driver.serverVersion()).toMatch(/^8\./)
    })

    // Pool size 1: every call reuses the same server session (or, where the
    // driver destroys it, gets a fresh one), so leaks would show up here.
    describe('session isolation on a single connection', () => {
        const drivers: Driver[] = []

        const single = (extra: Partial<ConnectionConfig> = {}): Driver => {
            const driver = createMysqlDriver(
                {
                    config: {
                        name: 'my-single',
                        type: 'mysql',
                        host: my().getHost(),
                        port: my().getPort(),
                        user: my().getUsername(),
                        password: my().getUserPassword(),
                        database: my().getDatabase(),
                        readonly: false,
                        ...extra
                    },
                    host: my().getHost(),
                    port: my().getPort(),
                    serverName: my().getHost()
                },
                { poolSize: 1 }
            )
            drivers.push(driver)
            return driver
        }

        let rw: Driver
        let ro: Driver
        let root: Driver

        // Counts through the shared manager driver: a different pool, so a
        // fresh session that only sees committed rows.
        const committed = async (value: string): Promise<number> => {
            const { backend: fresh } = await db().get('my')
            const result = await fresh.query({
                sql: 'SELECT count(*) FROM guard WHERE v = ?',
                params: [value],
                rowLimit: 1
            })
            return Number(result.rows[0][0])
        }

        // Server-side statements whose text starts with `prefix`, polled for up
        // to 2 s until none remain: proves the server stopped, not just the client.
        const lingering = async (prefix: string): Promise<number> => {
            const { backend: admin } = await db().get('my')
            const running = async (): Promise<number> => {
                const result = await admin.query({
                    sql: 'SELECT COUNT(*) FROM information_schema.processlist WHERE info LIKE ?',
                    params: [prefix + '%'],
                    rowLimit: 1
                })
                return Number(result.rows[0][0])
            }
            const deadline = Date.now() + 2000
            while ((await running()) > 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
            return running()
        }

        beforeAll(async () => {
            rw = single()
            ro = single({ readonly: true })
            root = single({ user: 'root', password: my().getRootPassword() })
            await root.query({ sql: 'CREATE DATABASE other_db', rowLimit: 1 })
            await rw.query({ sql: 'CREATE TABLE guard (v varchar(32))', rowLimit: 1 })
        })

        afterAll(async () => {
            await Promise.all(drivers.map((driver) => driver.dispose()))
        })

        it('readonly: a /*! */ SET SESSION ... READ WRITE does not carry over', async () => {
            await ro.query({ sql: '/*! SET SESSION TRANSACTION READ WRITE */', rowLimit: 1 })
            await expect(
                ro.query({ sql: "INSERT INTO guard VALUES ('comment')", rowLimit: 1 })
            ).rejects.toThrow(/READ ONLY/)
            expect(await committed('comment')).toBe(0)
        })

        it('readonly: START TRANSACTION READ WRITE does not carry over', async () => {
            await ro.query({ sql: 'START TRANSACTION READ WRITE', rowLimit: 1 })
            await expect(
                ro.query({ sql: "INSERT INTO guard VALUES ('start')", rowLimit: 1 })
            ).rejects.toThrow(/READ ONLY/)
            expect(await committed('start')).toBe(0)
        })

        it('readonly: CREATE TABLE and plain INSERT are rejected', async () => {
            await expect(
                ro.query({ sql: 'CREATE TABLE hacked (id int)', rowLimit: 1 })
            ).rejects.toThrow(/READ ONLY/)
            await expect(
                ro.query({ sql: "INSERT INTO guard VALUES ('plain')", rowLimit: 1 })
            ).rejects.toThrow(/READ ONLY/)
            expect(await committed('plain')).toBe(0)
        })

        it('writable: USE other_db does not survive to the next call', async () => {
            await root.query({ sql: 'USE other_db', rowLimit: 1 })
            const result = await root.query({ sql: 'SELECT DATABASE()', rowLimit: 1 })
            expect(result.rows).toEqual([[my().getDatabase()]])
        })

        it('writable: SET autocommit = 0 does not swallow the next INSERT', async () => {
            await rw.query({ sql: 'SET autocommit = 0', rowLimit: 1 })
            await rw.query({ sql: "INSERT INTO guard VALUES ('autocommit')", rowLimit: 1 })
            expect(await committed('autocommit')).toBe(1)
        })

        it('database-less: USE does not survive to the next call', async () => {
            const free = single({ database: undefined })
            await free.query({ sql: 'USE ' + my().getDatabase(), rowLimit: 1 })
            const result = await free.query({ sql: 'SELECT DATABASE()', rowLimit: 1 })
            expect(result.rows).toEqual([[null]])
        })

        it('database-less: fully qualified queries run without a database', async () => {
            const free = single({ database: undefined })
            const result = await free.query({
                sql: "SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'",
                rowLimit: 1
            })
            expect(result.rows).toHaveLength(1)
        })

        it('CALL returns the first result set', async () => {
            await rw.query({
                sql: "CREATE PROCEDURE two_sets() BEGIN SELECT 'first' AS a; SELECT 'second' AS b; END",
                rowLimit: 1
            })
            const result = await rw.query({ sql: 'CALL two_sets()', rowLimit: 10 })
            expect(result.columns).toEqual(['a'])
            expect(result.rows).toEqual([['first']])
        })

        it('times out, kills the query server-side, and the next call works', async () => {
            const slow = single({ queryTimeoutMs: 300 })
            const started = Date.now()
            await expect(slow.query({ sql: 'SELECT SLEEP(30)', rowLimit: 1 })).rejects.toThrow(
                /timeout/i
            )
            expect(Date.now() - started).toBeLessThan(3000)
            // Without KILL QUERY the server would keep sleeping for 30 s.
            expect(await lingering('SELECT SLEEP(30)')).toBe(0)
            const after = await slow.query({ sql: 'SELECT 1 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([['1']])
        })

        it('stops reading at rowLimit + 1 on a huge result', async () => {
            const started = Date.now()
            const result = await rw.query({
                sql: 'WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 1000) SELECT a.n FROM s a, s b, s c',
                rowLimit: 10
            })
            expect(Date.now() - started).toBeLessThan(5000)
            expect(result.rows).toHaveLength(10)
            expect(result.truncated).toEqual({ reason: 'rowLimit', limit: 10 })
            // Without destroying the socket the server keeps producing the 10^9 rows.
            expect(await lingering('WITH RECURSIVE s(n)')).toBe(0)
            const after = await rw.query({ sql: 'SELECT 2 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([['2']])
        })

        it('rejects when the connection is killed mid-query and recovers', async () => {
            const { backend: admin } = await db().get('my')
            // Attach the expectation first: the rejection can land while KILL runs.
            const sleeping = expect(
                rw.query({ sql: 'SELECT SLEEP(10)', rowLimit: 1 })
            ).rejects.toThrow(/Connection lost/)
            await new Promise((resolve) => setTimeout(resolve, 300))
            const ids = await admin.query({
                sql: "SELECT id FROM information_schema.processlist WHERE info = 'SELECT SLEEP(10)'",
                rowLimit: 1
            })
            await admin.query({ sql: 'KILL ' + String(ids.rows[0][0]), rowLimit: 1 })
            await sleeping
            const after = await rw.query({ sql: 'SELECT 3 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([['3']])
        })

        it('returns TIMESTAMP as the wall-clock string', async () => {
            await rw.query({ sql: 'CREATE TABLE stamps (at timestamp NULL)', rowLimit: 1 })
            await rw.query({
                sql: "INSERT INTO stamps (at) VALUES ('2026-06-11 12:34:56')",
                rowLimit: 1
            })
            const result = await rw.query({ sql: 'SELECT at FROM stamps', rowLimit: 1 })
            expect(result.rows).toEqual([['2026-06-11 12:34:56']])
        })
    })

    it('hints the real columns on an unknown column', async () => {
        const { backend: driver } = await db().get('my')
        await expect(
            driver.query({ sql: 'SELECT nme FROM users', rowLimit: 10 })
        ).rejects.toMatchObject({
            code: 'ER_BAD_FIELD_ERROR',
            hint: 'columns of users: id, name'
        })
    })

    it('suggests similar tables on a misspelled table', async () => {
        const { backend: driver } = await db().get('my')
        await expect(
            driver.query({ sql: 'SELECT * FROM usr', rowLimit: 10 })
        ).rejects.toMatchObject({
            code: 'ER_NO_SUCH_TABLE',
            hint: 'similar tables in ' + my().getDatabase() + ': users'
        })
    })

    it('flags a reserved word used as an alias', async () => {
        const { backend: driver } = await db().get('my')
        await expect(
            driver.query({ sql: 'SELECT json_keys(x) keys FROM t', rowLimit: 10 })
        ).rejects.toMatchObject({
            code: 'ER_PARSE_ERROR',
            hint: "'keys' is a reserved word in MySQL; quote it with backticks if it is an identifier"
        })
    })

    it('lists views with their type and describes db-qualified tables', async () => {
        const { backend: driver } = await db().get('my')
        await driver.query({
            sql: 'CREATE VIEW user_names AS SELECT name FROM users',
            rowLimit: 10
        })
        const tables = await driver.listTables({})
        expect(tables).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'users', type: 'table' }),
                expect.objectContaining({ name: 'user_names', type: 'view', rowEstimate: null })
            ])
        )
        const qualified = my().getDatabase() + '.users'
        const description = await driver.describeTable({ table: qualified })
        expect(description.columns.map((c) => c.name)).toEqual(['id', 'name'])
        await expect(driver.describeTable({ table: qualified, database: 'other' })).rejects.toThrow(
            "table qualifier '" + my().getDatabase() + "' conflicts with database 'other'"
        )
    })
})
