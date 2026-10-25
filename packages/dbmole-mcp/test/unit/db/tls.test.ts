import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mysqlSsl, pgSsl, readCa } from '../../../src/db/tls.js'
import type { ConnectionConfig } from '../../../src/schema.js'

// Self-signed test certificate: CN=db, SAN DNS:db, valid until 2126. Public part only.
const DB_CERT = `-----BEGIN CERTIFICATE-----
MIIBgTCCASagAwIBAgIUMkHo6rGIznM5SfjXoz92UeF10LIwCgYIKoZIzj0EAwIw
DTELMAkGA1UEAwwCZGIwIBcNMjYxMDI0MTIxMTQ5WhgPMjEyNjA5MzAxMjExNDla
MA0xCzAJBgNVBAMMAmRiMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEz8wHS8D7
v+gFG2fTJrPhL21EYjvsKrFDZc5BrqOAihKRtnbGUeXZdcmPb1Rb9r5KgcrkCKA9
bHItEMCICxWFyKNiMGAwHQYDVR0OBBYEFB4LXXkOEUB6LQjE89c68lDIuMDWMB8G
A1UdIwQYMBaAFB4LXXkOEUB6LQjE89c68lDIuMDWMA8GA1UdEwEB/wQFMAMBAf8w
DQYDVR0RBAYwBIICZGIwCgYIKoZIzj0EAwIDSQAwRgIhAK3WTvakUFAUsxNWH7nX
ALTlO4eU2SO29OMnGM0TYyxSAiEA+InsnE1H1tH+DJ5bKXj3qr/dKaLh87vnM2cC
v6+kfCs=
-----END CERTIFICATE-----
`

const config = (ssl?: ConnectionConfig['ssl']): ConnectionConfig => ({
    name: 'c',
    type: 'postgres',
    host: 'db',
    user: 'u',
    readonly: false,
    ...(ssl === undefined ? {} : { ssl })
})

describe('readCa', () => {
    it('returns PEM content as is', () => {
        expect(readCa(DB_CERT)).toBe(DB_CERT)
    })

    it('reads a file path', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dbmole-ca-'))
        try {
            const path = join(dir, 'ca.pem')
            writeFileSync(path, DB_CERT)
            expect(readCa(path)).toBe(DB_CERT)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('fails on a missing file', () => {
        expect(() => readCa('/nonexistent/dbmole-ca.pem')).toThrow(/ENOENT/)
    })
})

describe('pgSsl', () => {
    it('is undefined without ssl', () => {
        expect(pgSsl(config(), 'db')).toBeUndefined()
    })

    it('verifies by default and sends the real server name', () => {
        expect(pgSsl(config(true), 'db')).toMatchObject({
            rejectUnauthorized: true,
            servername: 'db'
        })
    })

    it('verifies when the options object leaves rejectUnauthorized out', () => {
        expect(pgSsl(config({}), 'db')).toMatchObject({ rejectUnauthorized: true })
        expect(pgSsl(config({ ca: DB_CERT }), 'db')).toMatchObject({
            rejectUnauthorized: true,
            ca: DB_CERT
        })
    })

    it('passes rejectUnauthorized and ca through', () => {
        const options = pgSsl(config({ rejectUnauthorized: false, ca: DB_CERT }), 'db')
        expect(options).toMatchObject({ rejectUnauthorized: false, ca: DB_CERT })
    })

    it('never sends an IP as SNI', () => {
        expect(pgSsl(config(true), '10.0.0.5')).not.toHaveProperty('servername')
    })

    it('checks the certificate against the server name, not the dialed host', () => {
        const cert = new X509Certificate(DB_CERT).toLegacyObject()
        expect(pgSsl(config(true), 'db')?.checkServerIdentity?.('127.0.0.1', cert)).toBeUndefined()
        expect(
            pgSsl(config(true), 'other.example')?.checkServerIdentity?.('db', cert)
        ).toBeInstanceOf(Error)
    })
})

describe('mysqlSsl', () => {
    it('is undefined without ssl', () => {
        expect(mysqlSsl(config())).toBeUndefined()
    })

    it('verifies chain and identity for ssl: true', () => {
        expect(mysqlSsl(config(true))).toEqual({ rejectUnauthorized: true, verifyIdentity: true })
    })

    it('turns identity checks off without verification', () => {
        expect(mysqlSsl(config({ rejectUnauthorized: false }))).toEqual({
            rejectUnauthorized: false,
            verifyIdentity: false
        })
    })

    it('passes the ca', () => {
        expect(mysqlSsl(config({ ca: DB_CERT }))).toEqual({
            rejectUnauthorized: true,
            verifyIdentity: true,
            ca: DB_CERT
        })
    })
})
