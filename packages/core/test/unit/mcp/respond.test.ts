import { describe, expect, it } from 'vitest'
import { errorMessage, fail, ok, ToolFailure } from '../../../src/mcp/respond.js'

const text = (result: ReturnType<typeof ok>): string => {
    const first = result.content[0]
    return first && first.type === 'text' ? first.text : ''
}

describe('respond helpers', () => {
    it('ok wraps a JSON payload as text content', () => {
        const r = ok({ a: 1 })
        expect(r).toEqual({ content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }] })
        expect(r.isError).toBeUndefined()
    })
    it('ok fits an oversized payload into the output budget', () => {
        const rows = Array.from({ length: 2000 }, (_, i) => [i, 'x'.repeat(100)])
        const r = ok({ columns: ['id', 'x'], rows, rowCount: 2000 })
        expect(Buffer.byteLength(text(r), 'utf8')).toBeLessThanOrEqual(40_000)
        expect(JSON.parse(text(r)).truncated.reason).toBe('budget')
    })
    it('fail returns an error result with the message text', () => {
        const r = fail('boom')
        expect(r.content).toEqual([{ type: 'text', text: 'boom' }])
        expect(r.isError).toBe(true)
    })
    it('fail caps a huge message to the output budget', () => {
        const r = fail('e'.repeat(100_000))
        expect(Buffer.byteLength(text(r), 'utf8')).toBe(40_000)
    })
    it('errorMessage extracts Error.message', () => {
        expect(errorMessage(new Error('nope'))).toBe('nope')
    })
    it('errorMessage stringifies non-Errors', () => {
        expect(errorMessage('plain')).toBe('plain')
    })
    it('ToolFailure is an Error with its own name', () => {
        const error = new ToolFailure('bad index')
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe('ToolFailure')
        expect(error.message).toBe('bad index')
    })
})
