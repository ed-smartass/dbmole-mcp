import { describe, expect, it } from 'vitest'
import {
    CELL_CAP,
    capStrings,
    clampLimit,
    fitJson,
    OUTPUT_BUDGET,
    sliceUtf8
} from '../../src/format.js'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('clampLimit', () => {
    it('returns fallback when undefined', () => {
        expect(clampLimit(undefined)).toBe(100)
        expect(clampLimit(undefined, 7)).toBe(7)
    })
    it('clamps to [1, max]', () => {
        expect(clampLimit(0)).toBe(1)
        expect(clampLimit(99999)).toBe(1000)
        expect(clampLimit(5000, 100, 2000)).toBe(2000)
    })
    it('truncates fractions', () => {
        expect(clampLimit(10.9)).toBe(10)
    })
})

describe('sliceUtf8', () => {
    it('returns the string unchanged when it fits', () => {
        expect(sliceUtf8('hello', 100)).toBe('hello')
    })
    it('caps to a real UTF-8 byte budget', () => {
        const out = sliceUtf8('abcdef', 3)
        expect(bytes(out)).toBeLessThanOrEqual(3)
        expect(out).toBe('abc')
    })
    it('does not split a multi-byte code point at the boundary', () => {
        const out = sliceUtf8('aéé', 3)
        expect(bytes(out)).toBeLessThanOrEqual(3)
        expect(out).toBe('aé')
    })
})

describe('constants', () => {
    it('match the spec budgets', () => {
        expect(OUTPUT_BUDGET).toBe(40_000)
        expect(CELL_CAP).toBe(2_000)
    })
})

describe('capStrings', () => {
    it('leaves short strings and non-strings alone', () => {
        const value = { a: 'short', n: 1, b: true, z: null, list: ['x', 2] }
        expect(capStrings(value)).toEqual(value)
    })
    it('cuts long strings to the cap plus a byte-count marker', () => {
        const out = capStrings({ s: 'x'.repeat(2500) })
        expect(out).toEqual({ s: 'x'.repeat(2000) + '…[+500 bytes]' })
    })
    it('recurses into nested arrays and objects', () => {
        const out = capStrings([{ deep: ['y'.repeat(30)] }], 10)
        expect(out).toEqual([{ deep: ['y'.repeat(10) + '…[+20 bytes]'] }])
    })
    it('counts bytes, not characters, and never splits a code point', () => {
        // 'é' is 2 bytes: 11 bytes of cap keep 5 chars (10 bytes), 10 bytes dropped
        const out = capStrings('é'.repeat(10), 11)
        expect(out).toBe('é'.repeat(5) + '…[+10 bytes]')
    })
    it('does not mutate its input', () => {
        const input = { s: 'x'.repeat(50) }
        capStrings(input, 10)
        expect(input.s).toHaveLength(50)
    })
})

