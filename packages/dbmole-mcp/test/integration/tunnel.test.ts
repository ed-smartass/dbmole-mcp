import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprint } from '@dbmole/core'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import {
    GenericContainer,
    Network,
    type StartedNetwork,
    type StartedTestContainer,
    Wait
} from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../../src/schema.js'
import {
    createDbManager,
    createDbRegistry,
    type DbManager,
    type DbRegistry
} from '../../src/wiring.js'
import { makeCerts, mysqlCa, type TestCerts } from './certs.js'

// Pinned by digest for wait-strategy stability: the wait below depends on this
// image's '[ls.io-init] done.' log line and /config/sshd/sshd_config layout.
const SSHD_IMAGE =
    'lscr.io/linuxserver/openssh-server@sha256:5b8550a3b703eb4e5efb14a1f491370b7f765febfac5b0b2ed0321cdc74b1476'

// Replaces the openssh-server-ssh-tunnel docker mod, whose init curls ghcr.io
// without a timeout and can hang forever. /custom-cont-init.d scripts run after
// sshd_config is generated and before the sshd service starts.
const ENABLE_FORWARDING = `#!/bin/bash
sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config
`

describe('ssh tunnel integration', () => {
    let network: StartedNetwork | undefined
    let postgres: StartedPostgreSqlContainer | undefined
    let sshd: StartedTestContainer | undefined
    let dir: string | undefined
    let registry: DbRegistry
    let manager: DbManager | undefined
    // Fingerprint of the sshd's ed25519 host key (the one ssh2 negotiates),
    // read from inside the container: the test pins it like a user would.
    let hostKey = ''
    let certs: TestCerts | undefined
    let mysql: StartedMySqlContainer | undefined

    beforeAll(async () => {
        network = await new Network().start()

        certs = makeCerts('db')
        postgres = await new PostgreSqlContainer('postgres:17-alpine')
            .withNetwork(network)
            .withNetworkAliases('db', 'db-alias')
            .withSSL(certs.certPath, certs.keyPath)
            .start()
        mysql = await new MySqlContainer('mysql:8.4')
            .withNetwork(network)
            .withNetworkAliases('mydb')
            .start()

        sshd = await new GenericContainer(SSHD_IMAGE)
            .withNetwork(network)
            .withEnvironment({
                PUID: '1000',
                PGID: '1000',
                USER_NAME: 'tunnel',
                USER_PASSWORD: 'tunnelpass',
                PASSWORD_ACCESS: 'true'
            })
            .withCopyContentToContainer([
                { content: ENABLE_FORWARDING, target: '/custom-cont-init.d/10-tunnel', mode: 0o755 }
            ])
            .withExposedPorts(2222)
            // sshd starts once, as a service AFTER init, already configured.
            // '[ls.io-init] done.' marks config complete; the port wait covers
            // the gap until sshd actually listens.
            .withWaitStrategy(
                Wait.forAll([
                    Wait.forLogMessage(/\[ls\.io-init\] done\./),
                    Wait.forListeningPorts()
                ])
            )
            .start()

        const pub = await sshd.exec(['cat', '/config/ssh_host_keys/ssh_host_ed25519_key.pub'])
        hostKey = fingerprint(Buffer.from(pub.stdout.trim().split(/\s+/)[1], 'base64'))

        dir = mkdtempSync(join(tmpdir(), 'dbmole-int-ssh-'))
        registry = createDbRegistry({
            cwd: dir,
            env: { DBMOLE_STORE: join(dir, 'connections.json') }
        })
        manager = createDbManager(registry)
        registry.add(
            {
                name: 'pg-tunneled',
                type: 'postgres',
                host: 'db',
                port: 5432,
                user: postgres.getUsername(),
                password: postgres.getPassword(),
                database: postgres.getDatabase(),
                readonly: false,
                ssh: {
                    host: sshd.getHost(),
                    port: sshd.getMappedPort(2222),
                    user: 'tunnel',
                    password: 'tunnelpass',
                    hostKey
                }
            },
            'global'
        )
        const ssh = registry.resolve('pg-tunneled').config.ssh
        const pgVia = (name: string, host: string, ssl: ConnectionConfig['ssl']) => {
            if (!postgres) {
                throw new Error('setup failed: postgres not started')
            }
            registry.add(
                {
                    name,
                    type: 'postgres',
                    host,
                    port: 5432,
                    user: postgres.getUsername(),
                    password: postgres.getPassword(),
                    database: postgres.getDatabase(),
                    readonly: false,
                    ssh,
                    ssl
                },
                'global'
            )
        }
        const myVia = (name: string, ssl: ConnectionConfig['ssl']) => {
            if (!mysql) {
                throw new Error('setup failed: mysql not started')
            }
            registry.add(
                {
                    name,
                    type: 'mysql',
                    host: 'mydb',
                    port: 3306,
                    user: mysql.getUsername(),
                    password: mysql.getUserPassword(),
                    database: mysql.getDatabase(),
                    readonly: false,
                    ssh,
                    ssl
                },
                'global'
            )
        }
        pgVia('pg-tls-tunneled', 'db', { ca: certs.ca })
        pgVia('pg-tls-wrong-host', 'db-alias', { ca: certs.ca })
        myVia('my-tls-tunneled', { ca: await mysqlCa(mysql) })
        myVia('my-tls-tunneled-no-verify', { rejectUnauthorized: false })
    })

    afterAll(async () => {
        await manager?.disposeAll().catch(() => {})
        await sshd?.stop().catch(() => {})
        await postgres?.stop().catch(() => {})
        await mysql?.stop().catch(() => {})
        await network?.stop().catch(() => {})
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
        }
        if (certs) {
            rmSync(certs.dir, { recursive: true, force: true })
        }
    })

    const db = (): DbManager => {
        if (!manager) {
            throw new Error('setup failed: manager not initialized')
        }
        return manager
    }

    it('queries postgres through the ssh tunnel', async () => {
        const { backend: driver } = await db().get('pg-tunneled')
        const result = await driver.query({ sql: 'SELECT 1 + 1', rowLimit: 10 })
        expect(result.rows).toEqual([[2]])
    })

    it('reports server version through the tunnel', async () => {
        const { backend: driver } = await db().get('pg-tunneled')
        expect(await driver.serverVersion()).toMatch(/^17\./)
    })

    it('verifies the postgres certificate against the original host', async () => {
        // Passes only because the check uses 'db', not the 127.0.0.1 forward.
        const { backend: driver } = await db().get('pg-tls-tunneled')
        const result = await driver.query({
            sql: 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
            rowLimit: 1
        })
        expect(result.rows).toEqual([[true]])
    })

    it('rejects a postgres certificate for another host through the tunnel', async () => {
        const { backend: driver } = await db().get('pg-tls-wrong-host')
        await expect(driver.query({ sql: 'SELECT 1', rowLimit: 1 })).rejects.toThrow(
            /Host: db-alias\. is not in the cert's altnames: DNS:db/
        )
    })

    it('checks the mysql certificate against the original host', async () => {
        const { backend: driver } = await db().get('my-tls-tunneled')
        await expect(driver.query({ sql: 'SELECT 1', rowLimit: 1 })).rejects.toThrow(
            /Host: mydb\. is not cert's CN/
        )
    })

    it('runs mysql over TLS through the tunnel', async () => {
        const { backend: driver } = await db().get('my-tls-tunneled-no-verify')
        const result = await driver.query({ sql: "SHOW STATUS LIKE 'Ssl_version'", rowLimit: 1 })
        expect(String(result.rows[0][1])).toMatch(/^TLSv1\.[23]$/)
    })

    // Last on purpose: it repins the shared connection to a wrong key.
    it('rejects a wrong pinned host key, naming the presented fingerprint', async () => {
        const wrong = 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '')
        // Merged into the stored ssh object: the password survives the patch.
        registry.update('pg-tunneled', { ssh: { hostKey: wrong } })
        const failed = db().get('pg-tunneled')
        await expect(failed).rejects.toThrow(
            'ssh host key for ' +
                sshd?.getHost() +
                ':' +
                sshd?.getMappedPort(2222) +
                ' is ' +
                hostKey
        )
        await expect(failed).rejects.toThrow('via update_connection')
    })
})
