import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../../src/schema.js'
import {
    createDbManager,
    createDbRegistry,
    type DbManager,
    type DbRegistry
} from '../../src/wiring.js'
import { makeCerts, mysqlCa, type TestCerts } from './certs.js'

const PG_SSL_SQL = 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
const MYSQL_SSL_SQL = "SHOW STATUS LIKE 'Ssl_version'"
// Node's message for a trusted certificate issued for another name.
const WRONG_HOST = /does not match certificate's altnames/

describe('tls integration', () => {
    let certs: TestCerts | undefined
    let pg: StartedPostgreSqlContainer | undefined
    let my: StartedMySqlContainer | undefined
    let myCa = ''
    let registry: DbRegistry
    let manager: DbManager | undefined

    beforeAll(async () => {
        // The server certificate is valid for 'db' only; tests dial localhost.
        certs = makeCerts('db')
        const [pgStarted, myStarted] = await Promise.all([
            new PostgreSqlContainer('postgres:17-alpine')
                .withSSL(certs.certPath, certs.keyPath)
                .start(),
            new MySqlContainer('mysql:8.4').start()
        ])
        pg = pgStarted
        my = myStarted
        myCa = await mysqlCa(my)
        registry = createDbRegistry({
            cwd: certs.dir,
            env: { DBMOLE_STORE: join(certs.dir, 'connections.json') }
        })
        manager = createDbManager(registry)
    })

    afterAll(async () => {
        await manager?.disposeAll().catch(() => {})
        await pg?.stop().catch(() => {})
        await my?.stop().catch(() => {})
        if (certs) {
            rmSync(certs.dir, { recursive: true, force: true })
        }
    })

    const db = (): DbManager => {
        if (!manager || !pg || !my) {
            throw new Error('setup failed: containers not started')
        }
        return manager
    }

    const addPg = (name: string, ssl: ConnectionConfig['ssl']) => {
        if (!pg) {
            throw new Error('setup failed: postgres not started')
        }
        registry.add(
            {
                name,
                type: 'postgres',
                host: pg.getHost(),
                port: pg.getPort(),
                user: pg.getUsername(),
                password: pg.getPassword(),
                database: pg.getDatabase(),
                readonly: false,
                ssl
            },
            'global'
        )
    }

    const addMy = (name: string, ssl: ConnectionConfig['ssl']) => {
        if (!my) {
            throw new Error('setup failed: mysql not started')
        }
        registry.add(
            {
                name,
                type: 'mysql',
                host: my.getHost(),
                port: my.getPort(),
                user: my.getUsername(),
                password: my.getUserPassword(),
                database: my.getDatabase(),
                readonly: false,
                ssl
            },
            'global'
        )
    }

    it('postgres: rejects a trusted certificate issued for another host', async () => {
        addPg('pg-ca-path', { ca: certs?.caPath })
        const { backend } = await db().get('pg-ca-path')
        await expect(backend.query({ sql: PG_SSL_SQL, rowLimit: 1 })).rejects.toThrow(WRONG_HOST)
    })

    it('postgres: rejects an untrusted certificate with ssl: true', async () => {
        addPg('pg-ssl-true', true)
        const { backend } = await db().get('pg-ssl-true')
        await expect(backend.query({ sql: PG_SSL_SQL, rowLimit: 1 })).rejects.toThrow(
            /unable to verify the first certificate/
        )
    })

    it('postgres: encrypts with rejectUnauthorized: false', async () => {
        addPg('pg-no-verify', { rejectUnauthorized: false })
        const { backend } = await db().get('pg-no-verify')
        const result = await backend.query({ sql: PG_SSL_SQL, rowLimit: 1 })
        expect(result.rows).toEqual([[true]])
    })

    it('mysql: rejects its trusted certificate for another host', async () => {
        addMy('my-ca', { ca: myCa })
        const { backend } = await db().get('my-ca')
        await expect(backend.query({ sql: 'SELECT 1', rowLimit: 1 })).rejects.toThrow(WRONG_HOST)
    })

    it('mysql: encrypts with rejectUnauthorized: false', async () => {
        addMy('my-no-verify', { rejectUnauthorized: false })
        const { backend } = await db().get('my-no-verify')
        const result = await backend.query({ sql: MYSQL_SSL_SQL, rowLimit: 1 })
        expect(String(result.rows[0][1])).toMatch(/^TLSv1\.[23]$/)
    })
})
