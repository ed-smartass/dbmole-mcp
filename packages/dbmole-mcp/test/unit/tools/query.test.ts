import { LOST_CONNECTION_NOTE } from '@dbmole/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerQueryTools } from '../../../src/tools/query.js'
import { callTool, connectClient, type FakeManager, fakeManager } from '../helpers.js'

describe('execute_sql', () => {
    let manager: FakeManager
    let query: ReturnType<typeof vi.fn>
    let client: Awaited<ReturnType<typeof connectClient>>

    beforeEach(async () => {
        query = vi.fn(async () => ({
            columns: ['n'],
            rows: [[1]],
            rowCount: 1
        }))
        manager = fakeManager()
        manager.get.mockImplementation(async () => ({
            backend: { query },
            config: { name: 'c', type: 'postgres', host: 'h', user: 'u', readonly: false },
            source: 'global'
        }))
        const server = new McpServer({ name: 'test', version: '0.0.0' })
        registerQueryTools(server, manager)
        client = await connectClient(server)
    })

    it('executes sql and returns the result payload', async () => {
        const response = await callTool(client, 'execute_sql', {
            connection: 'c',
            sql: 'select 1 as n'
        })
        expect(response.isError).toBe(false)
        expect(response.json()).toEqual({
            columns: ['n'],
            rows: [[1]],
            rowCount: 1
        })
        expect(query).toHaveBeenCalledWith({
            sql: 'select 1 as n',
            params: [],
            database: undefined,
            rowLimit: 100
        })
    })

    it('passes params, database and clamped rowLimit through', async () => {
        await callTool(client, 'execute_sql', {
            connection: 'c',
            sql: 'select $1',
            params: [42],
            database: 'other',
            rowLimit: 5
        })
        expect(query).toHaveBeenCalledWith({
            sql: 'select $1',
            params: [42],
            database: 'other',
            rowLimit: 5
        })
    })

    it('formats driver errors with the engine prefix', async () => {
        query.mockRejectedValue(
            Object.assign(new Error('relation "x" does not exist'), { code: '42P01' })
        )
        const response = await callTool(client, 'execute_sql', { connection: 'c', sql: 'select' })
        expect(response.isError).toBe(true)
        expect(response.text).toBe('[postgres 42P01] relation "x" does not exist')
    })

    it('reports unknown connections without engine prefix', async () => {
        manager.get.mockRejectedValue(
            new Error("connection 'nope' not found. Available connections: c")
        )
        const response = await callTool(client, 'execute_sql', {
            connection: 'nope',
            sql: 'select 1'
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain("connection 'nope' not found")
    })
    it('advertises a strict schema with every field', async () => {
        const { tools } = await client.listTools()
        const tool = tools.find((t) => t.name === 'execute_sql')
        expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
            'connection',
            'sql',
            'params',
            'database',
            'rowLimit'
        ])
        expect(tool?.inputSchema.additionalProperties).toBe(false)
    })

    it('names the right key when a wrong one is used', async () => {
        const response = await callTool(client, 'execute_sql', {
            connection: 'c',
            query: 'select 1'
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain("unknown key 'query' — did you mean 'sql'?")
        expect(query).not.toHaveBeenCalled()
    })

    it('reports a lost connection without replaying the statement', async () => {
        query.mockRejectedValue(
            Object.assign(new Error('Connection lost: The server closed the connection.'), {
                code: 'PROTOCOL_CONNECTION_LOST'
            })
        )
        const response = await callTool(client, 'execute_sql', {
            connection: 'c',
            sql: 'insert into t values (1)'
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain(LOST_CONNECTION_NOTE)
        expect(query).toHaveBeenCalledTimes(1)
        expect(manager.invalidate).toHaveBeenCalledWith('c')
    })
})
