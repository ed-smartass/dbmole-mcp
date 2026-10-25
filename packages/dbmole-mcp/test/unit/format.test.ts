import { describe, expect, it } from 'vitest'
import { formatDbError, normalizeCell } from '../../src/format.js'

describe('normalizeCell', () => {
    it('converts bigint to string', () => {
        expect(normalizeCell(123n)).toBe('123')
    })

    it('converts Date to ISO string', () => {
        expect(normalizeCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z')
    })

    it('converts Buffer to hex string', () => {
        expect(normalizeCell(Buffer.from([0xde, 0xad]))).toBe('\\xdead')
    })

    it('passes primitives and null through', () => {
        expect(normalizeCell('x')).toBe('x')
        expect(normalizeCell(5)).toBe(5)
        expect(normalizeCell(null)).toBeNull()
    })

    it('normalizes inside arrays, recursively', () => {
        expect(
            normalizeCell([[1n, new Date('2026-10-24T00:00:00Z')], Buffer.from([1]), null, 'x'])
        ).toEqual([['1', '2026-10-24T00:00:00.000Z'], '\\x01', null, 'x'])
    })
})

describe('formatDbError', () => {
    it('formats code, detail and hint', () => {
        const error = Object.assign(new Error('relation "x" does not exist'), {
            code: '42P01',
            hint: 'check the table name'
        })
        expect(formatDbError('postgres', error)).toBe(
            '[postgres 42P01] relation "x" does not exist (check the table name)'
        )
    })

    it('prefers sqlMessage for mysql errors', () => {
        const error = Object.assign(new Error('outer'), {
            code: 'ER_NO_SUCH_TABLE',
            sqlMessage: "Table 'a.b' doesn't exist"
        })
        expect(formatDbError('mysql', error)).toBe(
            "[mysql ER_NO_SUCH_TABLE] Table 'a.b' doesn't exist"
        )
    })

    it('joins detail and hint', () => {
        const error = Object.assign(new Error('boom'), {
            code: '23505',
            detail: 'Key (id)=(1) already exists.',
            hint: 'use upsert'
        })
        expect(formatDbError('postgres', error)).toBe(
            '[postgres 23505] boom (Key (id)=(1) already exists. | use upsert)'
        )
    })

    it('handles non-Error values', () => {
        expect(formatDbError('mysql', 'boom')).toBe('[mysql] boom')
    })
})
