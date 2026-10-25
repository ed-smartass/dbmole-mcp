import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { fitJson, OUTPUT_BUDGET, sliceUtf8 } from '../format.js'

export const ok = (payload: unknown): CallToolResult => ({
    content: [{ type: 'text', text: fitJson(payload) }]
})

export const fail = (message: string): CallToolResult => ({
    content: [{ type: 'text', text: sliceUtf8(message, OUTPUT_BUDGET) }],
    isError: true
})

export const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

// Thrown inside a withManaged fn to return fail(message) verbatim, without
// the engine prefix formatError would add.
export class ToolFailure extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ToolFailure'
    }
}
