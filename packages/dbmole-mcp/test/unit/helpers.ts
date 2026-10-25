import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type Mock, vi } from 'vitest'
import type { DbManager } from '../../src/wiring.js'

export type ToolResponse = {
    isError: boolean
    text: string
    json: () => unknown
}

// Manager whose methods are also vitest mocks — no `as unknown as Manager` casts in tests.
export type FakeManager = DbManager & {
    get: Mock
    invalidate: Mock
    disposeAll: Mock
}

export const fakeManager = (): FakeManager => ({
    get: vi.fn(),
    invalidate: vi.fn(async () => {}),
    disposeAll: vi.fn(async () => {})
})

export const connectClient = async (server: McpServer): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
}

export const callTool = async (
    client: Client,
    name: string,
    args: Record<string, unknown> = {}
): Promise<ToolResponse> => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text: string }>
    const text = content?.[0]?.text ?? ''
    return {
        isError: Boolean(result.isError),
        text,
        json: () => JSON.parse(text)
    }
}
