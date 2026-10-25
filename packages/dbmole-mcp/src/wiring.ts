import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    type BackendTarget,
    createFileRegistry,
    createManager,
    type ManagedConnection,
    type Manager,
    openTunnel,
    type Registry
} from '@dbmole/core'
import type { Driver, DriverTarget } from './db/driver.js'
import { createMysqlDriver } from './db/mysql.js'
import { createPostgresDriver } from './db/postgres.js'
import { formatDbError } from './format.js'
import { type ConnectionConfig, connectionConfigSchema, defaultPort } from './schema.js'

export type DbRegistry = Registry<ConnectionConfig>
export type DbManager = Manager<ConnectionConfig, Driver>
export type DbManaged = ManagedConnection<ConnectionConfig, Driver>

export const createDbRegistry = (
    opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): DbRegistry => {
    const env = opts.env ?? process.env
    return createFileRegistry<ConnectionConfig>({
        schema: connectionConfigSchema,
        projectFileName: '.dbmole.json',
        storePath: env.DBMOLE_STORE ?? join(homedir(), '.config', 'dbmole', 'connections.json'),
        cwd: opts.cwd
    })
}

const createBackend = (target: BackendTarget<ConnectionConfig>): Driver => {
    const driverTarget: DriverTarget = {
        config: target.config,
        host: target.connectHost,
        port: target.connectPort,
        serverName: target.serverName
    }
    return target.config.type === 'postgres'
        ? createPostgresDriver(driverTarget)
        : createMysqlDriver(driverTarget)
}

export const createDbManager = (registry: DbRegistry): DbManager =>
    createManager<ConnectionConfig, Driver>(registry, {
        createBackend,
        resolvePort: (config) => config.port ?? defaultPort(config.type),
        createTunnel: (ssh, host, port) => openTunnel(ssh, host, port, 'dbmole')
    })

export const formatError = (config: ConnectionConfig, error: unknown): string =>
    formatDbError(config.type, error)

const LOST_CONNECTION_CODES: ReadonlySet<string> = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'ECONNRESET',
    'EPIPE',
    '57P01'
])

// A dropped socket or a server-side kill: the cached pool/tunnel may be stale.
// Timeouts are deliberately NOT lost connections: a query timeout (mysql2
// PROTOCOL_SEQUENCE_TIMEOUT, PG 57014) leaves the pool healthy, and ETIMEDOUT or
// pg's 'Connection terminated due to connection timeout' mean the server was
// never reached, so "the statement may or may not have run" would be false.
export const isLostConnection = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
        return false
    }
    if (
        'code' in error &&
        typeof error.code === 'string' &&
        LOST_CONNECTION_CODES.has(error.code)
    ) {
        return true
    }
    // pg reports a dropped socket by message only.
    return /^Connection terminated( unexpectedly)?$/.test(error.message)
}
