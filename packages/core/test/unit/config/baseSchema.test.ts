import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
    baseConnectionShape,
    DEFAULT_QUERY_TIMEOUT_MS,
    sshConfigSchema,
    sshPatchSchema
} from '../../../src/config/baseSchema.js'

// A minimal concrete schema built from the shared base, the way a leaf package
// would compose it.
const testSchema = z.object({ ...baseConnectionShape, type: z.literal('test') }).strict()

describe('sshConfigSchema', () => {
    it('defaults port to 22', () => {
        expect(sshConfigSchema.parse({ host: 'h', user: 'u' }).port).toBe(22)
    })
    it('rejects unknown keys (strict)', () => {
        expect(() => sshConfigSchema.parse({ host: 'h', user: 'u', bogus: 1 })).toThrow()
    })
    it('accepts an OpenSSH SHA256 hostKey and rejects other formats', () => {
        const hostKey = 'SHA256:y7R/XB69YxB33LfH4yzcb8uck0tqIZXt8iwwSZ5SuZo'
        expect(sshConfigSchema.parse({ host: 'h', user: 'u', hostKey }).hostKey).toBe(hostKey)
        expect(() => sshConfigSchema.parse({ host: 'h', user: 'u', hostKey: 'MD5:aa:bb' })).toThrow(
            "hostKey must look like 'SHA256:<base64>'"
        )
    })
})

describe('sshPatchSchema', () => {
    it('accepts a partial patch with nulls and no defaults', () => {
        expect(sshPatchSchema.parse({ hostKey: 'SHA256:abc', password: null })).toEqual({
            hostKey: 'SHA256:abc',
            password: null
        })
    })
    it('rejects unknown keys (strict)', () => {
        expect(() => sshPatchSchema.parse({ bogus: 1 })).toThrow()
    })
})

describe('baseConnectionShape', () => {
    it('accepts a valid connection and defaults readonly to false', () => {
        const c = testSchema.parse({ name: 'c1', host: 'h', user: 'u', type: 'test' })
        expect(c.readonly).toBe(false)
        expect(c.port).toBeUndefined()
    })
    it('requires user', () => {
        expect(() => testSchema.parse({ name: 'c1', host: 'h', type: 'test' })).toThrow()
    })
    it('rejects an invalid name', () => {
        expect(() =>
            testSchema.parse({ name: 'bad name!', host: 'h', user: 'u', type: 'test' })
        ).toThrow()
    })
    it('accepts an optional positive integer queryTimeoutMs', () => {
        const base = { name: 'c1', host: 'h', user: 'u', type: 'test' }
        expect(testSchema.parse(base).queryTimeoutMs).toBeUndefined()
        expect(testSchema.parse({ ...base, queryTimeoutMs: 5000 }).queryTimeoutMs).toBe(5000)
        expect(() => testSchema.parse({ ...base, queryTimeoutMs: 0 })).toThrow()
        expect(() => testSchema.parse({ ...base, queryTimeoutMs: 1.5 })).toThrow()
        // Node timers overflow above 2^31-1 ms (AbortSignal.timeout fires at once).
        expect(testSchema.parse({ ...base, queryTimeoutMs: 2 ** 31 - 1 }).queryTimeoutMs).toBe(
            2 ** 31 - 1
        )
        expect(() => testSchema.parse({ ...base, queryTimeoutMs: 2 ** 31 })).toThrow()
        expect(DEFAULT_QUERY_TIMEOUT_MS).toBe(60_000)
    })
})
