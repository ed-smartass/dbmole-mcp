import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pkg from '../../package.json' with { type: 'json' }
import { createServer, SERVER_VERSION } from '../../src/server.js'
import { createDbRegistry } from '../../src/wiring.js'
import { connectClient, fakeManager } from './helpers.js'

describe('createServer', () => {
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'dbmole-server-'))
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('reports the package version over MCP', () => {
        expect(SERVER_VERSION).toBe(pkg.version)
    })

    it('publishes a typed inputSchema for add_connection, not an empty object', async () => {
        const registry = createDbRegistry({
            cwd: dir,
            env: { DBMOLE_STORE: join(dir, 'connections.json') }
        })
        const server = createServer(registry, fakeManager())
        const client = await connectClient(server)
        const { tools } = await client.listTools()
        const add = tools.find((tool) => tool.name === 'add_connection')
        const schema = add?.inputSchema
        expect(Object.keys(schema?.properties ?? {})).toEqual(
            expect.arrayContaining(['name', 'host', 'port', 'user', 'password', 'type', 'database'])
        )
        expect(schema?.required ?? []).toEqual(expect.arrayContaining(['name', 'host', 'type']))
        expect(schema?.additionalProperties).toBe(false)
        await client.close()
    })

    it('registers all nine tools', async () => {
        const registry = createDbRegistry({
            cwd: dir,
            env: { DBMOLE_STORE: join(dir, 'connections.json') }
        })
        const server = createServer(registry, fakeManager())
        const client = await connectClient(server)
        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'add_connection',
            'describe_table',
            'execute_sql',
            'list_connections',
            'list_databases',
            'list_tables',
            'remove_connection',
            'test_connection',
            'update_connection'
        ])
    })
})
