import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Backend, BackendDisposedError, type BackendTarget } from '../../src/backend.js'
import type { ResolvedConnection, SshConfig } from '../../src/config/baseSchema.js'
import { ConnectionNotFoundError, type Registry, RegistryError } from '../../src/config/registry.js'
import { createManager } from '../../src/manager.js'
import type { Tunnel } from '../../src/net/tunnel.js'

// Minimal config the generic manager needs: name/host/ssh plus the fields the
// injected resolvePort reads (type/port). It is not a real dbmole schema — the
// manager is engine-agnostic and only sees what the deps pull off the config.
type TestConfig = {
    name: string
    host: string
    type: 'postgres' | 'mysql'
    port?: number
    ssh?: SshConfig
}

type TestResolved = ResolvedConnection<TestConfig>
type TestRegistry = Registry<TestConfig>

const config = (extra: Partial<TestConfig> = {}): TestConfig => ({
    name: 'c',
    type: 'postgres',
    host: 'db-host',
    ...extra
})

const defaultPort = (type: TestConfig['type']): number => (type === 'postgres' ? 5432 : 3306)
const resolvePort = (cfg: TestConfig): number => cfg.port ?? defaultPort(cfg.type)

type FakeBackend = Backend & { disposed: boolean }

const fakeBackend = (): FakeBackend => {
    const backend: FakeBackend = {
        disposed: false,
        dispose: vi.fn(async () => {
            backend.disposed = true
        })
    }
    return backend
}

type FakeTunnel = Tunnel & { closed: boolean }

describe('BackendDisposedError', () => {
    it('carries a retryable message and a stable name', () => {
        const error = new BackendDisposedError()
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe('BackendDisposedError')
        expect(error.message).toContain('retry the call')
    })
})