describe('fitJson', () => {
    it('passes values under budget through as plain JSON', () => {
        const value = { columns: ['a'], rows: [[1]], rowCount: 1 }
        expect(fitJson(value)).toBe(JSON.stringify(value))
    })

    it('serializes undefined as null', () => {
        expect(fitJson(undefined)).toBe('null')
    })

    it('caps long strings and marks the result truncated', () => {
        const out = JSON.parse(fitJson({ s: 'x'.repeat(5000) }, 3000))
        expect(out.s).toBe('x'.repeat(2000) + '…[+3000 bytes]')
        expect(out.truncated).toEqual({ reason: 'budget', dropped: 0 })
    })

    it('caps a long string even when the value is under budget', () => {
        const out = JSON.parse(fitJson({ note: 'n'.repeat(3000), id: 7 }))
        expect(out.note).toBe('n'.repeat(2000) + '…[+1000 bytes]')
        expect(out.id).toBe(7)
        expect(out.truncated).toEqual({ reason: 'budget', dropped: 0 })
    })

    it('caps a long SQL cell under budget and keeps every row', () => {
        const rows = [
            [1, 'c'.repeat(3000)],
            [2, 'short']
        ]
        const out = JSON.parse(fitJson({ columns: ['id', 'body'], rows, rowCount: 2 }))
        expect(out.columns).toEqual(['id', 'body'])
        expect(out.rows).toEqual([
            [1, 'c'.repeat(2000) + '…[+1000 bytes]'],
            [2, 'short']
        ])
        expect(out.rowCount).toBe(2)
        expect(out.truncated).toEqual({ reason: 'budget', dropped: 0 })
    })

    it('keeps a rowLimit marker when a long SQL cell is capped under budget', () => {
        const value = {
            columns: ['body'],
            rows: [['c'.repeat(3000)], ['ok']],
            rowCount: 2,
            truncated: { reason: 'rowLimit', limit: 2 }
        }
        const out = JSON.parse(fitJson(value))
        expect(out.rows).toEqual([['c'.repeat(2000) + '…[+1000 bytes]'], ['ok']])
        expect(out.truncated).toEqual({ reason: 'rowLimit', limit: 2 })
    })

    it('keeps a producer truncation marker when only strings were capped', () => {
        const value = {
            columns: ['t'],
            rows: [['x'.repeat(5000)]],
            rowCount: 1,
            truncated: { reason: 'rowLimit', limit: 1 }
        }
        const out = JSON.parse(fitJson(value, 3000))
        expect(out.rows[0][0]).toContain('…[+3000 bytes]')
        expect(out.truncated).toEqual({ reason: 'rowLimit', limit: 1 })
    })

    it('drops whole SQL rows from the end and reports kept rows', () => {
        const rows = Array.from({ length: 500 }, (_, i) => [i, 'row-' + i + '-'.repeat(80)])
        const text = fitJson({ columns: ['id', 'label'], rows, rowCount: 500 }, 10_000)
        expect(bytes(text)).toBeLessThanOrEqual(10_000)
        const out = JSON.parse(text)
        expect(out.columns).toEqual(['id', 'label'])
        expect(out.rows.length).toBeGreaterThan(0)
        expect(out.rows.length).toBeLessThan(500)
        expect(out.rows).toEqual(rows.slice(0, out.rows.length))
        expect(out.rowCount).toBe(out.rows.length)
        expect(out.truncated).toEqual({
            reason: 'budget',
            dropped: 500 - out.rows.length,
            kept: out.rows.length
        })
    })

    it('keeps as many SQL rows as fit (one more would not)', () => {
        const rows = Array.from({ length: 200 }, (_, i) => [i, 'v'.repeat(50)])
        const budget = 5_000
        const out = JSON.parse(fitJson({ columns: ['id', 'v'], rows, rowCount: 200 }, budget))
        const kept = out.rows.length
        const oneMore = JSON.stringify({
            columns: ['id', 'v'],
            rows: rows.slice(0, kept + 1),
            rowCount: kept + 1,
            truncated: { reason: 'budget', dropped: 200 - kept - 1, kept: kept + 1 }
        })
        expect(bytes(oneMore)).toBeGreaterThan(budget)
    })

    it('keeps every row when only the producer rowCount pushed it over budget', () => {
        const columns = ['id']
        const rows = [[1], [2], [3]]
        const truncated = { reason: 'rowLimit', limit: 3 }
        const budget = bytes(JSON.stringify({ columns, rows, rowCount: 3, truncated }))
        const value = { columns, rows, rowCount: 123_456_789_012, truncated }
        const out = JSON.parse(fitJson(value, budget))
        expect(out.rows).toEqual(rows)
    })

    it('never touches SQL columns, even long names', () => {
        const longName = 'c'.repeat(2500)
        const rows = Array.from({ length: 100 }, () => ['v'.repeat(100)])
        const out = JSON.parse(fitJson({ columns: [longName], rows, rowCount: 100 }, 6000))
        expect(out.columns).toEqual([longName])
        expect(out.truncated.reason).toBe('budget')
    })

    it('falls back to the envelope when SQL metadata alone is too big', () => {
        const columns = Array.from({ length: 50 }, (_, i) => 'column_' + i + '_'.repeat(40))
        const text = fitJson({ columns, rows: [[1]], rowCount: 1 }, 1000)
        expect(bytes(text)).toBeLessThanOrEqual(1000)
        const out = JSON.parse(text)
        expect(out.truncated.reason).toBe('too large')
        expect(typeof out.preview).toBe('string')
    })

    it('halves the longest array in a generic body', () => {
        const body = {
            took: 3,
            hits: { hits: Array.from({ length: 400 }, (_, i) => ({ id: i, t: 'x'.repeat(40) })) },
            tags: ['a', 'b']
        }
        const text = fitJson(body, 5000)
        expect(bytes(text)).toBeLessThanOrEqual(5000)
        const out = JSON.parse(text)
        expect(out.took).toBe(3)
        expect(out.tags).toEqual(['a', 'b'])
        expect(out.hits.hits.length).toBeLessThan(400)
        expect(out.hits.hits).toEqual(body.hits.hits.slice(0, out.hits.hits.length))
        expect(out.truncated).toEqual({ reason: 'budget', dropped: 400 - out.hits.hits.length })
    })

    it('picks the longest array even when it is nested inside a shorter one', () => {
        const body = {
            buckets: [
                { key: 'a', docs: Array.from({ length: 300 }, (_, i) => 'doc-' + i) },
                { key: 'b', docs: ['only'] }
            ]
        }
        const out = JSON.parse(fitJson(body, 1500))
        expect(out.buckets).toHaveLength(2)
        expect(out.buckets[0].docs.length).toBeLessThan(300)
        expect(out.buckets[1].docs).toEqual(['only'])
    })

    it('wraps a non-object result as { value, truncated }', () => {
        const list = Array.from({ length: 300 }, (_, i) => ({ name: 'table_' + i }))
        const text = fitJson(list, 2000)
        expect(bytes(text)).toBeLessThanOrEqual(2000)
        const out = JSON.parse(text)
        expect(Array.isArray(out.value)).toBe(true)
        expect(out.value.length).toBeLessThan(300)
        expect(out.truncated).toEqual({ reason: 'budget', dropped: 300 - out.value.length })
    })

    it('wraps a long top-level string', () => {
        const out = JSON.parse(fitJson('z'.repeat(10_000), 4000))
        expect(out.value).toBe('z'.repeat(2000) + '…[+8000 bytes]')
        expect(out.truncated).toEqual({ reason: 'budget', dropped: 0 })
    })

    it('returns the fallback envelope for a huge object without arrays', () => {
        const body = Object.fromEntries(
            Array.from({ length: 2000 }, (_, i) => ['key_' + i, 'value-' + i])
        )
        const original = bytes(JSON.stringify(body))
        const text = fitJson(body, 1000)
        expect(bytes(text)).toBeLessThanOrEqual(1000)
        const out = JSON.parse(text)
        expect(out.truncated).toEqual({ reason: 'too large', bytes: original })
        expect(JSON.stringify(body).startsWith(out.preview)).toBe(true)
        expect(out.preview.length).toBeGreaterThan(0)
    })

    it.each([
        ['quote', '"'],
        ['backslash', '\\']
    ])('keeps a full preview within budget for %s-heavy input', (_, char) => {
        // Each char serializes as 2 bytes, and again inside the preview string;
        // the old truncateJsonBudget produced ~2x its budget on this shape.
        const body = Object.fromEntries(
            Array.from({ length: 2000 }, (_, i) => ['k' + i, char.repeat(1000)])
        )
        const text = fitJson(body, 40_000)
        expect(bytes(text)).toBeLessThanOrEqual(40_000)
        expect(bytes(text)).toBeGreaterThan(39_000)
        const out = JSON.parse(text)
        expect(out.truncated.reason).toBe('too large')
        expect(JSON.stringify(body).startsWith(out.preview)).toBe(true)
    })

    it('stays within budget for quote-heavy SQL cells', () => {
        const rows = Array.from({ length: 300 }, () => ['"\\'.repeat(400)])
        const text = fitJson({ columns: ['q'], rows, rowCount: 300 }, 20_000)
        expect(bytes(text)).toBeLessThanOrEqual(20_000)
        expect(JSON.parse(text).truncated.reason).toBe('budget')
    })

    it('stays within budget for multibyte UTF-8 and never splits a code point', () => {
        const rows = Array.from({ length: 200 }, (_, i) => [i, 'é漢😀'.repeat(300)])
        const text = fitJson({ columns: ['id', 'txt'], rows, rowCount: 200 }, 12_000)
        expect(bytes(text)).toBeLessThanOrEqual(12_000)
        expect(text).not.toContain('�')
        const out = JSON.parse(text)
        expect(out.rows[0][1]).toMatch(/…\[\+\d+ bytes\]$/)
        expect(bytes(out.rows[0][1].split('…')[0])).toBeLessThanOrEqual(2000)
    })

    it('keeps multibyte previews intact in the envelope', () => {
        const body = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['k' + i, '漢字']))
        const text = fitJson(body, 300)
        expect(bytes(text)).toBeLessThanOrEqual(300)
        expect(text).not.toContain('�')
    })

    it('terminates with valid JSON for a budget too small for any envelope', () => {
        const text = fitJson({ a: 'x'.repeat(100), list: [1, 2, 3] }, 5)
        const out = JSON.parse(text)
        expect(out.truncated.reason).toBe('too large')
        expect(out.preview).toBe('')
    })

    it('falls back after bounded passes over many tiny arrays', () => {
        const body = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['k' + i, [i, i]]))
        const text = fitJson(body, 2000)
        expect(bytes(text)).toBeLessThanOrEqual(2000)
        expect(JSON.parse(text).truncated.reason).toBe('too large')
    })
})
