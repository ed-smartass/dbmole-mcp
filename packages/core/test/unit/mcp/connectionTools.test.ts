import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { type Backend, BackendDisposedError } from '../../../src/backend.js'
import type { LayerName, ResolvedConnection } from '../../../src/config/baseSchema.js'
import { isGitIgnored } from '../../../src/config/projectFile.js'
import type { Registry } from '../../../src/config/registry.js'
import { RegistryError } from '../../../src/config/registry.js'
import type { ManagedConnection, Manager } from '../../../src/manager.js'
import {
    type ConnectionToolsDeps,
    registerConnectionTools
} from '../../../src/mcp/connectionTools.js'

// Tiny inline config + schema: name/type plus a readonly default so the schema's
// input type (readonly optional) differs from its output, exercising the
// z.ZodType<TConfig, ZodTypeDef, unknown> input-variance contract.
const schema = z
    .object({
        name: z.string(),
        type: z.enum(['postgres', 'mysql']),
        host: z.string(),
        readonly: z.boolean().default(false)
    })
    .strict()

type TestConfig = z.infer<typeof schema>
type TestBackend = Backend & { ping: () => Promise<string> }
type TestManaged = ManagedConnection<TestConfig, TestBackend>

vi.mock('../../../src/config/projectFile.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/config/projectFile.js')>()),
    isGitIgnored: vi.fn()
}))

const resolved = (
    config: TestConfig,
    source: LayerName = 'global'
): ResolvedConnection<TestConfig> => ({
    config,
    source,
    hash: 'h'
})

const publicView = (r: ResolvedConnection<TestConfig>): Record<string, unknown> => ({
    name: r.config.name,
    type: r.config.type,
    host: r.config.host,
    readonly: r.config.readonly,
    source: r.source
})

type FakeRegistry = Registry<TestConfig> & {
    list: ReturnType<typeof vi.fn>
    resolve: ReturnType<typeof vi.fn>
    add: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    paths: ReturnType<typeof vi.fn>
}

const fakeRegistry = (): FakeRegistry => ({
    list: vi.fn(() => ({ connections: [], brokenLayers: [] })),
    resolve: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(() => ({ notes: [] })),
    paths: vi.fn(() => ({ project: '/repo/.test.json', global: '/home/store.json' }))
})

type FakeManager = Manager<TestConfig, TestBackend> & {
    get: ReturnType<typeof vi.fn>
    invalidate: ReturnType<typeof vi.fn>
    disposeAll: ReturnType<typeof vi.fn>
}

const fakeManager = (): FakeManager => ({
    get: vi.fn(),
    invalidate: vi.fn(async () => {}),
    disposeAll: vi.fn(async () => {})
})

const managed = (ping: () => Promise<string>): TestManaged => ({
    backend: { dispose: vi.fn(async () => {}), ping },
    config: { name: 'c', type: 'postgres', host: 'h', readonly: false },
    source: 'global'
})

const formatError = (config: TestConfig, error: unknown): string =>
    '[' + config.type + '] ' + (error instanceof Error ? error.message : String(error))

const descriptions = {
    list: 'list desc',
    add: 'add desc',
    update: 'update desc',
    remove: 'remove desc',
    test: 'test desc'
}

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>

const text = (result: CallToolResult): string => {
    const first = result.content[0]
    return first && first.type === 'text' ? first.text : ''
}

