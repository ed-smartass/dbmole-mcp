import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendDisposedError, writeLayerFile } from '@dbmole/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../../src/schema.js'
import { registerConnectionTools } from '../../../src/tools/connections.js'
import { createDbRegistry } from '../../../src/wiring.js'
import { callTool, connectClient, type FakeManager, fakeManager } from '../helpers.js'

const conn = (name: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    name,
    type: 'postgres',
    host: 'localhost',
    user: 'postgres',
    readonly: false,
    ...extra
})

type Listed = { connections: Array<Record<string, unknown>> }

const names = (response: { json: () => unknown }): unknown[] =>
    (response.json() as Listed).connections.map((c) => c.name)

describe('connection tools', () => {
    let dir: string
    let storePath: string
    let manager: FakeManager
    let client: Awaited<ReturnType<typeof connectClient>>

    beforeEach(async () => {
        // Its own git root, so an enclosing repo or symlinked tmpdir can't move the project file.
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'dbmole-tools-')))
        execFileSync('git', ['init', '-q', dir])
        storePath = join(dir, 'connections.json')
        writeLayerFile(storePath, 'array', [
            conn('existing', { password: 'secret', database: 'app' })
        ])
        const registry = createDbRegistry({ cwd: dir, env: { DBMOLE_STORE: storePath } })
        manager = fakeManager()
        const server = new McpServer({ name: 'test', version: '0.0.0' })
        registerConnectionTools(server, registry, manager)
        client = await connectClient(server)
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('list_connections returns public view without secrets', async () => {
        const response = await callTool(client, 'list_connections')
        expect(response.isError).toBe(false)
        expect(response.json()).toEqual({
            connections: [
                {
                    name: 'existing',
                    type: 'postgres',
                    host: 'localhost',
                    port: 5432,
                    database: 'app',
                    readonly: false,
                    source: 'global',
                    ssh: false
                }
            ],
            brokenLayers: []
        })
        expect(response.text).not.toContain('secret')
    })

    it('add_connection persists and reports the new connection', async () => {
        const response = await callTool(client, 'add_connection', {
            name: 'fresh',
            type: 'mysql',
            host: 'db',
            user: 'root'
        })
        expect(response.isError).toBe(false)
        const list = await callTool(client, 'list_connections')
        expect(names(list)).toEqual(['existing', 'fresh'])
    })

    it('add_connection with scope project writes .dbmole.json in cwd and warns', async () => {
        const response = await callTool(client, 'add_connection', {
            name: 'local',
            type: 'postgres',
            host: 'db',
            user: 'u',
            scope: 'project'
        })
        expect(response.isError).toBe(false)
        const payload = response.json() as { added: { source: string }; warnings: string[] }
        expect(payload.added.source).toBe('project')
        expect(payload.warnings[0]).toContain(join(dir, '.dbmole.json') + ' is not ignored by git')
        expect(JSON.parse(readFileSync(join(dir, '.dbmole.json'), 'utf8')).connections).toEqual([
            conn('local', { host: 'db', user: 'u' })
        ])
    })

    it('add_connection rejects unknown fields', async () => {
        const response = await callTool(client, 'add_connection', {
            name: 'typo',
            type: 'postgres',
            host: 'h',
            user: 'u',
            readOnly: true
        })
        expect(response.isError).toBe(true)
        const list = await callTool(client, 'list_connections')
        expect(names(list)).not.toContain('typo')
    })

    it('add_connection rejects duplicates with isError', async () => {
        const response = await callTool(client, 'add_connection', {
            name: 'existing',
            type: 'postgres',
            host: 'x',
            user: 'u'
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain('already exists')
    })

    it('update_connection patches and invalidates the manager cache', async () => {
        const response = await callTool(client, 'update_connection', {
            name: 'existing',
            patch: { host: 'new-host', database: null }
        })
        expect(response.isError).toBe(false)
        expect(manager.invalidate).toHaveBeenCalledWith('existing')
        const list = await callTool(client, 'list_connections')
        const updated = (list.json() as Listed).connections[0]
        expect(updated.host).toBe('new-host')
        expect(updated.database).toBeNull()
    })

    it('update_connection merges an ssh patch, keeping stored secrets', async () => {
        await callTool(client, 'update_connection', {
            name: 'existing',
            patch: { ssh: { host: 'bastion', user: 'tunnel', password: 'sshpw' } }
        })
        const hostKey = 'SHA256:y7R/XB69YxB33LfH4yzcb8uck0tqIZXt8iwwSZ5SuZo'
        const response = await callTool(client, 'update_connection', {
            name: 'existing',
            patch: { ssh: { hostKey } }
        })
        expect(response.isError).toBe(false)
        const stored = JSON.parse(readFileSync(storePath, 'utf8'))
        expect(stored[0].ssh).toEqual({
            host: 'bastion',
            port: 22,
            user: 'tunnel',
            password: 'sshpw',
            hostKey
        })
    })

    it('update_connection surfaces validation errors', async () => {
        const response = await callTool(client, 'update_connection', {
            name: 'existing',
            patch: { type: 'oracle' }
        })
        expect(response.isError).toBe(true)
    })

    it('remove_connection deletes and invalidates', async () => {
        const response = await callTool(client, 'remove_connection', { name: 'existing' })
        expect(response.isError).toBe(false)
        expect(manager.invalidate).toHaveBeenCalledWith('existing')
        const list = await callTool(client, 'list_connections')
        expect(names(list)).toEqual([])
    })

    it('remove_connection of unknown name reports available connections', async () => {
        const response = await callTool(client, 'remove_connection', { name: 'ghost' })
        expect(response.isError).toBe(true)
        expect(response.text).toContain('existing')
    })

    it('test_connection reports version and latency', async () => {
        manager.get.mockResolvedValue({
            backend: { serverVersion: vi.fn(async () => '17.2') },
            config: conn('existing'),
            source: 'global'
        })
        const response = await callTool(client, 'test_connection', { name: 'existing' })
        expect(response.isError).toBe(false)
        const payload = response.json() as Record<string, unknown>
        expect(payload.ok).toBe(true)
        expect(payload.version).toBe('17.2')
        expect(typeof payload.latencyMs).toBe('number')
    })

    it('test_connection retries once when the driver was disposed under it', async () => {
        const serverVersion = vi
            .fn()
            .mockRejectedValueOnce(new BackendDisposedError())
            .mockResolvedValueOnce('17.2')
        manager.get.mockResolvedValue({
            backend: { serverVersion },
            config: conn('existing'),
            source: 'global'
        })
        const response = await callTool(client, 'test_connection', { name: 'existing' })
        expect(response.isError).toBe(false)
        const payload = response.json() as Record<string, unknown>
        expect(payload.ok).toBe(true)
        expect(payload.version).toBe('17.2')
        expect(manager.get).toHaveBeenCalledTimes(2)
    })

    it('test_connection formats driver failures', async () => {
        manager.get.mockResolvedValue({
            backend: {
                serverVersion: vi.fn(async () => {
                    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
                })
            },
            config: conn('existing'),
            source: 'global'
        })
        const response = await callTool(client, 'test_connection', { name: 'existing' })
        expect(response.isError).toBe(true)
        expect(response.text).toContain('ECONNREFUSED')
    })

    it('test_connection reports manager failures (e.g. tunnel)', async () => {
        manager.get.mockRejectedValue(new Error('ssh auth failed'))
        const response = await callTool(client, 'test_connection', { name: 'existing' })
        expect(response.isError).toBe(true)
        expect(response.text).toContain('ssh auth failed')
    })

    it('update_connection sets and clears queryTimeoutMs', async () => {
        const timedDir = mkdtempSync(join(tmpdir(), 'dbmole-timeout-'))
        try {
            const registry = createDbRegistry({
                cwd: timedDir,
                env: { DBMOLE_STORE: join(timedDir, 'store.json') }
            })
            registry.add(conn('timed'), 'global')
            const server = new McpServer({ name: 'test', version: '0.0.0' })
            registerConnectionTools(server, registry, fakeManager())
            const timedClient = await connectClient(server)

            const set = await callTool(timedClient, 'update_connection', {
                name: 'timed',
                patch: { queryTimeoutMs: 5000 }
            })
            expect(set.isError).toBe(false)
            expect(registry.resolve('timed').config.queryTimeoutMs).toBe(5000)

            const cleared = await callTool(timedClient, 'update_connection', {
                name: 'timed',
                patch: { queryTimeoutMs: null }
            })
            expect(cleared.isError).toBe(false)
            expect(registry.resolve('timed').config.queryTimeoutMs).toBeUndefined()

            const invalid = await callTool(timedClient, 'update_connection', {
                name: 'timed',
                patch: { queryTimeoutMs: 0 }
            })
            expect(invalid.isError).toBe(true)

            const tooBig = await callTool(timedClient, 'update_connection', {
                name: 'timed',
                patch: { queryTimeoutMs: 2 ** 31 }
            })
            expect(tooBig.isError).toBe(true)

            const max = await callTool(timedClient, 'update_connection', {
                name: 'timed',
                patch: { queryTimeoutMs: 2 ** 31 - 1 }
            })
            expect(max.isError).toBe(false)
            expect(registry.resolve('timed').config.queryTimeoutMs).toBe(2 ** 31 - 1)

            // The cap is advertised, not only enforced by the registry re-validation.
            const { tools } = await timedClient.listTools()
            const update = tools.find((t) => t.name === 'update_connection')
            expect(update?.inputSchema.properties?.patch).toMatchObject({
                properties: {
                    queryTimeoutMs: {
                        anyOf: [{ type: 'integer', maximum: 2_147_483_647 }, { type: 'null' }]
                    }
                }
            })
        } finally {
            rmSync(timedDir, { recursive: true, force: true })
        }
    })

    it('add_connection advertises ssl', async () => {
        const { tools } = await client.listTools()
        const add = tools.find((t) => t.name === 'add_connection')
        expect(Object.keys(add?.inputSchema.properties ?? {})).toContain('ssl')
    })

    it('add_connection rejects mysql TLS verification against an IP host', async () => {
        const response = await callTool(client, 'add_connection', {
            name: 'tls-ip',
            type: 'mysql',
            host: '10.0.0.5',
            user: 'root',
            ssl: true
        })
        expect(response.isError).toBe(true)
        expect(response.text).toContain('use a hostname, or set ssl.rejectUnauthorized: false')
    })

    it('update_connection can set and clear ssl', async () => {
        const set = await callTool(client, 'update_connection', {
            name: 'existing',
            patch: { ssl: { rejectUnauthorized: false } }
        })
        expect(set.isError).toBe(false)
        expect(JSON.parse(readFileSync(storePath, 'utf8'))[0].ssl).toEqual({
            rejectUnauthorized: false
        })
        const cleared = await callTool(client, 'update_connection', {
            name: 'existing',
            patch: { ssl: null }
        })
        expect(cleared.isError).toBe(false)
        expect(JSON.parse(readFileSync(storePath, 'utf8'))[0]).not.toHaveProperty('ssl')
    })
})
