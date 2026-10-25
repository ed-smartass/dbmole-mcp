import { describe, expect, it } from 'vitest'
import {
    connectionConfigSchema,
    connectionObjectSchema,
    defaultPort,
    MYSQL_IP_TLS_MESSAGE
} from '../../src/schema.js'

describe('connectionConfigSchema', () => {
    const minimal = {
        name: 'lab-pg',
        type: 'postgres',
        host: 'localhost',
        user: 'postgres'
    }

    it('accepts minimal config and applies defaults', () => {
        const parsed = connectionConfigSchema.parse(minimal)
        expect(parsed.readonly).toBe(false)
        expect(parsed.port).toBeUndefined()
        expect(parsed.ssh).toBeUndefined()
    })

    it('accepts full config with ssh and defaults ssh port to 22', () => {
        const parsed = connectionConfigSchema.parse({
            ...minimal,
            port: 5433,
            password: 'secret',
            database: 'app',
            readonly: true,
            ssh: { host: 'bastion', user: 'root', privateKeyPath: '~/.ssh/id_ed25519' }
        })
        expect(parsed.ssh?.port).toBe(22)
        expect(parsed.readonly).toBe(true)
    })

    it('rejects bad name characters', () => {
        expect(() => connectionConfigSchema.parse({ ...minimal, name: 'bad name!' })).toThrow()
    })

    it('rejects unknown engine type', () => {
        expect(() => connectionConfigSchema.parse({ ...minimal, type: 'oracle' })).toThrow()
    })

    it('rejects empty host', () => {
        expect(() => connectionConfigSchema.parse({ ...minimal, host: '' })).toThrow()
    })

    it('rejects unknown top-level keys', () => {
        expect(() => connectionConfigSchema.parse({ ...minimal, readOnly: true })).toThrow()
    })

    it('rejects unknown ssh keys', () => {
        expect(() =>
            connectionConfigSchema.parse({
                ...minimal,
                ssh: { host: 'b', user: 'u', password: 'p', prot: 22 }
            })
        ).toThrow()
    })
})

describe('defaultPort', () => {
    it('returns 5432 for postgres and 3306 for mysql', () => {
        expect(defaultPort('postgres')).toBe(5432)
        expect(defaultPort('mysql')).toBe(3306)
    })
})

describe('ssl', () => {
    const mysql = { name: 'my', type: 'mysql', host: 'db.example', user: 'root' }

    it('accepts ssl: true and an options object', () => {
        expect(connectionConfigSchema.parse({ ...mysql, ssl: true }).ssl).toBe(true)
        expect(
            connectionConfigSchema.parse({
                ...mysql,
                ssl: { ca: '~/ca.pem', rejectUnauthorized: true }
            }).ssl
        ).toEqual({ ca: '~/ca.pem', rejectUnauthorized: true })
    })

    it('rejects ssl: false and unknown ssl keys', () => {
        expect(connectionConfigSchema.safeParse({ ...mysql, ssl: false }).success).toBe(false)
        expect(connectionConfigSchema.safeParse({ ...mysql, ssl: { verify: true } }).success).toBe(
            false
        )
    })

    it('rejects mysql with an IP host and verifying TLS', () => {
        for (const host of ['10.0.0.5', '::1']) {
            for (const ssl of [true, {}, { ca: '/ca.pem' }, { rejectUnauthorized: true }]) {
                const result = connectionConfigSchema.safeParse({ ...mysql, host, ssl })
                expect(result.success).toBe(false)
                expect(result.error?.issues[0]).toMatchObject({
                    path: ['ssl'],
                    message: MYSQL_IP_TLS_MESSAGE
                })
            }
        }
    })

    it('allows IP hosts without verification, without TLS, or on postgres', () => {
        const ip = { ...mysql, host: '10.0.0.5' }
        expect(
            connectionConfigSchema.safeParse({ ...ip, ssl: { rejectUnauthorized: false } }).success
        ).toBe(true)
        expect(connectionConfigSchema.safeParse(ip).success).toBe(true)
        expect(
            connectionConfigSchema.safeParse({ ...ip, type: 'postgres', ssl: true }).success
        ).toBe(true)
    })

    it('advertises ssl on the plain object schema', () => {
        expect(Object.keys(connectionObjectSchema.shape)).toContain('ssl')
        expect(
            connectionObjectSchema.safeParse({ ...mysql, host: '10.0.0.5', ssl: true }).success
        ).toBe(true)
    })
})
