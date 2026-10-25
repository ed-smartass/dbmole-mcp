import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import Cursor from 'pg-cursor'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Driver } from '../../src/db/driver.js'
import { createPostgresDriver } from '../../src/db/postgres.js'
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
describe('postgres integration', () => {
    let container: StartedPostgreSqlContainer | undefined
    let dir: string | undefined
    let registry: DbRegistry
    let manager: DbManager | undefined

    beforeAll(async () => {
        container = await new PostgreSqlContainer('postgres:17-alpine').start()
        dir = mkdtempSync(join(tmpdir(), 'dbmole-int-pg-'))
        registry = createDbRegistry({
            cwd: dir,
            env: { DBMOLE_STORE: join(dir, 'connections.json') }
        })
        manager = createDbManager(registry)
        registry.add(
            {
                name: 'pg',
                type: 'postgres',
                host: container.getHost(),
                port: container.getPort(),
                user: container.getUsername(),
                password: container.getPassword(),
                database: container.getDatabase(),
                readonly: false
            },
            'global'
        )
        registry.add(
            {
                name: 'pg-ro',
                type: 'postgres',
                host: container.getHost(),
                port: container.getPort(),
                user: container.getUsername(),
                password: container.getPassword(),
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

    const pg = (): StartedPostgreSqlContainer => {
        if (!container) {
            throw new Error('setup failed: container not initialized')
        }
        return container
    }

    it('runs DDL, DML and SELECT with params', async () => {
        const { backend: driver } = await db().get('pg')
        await driver.query({
            sql: 'CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL)',
            rowLimit: 10
        })
        const insert = await driver.query({
            sql: "INSERT INTO users (name) VALUES ('ada'), ('bob')",
            rowLimit: 10
        })
        expect(insert.rowCount).toBe(2)
        const select = await driver.query({
            sql: 'SELECT name FROM users WHERE id = $1',
            params: [1],
            rowLimit: 10
        })
        expect(select.columns).toEqual(['name'])
        expect(select.rows).toEqual([['ada']])
    })

    it('returns DATE columns as the stored calendar day, no tz shift', async () => {
        const { backend: driver } = await db().get('pg')
        await driver.query({
            sql: 'CREATE TABLE events (id serial PRIMARY KEY, day date NOT NULL)',
            rowLimit: 10
        })
        await driver.query({
            sql: "INSERT INTO events (day) VALUES ('2026-06-11')",
            rowLimit: 10
        })
        const result = await driver.query({ sql: 'SELECT day FROM events', rowLimit: 10 })
        expect(result.rows).toEqual([['2026-06-11']])
    })

    it('returns TIMESTAMP without tz as a wall-clock string', async () => {
        const { backend: driver } = await db().get('pg')
        await driver.query({
            sql: 'CREATE TABLE moments (id serial PRIMARY KEY, at timestamp NOT NULL)',
            rowLimit: 10
        })
        await driver.query({
            sql: "INSERT INTO moments (at) VALUES ('2026-06-11 12:34:56')",
            rowLimit: 10
        })
        const result = await driver.query({ sql: 'SELECT at FROM moments', rowLimit: 10 })
        expect(result.rows[0][0]).toBe('2026-06-11 12:34:56')
    })

    it('truncates SELECT results at rowLimit', async () => {
        const { backend: driver } = await db().get('pg')
        const result = await driver.query({
            sql: 'SELECT generate_series(1, 10)',
            rowLimit: 3
        })
        expect(result.rows).toHaveLength(3)
        expect(result.truncated).toEqual({ reason: 'rowLimit', limit: 3 })
    })

    it('rejects multi-statement sql at the server', async () => {
        const { backend: driver } = await db().get('pg')
        await expect(driver.query({ sql: 'SELECT 1; SELECT 2', rowLimit: 10 })).rejects.toThrow(
            /cannot insert multiple commands into a prepared statement/
        )
    })

    it('lists databases, tables and describes a table', async () => {
        const { backend: driver } = await db().get('pg')
        const databases = await driver.listDatabases()
        expect(databases.map((d) => d.name)).toContain(pg().getDatabase())

        const tables = await driver.listTables({})
        expect(tables).toContainEqual(expect.objectContaining({ schema: 'public', name: 'users' }))

        await driver.query({
            sql: `CREATE TABLE orders (
                id serial PRIMARY KEY,
                user_id integer NOT NULL REFERENCES users(id),
                note text
            )`,
            rowLimit: 10
        })
        await driver.query({
            sql: 'CREATE INDEX orders_user_idx ON orders (user_id)',
            rowLimit: 10
        })

        const description = await driver.describeTable({ table: 'orders' })
        expect(description.primaryKey).toEqual(['id'])
        expect(description.columns.map((c) => c.name)).toEqual(['id', 'user_id', 'note'])
        expect(description.columns[1].nullable).toBe(false)
        expect(description.indexes).toContainEqual(
            expect.objectContaining({
                name: 'orders_user_idx',
                columns: ['user_id'],
                unique: false
            })
        )
        expect(description.foreignKeys).toContainEqual(
            expect.objectContaining({ columns: ['user_id'], referencedTable: 'users' })
        )
    })

    it('describes composite foreign keys with paired columns', async () => {
        const { backend: driver } = await db().get('pg')
        await driver.query({
            sql: `CREATE TABLE parents (
                a integer NOT NULL,
                b integer NOT NULL,
                PRIMARY KEY (a, b)
            )`,
            rowLimit: 10
        })
        await driver.query({
            sql: `CREATE TABLE children (
                id serial PRIMARY KEY,
                pa integer NOT NULL,
                pb integer NOT NULL,
                FOREIGN KEY (pa, pb) REFERENCES parents (a, b)
            )`,
            rowLimit: 10
        })
        const description = await driver.describeTable({ table: 'children' })
        expect(description.foreignKeys).toHaveLength(1)
        expect(description.foreignKeys[0].columns).toEqual(['pa', 'pb'])
        expect(description.foreignKeys[0].referencedTable).toBe('parents')
        expect(description.foreignKeys[0].referencedColumns).toEqual(['a', 'b'])
    })

    it('describe_table of a missing table fails clearly', async () => {
        const { backend: driver } = await db().get('pg')
        await expect(driver.describeTable({ table: 'ghost' })).rejects.toThrow(/not found/)
    })

    it('enforces readonly: INSERT and DDL fail, SELECT works', async () => {
        const { backend: driver } = await db().get('pg-ro')
        const select = await driver.query({ sql: 'SELECT count(*) FROM users', rowLimit: 10 })
        expect(select.rows[0][0]).toBe('2')
        await expect(
            driver.query({ sql: "INSERT INTO users (name) VALUES ('mallory')", rowLimit: 10 })
        ).rejects.toThrow(/read-only/)
        await expect(
            driver.query({ sql: 'CREATE TABLE hacked (id int)', rowLimit: 10 })
        ).rejects.toThrow(/read-only/)
    })

    it('reports server version', async () => {
        const { backend: driver } = await db().get('pg')
        expect(await driver.serverVersion()).toMatch(/^17\./)
    })

    // Pool size 1: every call reuses the same server session, so anything one
    // call leaves behind would be visible to the next.
    describe('session isolation on a single connection', () => {
        const drivers: Driver[] = []

        const single = (extra: Partial<ConnectionConfig> = {}): Driver => {
            const driver = createPostgresDriver(
                {
                    config: {
                        name: 'pg-single',
                        type: 'postgres',
                        host: pg().getHost(),
                        port: pg().getPort(),
                        user: pg().getUsername(),
                        password: pg().getPassword(),
                        database: pg().getDatabase(),
                        readonly: false,
                        ...extra
                    },
                    host: pg().getHost(),
                    port: pg().getPort(),
                    serverName: pg().getHost()
                },
                { poolSize: 1 }
            )
            drivers.push(driver)
            return driver
        }

        let rw: Driver
        let ro: Driver

        const count = async (value: string): Promise<string> => {
            const result = await rw.query({
                sql: 'SELECT count(*) FROM guard WHERE v = $1',
                params: [value],
                rowLimit: 1
            })
            return String(result.rows[0][0])
        }

        beforeAll(async () => {
            rw = single()
            ro = single({ readonly: true })
            await rw.query({ sql: 'CREATE TABLE guard (v text)', rowLimit: 1 })
        })

        afterAll(async () => {
            await Promise.all(drivers.map((driver) => driver.dispose()))
        })

        it('rejects a multi-statement string before running any of it', async () => {
            const sql = "SELECT 1 AS x$y$; INSERT INTO guard VALUES ('multi')"
            await expect(ro.query({ sql, rowLimit: 1 })).rejects.toThrow(
                /cannot insert multiple commands/
            )
            await expect(rw.query({ sql, rowLimit: 1 })).rejects.toThrow(
                /cannot insert multiple commands/
            )
            expect(await count('multi')).toBe('0')
        })

        it('readonly: set_config off does not carry into the next call', async () => {
            await ro.query({
                sql: "SELECT set_config('default_transaction_read_only', 'off', false)",
                rowLimit: 1
            })
            await expect(
                ro.query({ sql: "INSERT INTO guard VALUES ('set_config')", rowLimit: 1 })
            ).rejects.toThrow(/read-only transaction/)
            expect(await count('set_config')).toBe('0')
        })

        it('readonly: a DO block cannot COMMIT out of the read-only transaction', async () => {
            await expect(
                ro.query({
                    sql: "DO $$ BEGIN COMMIT; SET default_transaction_read_only = off; INSERT INTO guard VALUES ('do'); END $$",
                    rowLimit: 1
                })
            ).rejects.toThrow(/invalid transaction termination/)
            expect(await count('do')).toBe('0')
        })

        it('readonly: a DO block cannot SET LOCAL its way to read-write', async () => {
            await expect(
                ro.query({
                    sql: "DO $$ BEGIN SET LOCAL transaction_read_only = off; INSERT INTO guard VALUES ('set_local'); END $$",
                    rowLimit: 1
                })
            ).rejects.toThrow(/read-write mode/)
            expect(await count('set_local')).toBe('0')
        })

        it('readonly: CREATE TABLE and plain INSERT are rejected', async () => {
            await expect(
                ro.query({ sql: 'CREATE TABLE hacked (id int)', rowLimit: 1 })
            ).rejects.toThrow(/read-only transaction/)
            await expect(
                ro.query({ sql: "INSERT INTO guard VALUES ('plain')", rowLimit: 1 })
            ).rejects.toThrow(/read-only transaction/)
            expect(await count('plain')).toBe('0')
        })

        it('writable: SET search_path does not survive to the next call', async () => {
            await rw.query({ sql: 'CREATE SCHEMA other', rowLimit: 1 })
            await rw.query({ sql: 'SET search_path TO other', rowLimit: 1 })
            const result = await rw.query({ sql: 'SHOW search_path', rowLimit: 1 })
            expect(result.rows).toEqual([['"$user", public']])
        })

        it('writable: SET statement_timeout does not survive to the next call', async () => {
            await rw.query({ sql: 'SET statement_timeout = 0', rowLimit: 1 })
            const result = await rw.query({ sql: 'SHOW statement_timeout', rowLimit: 1 })
            // The startup default (DEFAULT_QUERY_TIMEOUT_MS = 60000) as Postgres prints it.
            expect(result.rows).toEqual([['1min']])
        })

        it('writable: a lone BEGIN is rolled back when its call ends', async () => {
            await rw.query({ sql: 'BEGIN', rowLimit: 1 })
            // Runs in autocommit, not inside the earlier BEGIN...
            await rw.query({ sql: "INSERT INTO guard VALUES ('begin')", rowLimit: 1 })
            // ...so this ROLLBACK has nothing to undo.
            await rw.query({ sql: 'ROLLBACK', rowLimit: 1 })
            expect(await count('begin')).toBe('1')
        })

        it('statement_timeout cancels a long query and the session stays usable', async () => {
            const slow = single({ queryTimeoutMs: 200 })
            const started = Date.now()
            await expect(slow.query({ sql: 'SELECT pg_sleep(5)', rowLimit: 1 })).rejects.toThrow(
                /statement timeout/
            )
            expect(Date.now() - started).toBeLessThan(3000)
            const after = await slow.query({ sql: 'SELECT 1 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([[1]])
        })

        it('stops reading at rowLimit + 1 on a huge result', async () => {
            const started = Date.now()
            const result = await rw.query({
                sql: 'SELECT generate_series(1, 10000000) AS n',
                rowLimit: 10
            })
            expect(Date.now() - started).toBeLessThan(5000)
            expect(result.rows).toHaveLength(10)
            expect(result.rowCount).toBe(10)
            expect(result.truncated).toEqual({ reason: 'rowLimit', limit: 10 })
        })

        it('fails, not hangs, when the connection drops during cursor close', async () => {
            const close = Cursor.prototype.close
            // pg-cursor waits for ReadyForQuery after Close+Sync; kill the socket first.
            const spy = vi.spyOn(Cursor.prototype, 'close').mockImplementationOnce(function (
                this: Cursor
            ) {
                const pending = close.call(this)
                const socket: unknown = Reflect.get(Reflect.get(this, 'connection'), 'stream')
                if (socket instanceof Duplex) {
                    socket.destroy()
                }
                return pending
            })
            try {
                await expect(
                    rw.query({ sql: 'SELECT generate_series(1, 100)', rowLimit: 5 })
                ).rejects.toThrow(/Connection terminated/)
            } finally {
                spy.mockRestore()
            }
            const after = await rw.query({ sql: 'SELECT 1 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([[1]])
        })

        it('survives the backend dying mid-call and reconnects on the next call', async () => {
            const { backend: admin } = await db().get('pg')
            // Attach the expectation first: the rejection can land while terminate runs.
            const sleeping = expect(
                rw.query({ sql: 'SELECT pg_sleep(10)', rowLimit: 1 })
            ).rejects.toThrow(/terminating connection/)
            // Wait (bounded, ~5 s) until the sleeping backend is visible.
            let pid: unknown
            for (let attempt = 0; attempt < 50 && pid === undefined; attempt++) {
                const found = await admin.query({
                    sql: "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query = 'SELECT pg_sleep(10)'",
                    rowLimit: 1
                })
                pid = found.rows[0]?.[0]
                if (pid === undefined) {
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            }
            expect(pid).toBeDefined()
            const terminated = await admin.query({
                sql: 'SELECT pg_terminate_backend($1)',
                params: [pid],
                rowLimit: 1
            })
            expect(terminated.rows).toEqual([[true]])
            await sleeping
            const after = await rw.query({ sql: 'SELECT 1 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([[1]])
        })

        it('fails COPY TO STDOUT / FROM STDIN as a call error, session stays usable', async () => {
            await expect(
                rw.query({ sql: 'COPY (SELECT generate_series(1, 1000)) TO STDOUT', rowLimit: 1 })
            ).rejects.toThrow(/COPY TO STDOUT is not supported/)
            await expect(rw.query({ sql: 'COPY guard FROM STDIN', rowLimit: 1 })).rejects.toThrow(
                /COPY from stdin failed: not supported/
            )
            const after = await rw.query({ sql: 'SELECT 1 AS ok', rowLimit: 1 })
            expect(after.rows).toEqual([[1]])
        })

        it('reports affected rows for DML', async () => {
            const result = await rw.query({
                sql: "UPDATE guard SET v = v WHERE v = 'begin'",
                rowLimit: 1
            })
            expect(result.columns).toEqual([])
            expect(result.rowCount).toBe(1)
        })
    })

    it('lists views with their type and describes schema-qualified tables', async () => {
        const { backend: driver } = await db().get('pg')
        await driver.query({
            sql: 'CREATE VIEW user_names AS SELECT name FROM users',
            rowLimit: 10
        })
        await driver.query({
            sql: 'CREATE MATERIALIZED VIEW user_count AS SELECT count(*) AS n FROM users',
            rowLimit: 10
        })
        const tables = await driver.listTables({ schema: 'public' })
        expect(tables).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'users', type: 'table' }),
                expect.objectContaining({ name: 'user_names', type: 'view' }),
                expect.objectContaining({ name: 'user_count', type: 'view' })
            ])
        )
        const description = await driver.describeTable({ table: 'public.users' })
        expect(description.columns.map((c) => c.name)).toEqual(['id', 'name'])
        const matview = await driver.describeTable({ table: 'user_count' })
        expect(matview.columns).toEqual([
            { name: 'n', type: 'bigint', nullable: true, default: null }
        ])
        await expect(
            driver.describeTable({ table: 'public.users', schema: 'other' })
        ).rejects.toThrow("table qualifier 'public' conflicts with schema 'other'")
    })

    it('returns date and timestamp arrays as wall-clock strings', async () => {
        const { backend: driver } = await db().get('pg')
        const result = await driver.query({
            sql:
                "SELECT ARRAY['2026-10-24'::date, NULL] AS days, " +
                "ARRAY['2026-10-24 00:30:00'::timestamp] AS ats",
            rowLimit: 10
        })
        expect(result.rows).toEqual([[['2026-10-24', null], ['2026-10-24 00:30:00']]])
    })
})