describe('registerConnectionTools', () => {
    let registry: FakeRegistry
    let manager: FakeManager
    let handlers: Map<string, Handler>
    let configs: Map<string, { description?: string; inputSchema?: unknown }>

    const invoke = (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
        const handler = handlers.get(name)
        if (!handler) {
            throw new Error('tool not registered: ' + name)
        }
        return handler(args)
    }

    const register = (overrides: Partial<ConnectionToolsDeps<TestConfig, TestBackend>> = {}) => {
        const server = new McpServer({ name: 'test', version: '0.0.0' })
        handlers = new Map()
        configs = new Map()
        vi.spyOn(server, 'registerTool').mockImplementation(
            (
                name: string,
                config: { description?: string; inputSchema?: unknown },
                handler: unknown
            ) => {
                configs.set(name, config)
                handlers.set(name, handler as Handler)
                return {
                    enable: vi.fn(),
                    disable: vi.fn(),
                    update: vi.fn(),
                    remove: vi.fn()
                } as never
            }
        )
        registerConnectionTools(server, {
            registry,
            manager,
            fullSchema: schema,
            patchSchema: z.object({ host: z.string().optional() }).strict(),
            publicView,
            ping: async (m) => ({ version: await m.backend.ping() }),
            formatError,
            descriptions,
            ...overrides
        })
    }

    beforeEach(() => {
        registry = fakeRegistry()
        manager = fakeManager()
        vi.mocked(isGitIgnored).mockReturnValue(true)
    })

    it('registers all five connection tools with their descriptions', () => {
        register()
        expect([...handlers.keys()].sort()).toEqual([
            'add_connection',
            'list_connections',
            'remove_connection',
            'test_connection',
            'update_connection'
        ])
        expect(configs.get('list_connections')?.description).toBe('list desc')
        expect(configs.get('add_connection')?.description).toBe('add desc')
        expect(configs.get('update_connection')?.description).toBe('update desc')
        expect(configs.get('remove_connection')?.description).toBe('remove desc')
        expect(configs.get('test_connection')?.description).toBe('test desc')
    })

    it('list_connections renders valid, shadowing, invalid and broken entries', async () => {
        registry.list.mockReturnValue({
            connections: [
                {
                    ok: true,
                    resolved: resolved({ name: 'a', type: 'postgres', host: 'ha', readonly: false })
                },
                {
                    ok: true,
                    resolved: resolved(
                        { name: 'b', type: 'mysql', host: 'hb', readonly: true },
                        'project'
                    ),
                    shadows: 'global'
                },
                { ok: false, name: 'c', source: 'project', error: "connection 'c' is invalid" }
            ],
            brokenLayers: [{ layer: 'global', path: '/home/store.json', error: 'bad json' }]
        })
        register()

        const result = await invoke('list_connections')

        expect(result.isError).toBeFalsy()
        expect(JSON.parse(text(result))).toEqual({
            connections: [
                { name: 'a', type: 'postgres', host: 'ha', readonly: false, source: 'global' },
                {
                    name: 'b',
                    type: 'mysql',
                    host: 'hb',
                    readonly: true,
                    source: 'project',
                    shadows: 'global'
                },
                { name: 'c', source: 'project', invalid: "connection 'c' is invalid" }
            ],
            brokenLayers: [{ layer: 'global', path: '/home/store.json', error: 'bad json' }]
        })
    })

    it('add_connection defaults to the global scope and reports notes', async () => {
        registry.add.mockImplementation((config: TestConfig, scope: LayerName) => ({
            resolved: resolved(config, scope),
            notes: ['a note']
        }))
        register()

        const result = await invoke('add_connection', { name: 'fresh', type: 'mysql', host: 'db' })

        expect(result.isError).toBeFalsy()
        expect(registry.add).toHaveBeenCalledWith(
            { name: 'fresh', type: 'mysql', host: 'db', readonly: false },
            'global'
        )
        expect(JSON.parse(text(result))).toEqual({
            added: { name: 'fresh', type: 'mysql', host: 'db', readonly: false, source: 'global' },
            notes: ['a note']
        })
        expect(isGitIgnored).not.toHaveBeenCalled()
    })

    it('add_connection with scope project warns when the file is not git-ignored', async () => {
        registry.add.mockImplementation((config: TestConfig, scope: LayerName) => ({
            resolved: resolved(config, scope),
            notes: []
        }))
        vi.mocked(isGitIgnored).mockReturnValue(undefined)
        register()

        const result = await invoke('add_connection', {
            name: 'fresh',
            type: 'mysql',
            host: 'db',
            scope: 'project'
        })

        expect(registry.add).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'fresh' }),
            'project'
        )
        expect(isGitIgnored).toHaveBeenCalledWith('/repo/.test.json')
        expect(JSON.parse(text(result)).warnings).toEqual([
            '/repo/.test.json is not ignored by git; add it to .gitignore so credentials are not committed'
        ])
    })

    it('add_connection with scope project omits warnings when the file is ignored', async () => {
        registry.add.mockImplementation((config: TestConfig, scope: LayerName) => ({
            resolved: resolved(config, scope),
            notes: []
        }))
        register()

        const result = await invoke('add_connection', {
            name: 'fresh',
            type: 'mysql',
            host: 'db',
            scope: 'project'
        })

        expect(JSON.parse(text(result))).not.toHaveProperty('warnings')
    })

    it('add_connection advertises fullSchema plus scope, still strict', () => {
        register()
        const advertised = configs.get('add_connection')?.inputSchema
        if (!(advertised instanceof z.ZodObject)) {
            throw new Error('add_connection inputSchema is not a ZodObject')
        }
        expect(Object.keys(advertised.shape).sort()).toEqual([
            'host',
            'name',
            'readonly',
            'scope',
            'type'
        ])
        expect(
            advertised.safeParse({ name: 'x', type: 'mysql', host: 'h', bogus: 1 }).success
        ).toBe(false)
    })

    it('add_connection reports a duplicate error from the registry', async () => {
        registry.add.mockImplementation(() => {
            throw new RegistryError("connection 'fresh' already exists in global (/s.json)")
        })
        register()

        const result = await invoke('add_connection', {
            name: 'fresh',
            type: 'mysql',
            host: 'db'
        })

        expect(result.isError).toBe(true)
        expect(text(result)).toContain('already exists')
    })

    it('add_connection applies parseSchema in the handler', async () => {
        const parseSchema = schema.superRefine((c, ctx) => {
            if (c.host === 'bad') {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bad host' })
            }
        })
        registry.add.mockImplementation((config: TestConfig) => ({
            resolved: resolved(config),
            notes: []
        }))
        register({ parseSchema })

        const rejected = await invoke('add_connection', { name: 'x', type: 'mysql', host: 'bad' })
        expect(rejected.isError).toBe(true)
        expect(text(rejected)).toContain('bad host')
        expect(registry.add).not.toHaveBeenCalled()

        const accepted = await invoke('add_connection', { name: 'y', type: 'mysql', host: 'good' })
        expect(accepted.isError).toBeFalsy()
        expect(registry.add).toHaveBeenCalledWith(
            { name: 'y', type: 'mysql', host: 'good', readonly: false },
            'global'
        )
    })

    it('update_connection patches, invalidates the cache and returns view plus notes', async () => {
        registry.update.mockReturnValue({
            resolved: resolved({ name: 'c', type: 'postgres', host: 'new', readonly: false }),
            notes: []
        })
        register()

        const result = await invoke('update_connection', {
            name: 'c',
            patch: { host: 'new' }
        })

        expect(result.isError).toBeFalsy()
        expect(registry.update).toHaveBeenCalledWith('c', { host: 'new' })
        expect(manager.invalidate).toHaveBeenCalledWith('c')
        expect(JSON.parse(text(result))).toMatchObject({ updated: { host: 'new' }, notes: [] })
    })

    it('update_connection surfaces registry errors and does not invalidate', async () => {
        registry.update.mockImplementation(() => {
            throw new RegistryError("connection 'c' in /p.json is invalid: bad")
        })
        register()

        const result = await invoke('update_connection', { name: 'c', patch: {} })

        expect(result.isError).toBe(true)
        expect(text(result)).toContain('is invalid')
        expect(manager.invalidate).not.toHaveBeenCalled()
    })

    it('remove_connection deletes, invalidates the cache and reports notes', async () => {
        registry.remove.mockReturnValue({ notes: ["global connection 'c' in /g is now active"] })
        register()

        const result = await invoke('remove_connection', { name: 'c' })

        expect(result.isError).toBeFalsy()
        expect(registry.remove).toHaveBeenCalledWith('c')
        expect(manager.invalidate).toHaveBeenCalledWith('c')
        expect(JSON.parse(text(result))).toEqual({
            removed: 'c',
            notes: ["global connection 'c' in /g is now active"]
        })
    })

    it('remove_connection reports registry errors', async () => {
        registry.remove.mockImplementation(() => {
            throw new RegistryError('not found')
        })
        register()

        const result = await invoke('remove_connection', { name: 'ghost' })

        expect(result.isError).toBe(true)
        expect(text(result)).toContain('not found')
    })

    it('test_connection reports ping info plus latency', async () => {
        manager.get.mockResolvedValue(managed(vi.fn(async () => '17.2')))
        register()

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBeFalsy()
        const payload = JSON.parse(text(result)) as Record<string, unknown>
        expect(payload.ok).toBe(true)
        expect(payload.version).toBe('17.2')
        expect(typeof payload.latencyMs).toBe('number')
    })

    it('test_connection retries once when the backend was disposed under it', async () => {
        const ping = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new BackendDisposedError())
            .mockResolvedValueOnce('17.2')
        manager.get.mockResolvedValue(managed(ping))
        register()

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBeFalsy()
        expect((JSON.parse(text(result)) as Record<string, unknown>).version).toBe('17.2')
        expect(manager.get).toHaveBeenCalledTimes(2)
    })

    it('test_connection formats backend failures via formatError', async () => {
        manager.get.mockResolvedValue(
            managed(
                vi.fn(async () => {
                    throw new Error('connect ECONNREFUSED')
                })
            )
        )
        register()

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('[postgres] connect ECONNREFUSED')
    })

    it('test_connection formats the error after a second disposal (no further retry)', async () => {
        // First disposal triggers one rebuild; the second is on attempt 1, where the
        // retry guard (attempt === 0) no longer holds, so formatError is reported.
        manager.get.mockResolvedValue(
            managed(
                vi.fn(async () => {
                    throw new BackendDisposedError()
                })
            )
        )
        register()

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe(
            '[postgres] connection was reconfigured or removed: retry the call'
        )
        expect(manager.get).toHaveBeenCalledTimes(2)
    })

    it('test_connection reports manager.get failures plainly', async () => {
        manager.get.mockRejectedValue(new Error('ssh auth failed'))
        register()

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('ssh auth failed')
    })

    it('test_connection invalidates and pings once more after a lost connection', async () => {
        const lost = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        const ping = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(lost)
            .mockResolvedValue('17.2')
        manager.get.mockResolvedValue(managed(ping))
        register({ isLostConnection: (error) => error === lost })

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBeFalsy()
        expect(manager.invalidate).toHaveBeenCalledWith('c')
        expect(manager.get).toHaveBeenCalledTimes(2)
    })

    it('test_connection reports a connection lost twice via formatError', async () => {
        const lost = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        manager.get.mockResolvedValue(managed(vi.fn(async () => Promise.reject(lost))))
        register({ isLostConnection: (error) => error === lost })

        const result = await invoke('test_connection', { name: 'c' })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('[postgres] read ECONNRESET')
        expect(manager.invalidate).toHaveBeenCalledTimes(2)
    })
})
