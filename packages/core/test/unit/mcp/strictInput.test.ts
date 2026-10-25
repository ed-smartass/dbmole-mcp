import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { strictInput } from '../../../src/mcp/strictInput.js'

const input = strictInput(
    { connection: z.string(), sql: z.string(), limit: z.number().optional() },
    { query: 'sql' }
)

describe('strictInput', () => {
    it('parses valid input and stays a plain object schema', () => {
        expect(input.parse({ connection: 'c', sql: 'SELECT 1' })).toEqual({
            connection: 'c',
            sql: 'SELECT 1'
        })
        expect(Object.keys(input.shape)).toEqual(['connection', 'sql', 'limit'])
    })

    it('names the right key for a known alias', () => {
        const result = input.safeParse({ connection: 'c', sql: 'x', query: 'x' })
        expect(result.success).toBe(false)
        expect(result.error?.issues[0].message).toBe("unknown key 'query' — did you mean 'sql'?")
    })

    it('lists the allowed keys for an unknown key without an alias', () => {
        const result = input.safeParse({ connection: 'c', sql: 'x', db: 'x' })
        expect(result.error?.issues[0].message).toBe(
            "unknown key 'db'; allowed keys: connection, sql, limit"
        )
    })

    it('does not treat Object.prototype names as aliases', () => {
        const result = input.safeParse({ connection: 'c', sql: 'x', constructor: 'x' })
        expect(result.error?.issues[0].message).toBe(
            "unknown key 'constructor'; allowed keys: connection, sql, limit"
        )
    })

    it('keeps the default messages for other issues', () => {
        const result = input.safeParse({ connection: 1, sql: 'x' })
        expect(result.error?.issues[0].message).toBe('Expected string, received number')
    })
})

describe('strictInput through a real MCP server', () => {
    let client: Client

    beforeEach(async () => {
        const server = new McpServer({ name: 'test', version: '0.0.0' })
        server.registerTool(
            'execute_sql',
            { description: 'run sql', inputSchema: input },
            async (args) => ({
                content: [{ type: 'text', text: JSON.stringify(args) }]
            })
        )
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        client = new Client({ name: 'test-client', version: '0.0.0' })
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    })

    afterEach(async () => {
        await client.close()
    })

    it('advertises the fields and additionalProperties: false', async () => {
        const { tools } = await client.listTools()
        const schema = tools[0].inputSchema
        expect(Object.keys(schema.properties ?? {})).toEqual(['connection', 'sql', 'limit'])
        expect(schema.required).toEqual(['connection', 'sql'])
        expect(schema.additionalProperties).toBe(false)
    })

    it('returns the hint as the tool error text when a wrong key is sent', async () => {
        const result = await client.callTool({
            name: 'execute_sql',
            arguments: { connection: 'c', sql: 'SELECT 1', query: 'SELECT 1' }
        })
        const content = result.content as Array<{ type: string; text: string }>
        expect(result.isError).toBe(true)
        // SDK >= 1.32 joins zod issue messages after its own prefix (1.29 sent the
        // whole ZodError as JSON), so the hint reaches the agent verbatim.
        expect(content[0].text).toBe(
            'MCP error -32602: Input validation error: Invalid arguments for tool execute_sql: ' +
                "unknown key 'query' — did you mean 'sql'?"
        )
    })
})
