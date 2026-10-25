import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSchemaTools } from '../../../src/tools/schema.js'
import { callTool, connectClient, type FakeManager, fakeManager } from '../helpers.js'

describe('schema tools', () => {
    let driver: {
        listDatabases: ReturnType<typeof vi.fn>
        listTables: ReturnType<typeof vi.fn>
        describeTable: ReturnType<typeof vi.fn>
    }
    let manager: FakeManager
    let client: Awaited<ReturnType<typeof connectClient>>

    beforeEach(async () => {
        driver = {
            listDatabases: vi.fn(async () => [{ name: 'app', sizeBytes: 1024 }]),
            listTables: vi.fn(async () => [
                { schema: 'public', name: 'users', type: 'table', rowEstimate: 5 }
            ]),
            describeTable: vi.fn(async () => ({
                columns: [{ name: 'id', type: 'integer', nullable: false, default: null }],
                primaryKey: ['id'],
                indexes: [],
                foreignKeys: []
            }))
        }
        manager = fakeManager()
        manager.get.mockImplementation(async () => ({
            backend: driver,
            config: { name: 'c', type: 'postgres', host: 'h', user: 'u', readonly: false },
            source: 'global'
        }))
        const server = new McpServer({ name: 'test', version: '0.0.0' })
        registerSchemaTools(server, manager)
        client = await connectClient(server)
    })

    it('list_databases returns database info', async () => {
        const response = await callTool(client, 'list_databases', { connection: 'c' })
        expect(response.isError).toBe(false)
        expect(response.json()).toEqual([{ name: 'app', sizeBytes: 1024 }])
    })

    it('list_tables forwards database and schema filters', async () => {
        const response = await callTool(client, 'list_tables', {
            connection: 'c',
            database: 'db',
            schema: 'public'
        })
        expect(response.isError).toBe(false)
        expect(driver.listTables).toHaveBeenCalledWith({ database: 'db', schema: 'public' })
        expect(response.json()).toEqual([
            { schema: 'public', name: 'users', type: 'table', rowEstimate: 5 }
        ])
    })

    it('describe_table forwards args and returns the description', async () => {
        const response = await callTool(client, 'describe_table', {
            connection: 'c',
            table: 'users'
        })
        expect(response.isError).toBe(false)
        expect(driver.describeTable).toHaveBeenCalledWith({
            table: 'users',
            database: undefined,
            schema: undefined
        })
        expect((response.json() as { primaryKey: string[] }).primaryKey).toEqual(['id'])
    })

    it('formats driver errors', async () => {
        driver.describeTable.mockRejectedValue(new Error("table 'public.ghost' not found"))
        const response = await callTool(client, 'describe_table', {
            connection: 'c',
            table: 'ghost'
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain('not found')
    })

    it('reports manager errors per tool', async () => {
        manager.get.mockRejectedValue(new Error('no such connection'))
        for (const [tool, args] of [
            ['list_databases', { connection: 'x' }],
            ['list_tables', { connection: 'x' }],
            ['describe_table', { connection: 'x', table: 't' }]
        ] as const) {
            const response = await callTool(client, tool, args as Record<string, unknown>)
            expect(response.isError).toBe(true)
            expect(response.text).toContain('no such connection')
        }
    })
    it('replays list_tables once after a lost connection', async () => {
        driver.listTables.mockRejectedValueOnce(
            Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        )
        const response = await callTool(client, 'list_tables', { connection: 'c' })
        expect(response.isError).toBe(false)
        expect(driver.listTables).toHaveBeenCalledTimes(2)
        expect(manager.invalidate).toHaveBeenCalledWith('c')
    })

    it('replays describe_table once after a lost connection', async () => {
        driver.describeTable.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
        const response = await callTool(client, 'describe_table', {
            connection: 'c',
            table: 'users'
        })
        expect(response.isError).toBe(false)
        expect(driver.describeTable).toHaveBeenCalledTimes(2)
    })

    it('names the right key on describe_table', async () => {
        const response = await callTool(client, 'describe_table', {
            connection: 'c',
            name: 'users'
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain("unknown key 'name' — did you mean 'table'?")
        expect(driver.describeTable).not.toHaveBeenCalled()
    })

    it('lists allowed keys for an unknown key without an alias', async () => {
        const response = await callTool(client, 'list_databases', {
            connection: 'c',
            verbose: true
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain("unknown key 'verbose'; allowed keys: connection")
    })
})
