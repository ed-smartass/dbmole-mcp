import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { type ConnectionOptions, checkServerIdentity, type PeerCertificate } from 'node:tls'
import { expandHome } from '@dbmole/core'
import type { SslOptions } from 'mysql2'
import type { ConnectionConfig, SslConfig } from '../schema.js'

export const readCa = (ca: string): string =>
    ca.trimStart().startsWith('-----BEGIN') ? ca : readFileSync(expandHome(ca), 'utf8')

// ssl: true verifies the chain against the system CAs plus the hostname.
const baseSsl = (ssl: SslConfig): { rejectUnauthorized: boolean; ca?: string } => {
    if (ssl === true) {
        return { rejectUnauthorized: true }
    }
    return {
        rejectUnauthorized: ssl.rejectUnauthorized !== false,
        ...(ssl.ca ? { ca: readCa(ssl.ca) } : {})
    }
}

export const pgSsl = (
    config: ConnectionConfig,
    serverName: string
): ConnectionOptions | undefined => {
    if (!config.ssl) {
        return undefined
    }
    return {
        ...baseSsl(config.ssl),
        // pg dials the tunnel (127.0.0.1); verify against the real host instead.
        ...(isIP(serverName) === 0 ? { servername: serverName } : {}),
        checkServerIdentity: (_host: string, cert: PeerCertificate) =>
            checkServerIdentity(serverName, cert)
    }
}

export const mysqlSsl = (config: ConnectionConfig): SslOptions | undefined => {
    if (!config.ssl) {
        return undefined
    }
    const ssl = baseSsl(config.ssl)
    // mysql2 skips the hostname check unless verifyIdentity is set.
    return { ...ssl, verifyIdentity: ssl.rejectUnauthorized }
}