describe('createManager', () => {
    let resolved: TestResolved
    let registry: TestRegistry
    let backends: FakeBackend[]
    let targets: BackendTarget<TestConfig>[]
    let tunnels: FakeTunnel[]
    let createBackend: (target: BackendTarget<TestConfig>) => FakeBackend
    let createTunnel: ReturnType<typeof vi.fn>

    beforeEach(() => {
        resolved = { config: config(), source: 'global', hash: 'h1' }
        registry = {
            list: vi.fn(() => ({ connections: [], brokenLayers: [] })),
            resolve: vi.fn(() => resolved),
            add: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
            paths: vi.fn(() => ({ project: '/p', global: '/g' }))
        }
        backends = []
        targets = []
        tunnels = []
        createBackend = (target: BackendTarget<TestConfig>) => {
            targets.push(target)
            const backend = fakeBackend()
            backends.push(backend)
            return backend
        }
        createTunnel = vi.fn(async () => {
            const tunnel: FakeTunnel = {
                localHost: '127.0.0.1',
                localPort: 54321,
                closed: false,
                isClosed: () => tunnel.closed,
                close: async () => {
                    tunnel.closed = true
                }
            }
            tunnels.push(tunnel)
            return tunnel
        })
    })

    const sshExtra = (): { ssh: SshConfig } => ({
        ssh: { host: 'bastion', port: 22, user: 'root', password: 'x' }
    })

    it('builds lazily and caches by hash', async () => {
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        const first = await manager.get('c')
        const second = await manager.get('c')
        expect(first.backend).toBe(second.backend)
        expect(backends).toHaveLength(1)
        expect(targets[0]).toMatchObject({ connectHost: 'db-host', connectPort: 5432 })
        expect(createTunnel).not.toHaveBeenCalled()
    })

    it('rebuilds and disposes the old backend when the hash changes', async () => {
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        const first = await manager.get('c')
        resolved = { config: config({ port: 9999 }), source: 'global', hash: 'h2' }
        const second = await manager.get('c')
        expect(second.backend).not.toBe(first.backend)
        expect(backends[0].disposed).toBe(true)
        expect(targets[1]).toMatchObject({ connectPort: 9999 })
    })

    it('routes through the tunnel endpoint when ssh is configured', async () => {
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        expect(createTunnel).toHaveBeenCalledWith(
            expect.objectContaining({ host: 'bastion' }),
            'db-host',
            5432
        )
        expect(targets[0]).toMatchObject({ connectHost: '127.0.0.1', connectPort: 54321 })
    })

    it('passes the logical remote host as serverName', async () => {
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        expect(targets[0]).toMatchObject({ connectHost: '127.0.0.1', serverName: 'db-host' })
    })

    it('uses the engine default port for mysql', async () => {
        resolved = { config: config({ type: 'mysql' }), source: 'global', hash: 'm1' }
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        expect(targets[0]).toMatchObject({ connectPort: 3306 })
    })

    it('rebuilds when the tunnel reports closed', async () => {
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        const first = await manager.get('c')
        tunnels[0].closed = true
        const second = await manager.get('c')
        expect(second.backend).not.toBe(first.backend)
        expect(backends[0].disposed).toBe(true)
        expect(tunnels).toHaveLength(2)
        expect(second.backend).toBe(backends[1])
    })

    it('deduplicates concurrent builds', async () => {
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        const [a, b] = await Promise.all([manager.get('c'), manager.get('c')])
        expect(a.backend).toBe(b.backend)
        expect(backends).toHaveLength(1)
    })

    it('clears the cache when a build fails, allowing retry', async () => {
        const failing = vi
            .fn()
            .mockRejectedValueOnce(new Error('tunnel down'))
            .mockImplementation(createTunnel)
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, {
            createBackend,
            resolvePort,
            createTunnel: failing
        })
        await expect(manager.get('c')).rejects.toThrow('tunnel down')
        const retried = await manager.get('c')
        expect(retried.backend).toBe(backends[0])
    })

    it('invalidate disposes backend and tunnel', async () => {
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        await manager.invalidate('c')
        expect(backends[0].disposed).toBe(true)
        expect(tunnels[0].closed).toBe(true)
    })

    it.each([
        ['removed', new ConnectionNotFoundError('c', [])],
        ['broken', new RegistryError('bad file')]
    ])('drops and disposes the cached slot when the connection is %s', async (_, error) => {
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        vi.mocked(registry.resolve).mockImplementationOnce(() => {
            throw error
        })
        await expect(manager.get('c')).rejects.toBe(error)
        await vi.waitFor(() => {
            expect(backends[0].disposed).toBe(true)
            expect(tunnels[0].closed).toBe(true)
        })
        await manager.get('c')
        expect(backends).toHaveLength(2)
    })

    it('keeps the cached slot when resolve throws something else', async () => {
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        vi.mocked(registry.resolve).mockImplementationOnce(() => {
            throw new Error('boom')
        })
        await expect(manager.get('c')).rejects.toThrow('boom')
        await manager.get('c')
        expect(backends).toHaveLength(1)
        expect(backends[0].disposed).toBe(false)
    })

    it('invalidate of an unknown name is a no-op', async () => {
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await expect(manager.invalidate('ghost')).resolves.toBeUndefined()
    })

    it('invalidate during an in-flight build disposes the entry once built', async () => {
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const gatedTunnel = vi.fn(async (ssh: SshConfig, host: string, port: number) => {
            await gate
            return createTunnel(ssh, host, port)
        })
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, {
            createBackend,
            resolvePort,
            createTunnel: gatedTunnel
        })
        const pending = manager.get('c')
        const invalidated = manager.invalidate('c')
        release()
        await invalidated
        // The first build is disposed by invalidate; the pending get loses
        // ownership and retries, resolving to a freshly rebuilt backend.
        expect((await pending).backend).toBe(backends[1])
        expect(backends[0].disposed).toBe(true)
        expect(tunnels[0].closed).toBe(true)
    })

    it('a build in flight when disposeAll runs is disposed, never handed out', async () => {
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const gatedTunnel = vi.fn(async (ssh: SshConfig, host: string, port: number) => {
            await gate
            return createTunnel(ssh, host, port)
        })
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, {
            createBackend,
            resolvePort,
            createTunnel: gatedTunnel
        })
        const pending = manager.get('c')
        const waiting = manager.get('c')
        const disposed = manager.disposeAll()
        release()
        await disposed
        // Both callers (the builder and the one deduplicated onto its build)
        // reject; the one build that finished was disposed, no second build.
        await expect(pending).rejects.toThrow('server is shutting down')
        await expect(waiting).rejects.toThrow('server is shutting down')
        expect(backends).toHaveLength(1)
        expect(backends[0].disposed).toBe(true)
        expect(tunnels[0].closed).toBe(true)
        expect(gatedTunnel).toHaveBeenCalledTimes(1)
    })

    it('closes the tunnel when createBackend throws and a retry succeeds', async () => {
        const throwingBackend = vi
            .fn<(target: BackendTarget<TestConfig>) => FakeBackend>()
            .mockImplementationOnce(() => {
                throw new Error('backend boom')
            })
            .mockImplementation(createBackend)
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, {
            createBackend: throwingBackend,
            resolvePort,
            createTunnel
        })
        await expect(manager.get('c')).rejects.toThrow('backend boom')
        expect(tunnels[0].closed).toBe(true)
        const retried = await manager.get('c')
        expect(retried.backend).toBe(backends[0])
        expect(tunnels[1].closed).toBe(false)
    })

    it('retries instead of throwing when a build fails after ownership is lost', async () => {
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        // First build is gated and then rejects; later builds succeed.
        const gatedTunnel = vi
            .fn(createTunnel)
            .mockImplementationOnce(async () => {
                await gate
                throw new Error('stale build boom')
            })
            .mockImplementation(createTunnel)
        resolved = { config: config(sshExtra()), source: 'global', hash: 'ssh1' }
        const manager = createManager(registry, {
            createBackend,
            resolvePort,
            createTunnel: gatedTunnel
        })
        const pending = manager.get('c')
        // Drop ownership of the in-flight slot (synchronous cache.delete) before
        // its build rejects; do not await invalidate or it blocks on the gate.
        const invalidated = manager.invalidate('c')
        release()
        // The stale build's error is swallowed; get retries and resolves fresh.
        const managed = await pending
        expect(managed.backend).toBe(backends[0])
        await invalidated
    })

    it('disposeAll disposes everything and is terminal', async () => {
        const manager = createManager(registry, { createBackend, resolvePort, createTunnel })
        await manager.get('c')
        await manager.disposeAll()
        expect(backends[0].disposed).toBe(true)
        await expect(manager.get('c')).rejects.toThrow('server is shutting down')
        expect(backends).toHaveLength(1)
        expect(registry.resolve).toHaveBeenCalledTimes(1)
    })

    it('disposeAll waits for an in-flight rotation dispose', async () => {
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        // The first backend's dispose is gated; rotation fires it and forgets it.
        const gatingCreateBackend = (target: BackendTarget<TestConfig>): FakeBackend => {
            targets.push(target)
            const first = backends.length === 0
            const backend = fakeBackend()
            if (first) {
                backend.dispose = vi.fn(async () => {
                    await gate
                    backend.disposed = true
                })
            }
            backends.push(backend)
            return backend
        }
        const manager = createManager(registry, {
            createBackend: gatingCreateBackend,
            resolvePort,
            createTunnel
        })
        await manager.get('c')
        // Hash change rotates the old entry out: its dispose is fire-and-forget.
        resolved = { config: config({ port: 9999 }), source: 'global', hash: 'h2' }
        await manager.get('c')
        expect(backends[0].disposed).toBe(false)

        let resolvedAll = false
        const all = manager.disposeAll().then(() => {
            resolvedAll = true
        })
        // Flush all currently-queued microtasks: disposeAll must still be
        // pending because the gated rotation dispose has not completed.
        for (let i = 0; i < 10; i += 1) {
            await Promise.resolve()
        }
        expect(resolvedAll).toBe(false)
        expect(backends[0].disposed).toBe(false)

        release()
        await all
        // disposeAll only resolves once the rotated-out backend finished disposing.
        expect(backends[0].disposed).toBe(true)
        expect(backends[1].disposed).toBe(true)
    })
})
