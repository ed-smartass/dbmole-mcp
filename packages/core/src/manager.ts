import type { Backend, BackendTarget } from './backend.js'
import type { ResolvedConnection, SshConfig } from './config/baseSchema.js'
import { ConnectionNotFoundError, type Registry, RegistryError } from './config/registry.js'
import { openTunnel, type Tunnel } from './net/tunnel.js'

type Entry<TBackend> = { backend: TBackend; tunnel?: Tunnel }
type CacheSlot<TBackend> = { hash: string; promise: Promise<Entry<TBackend>> }

export type ManagerDeps<TConfig, TBackend extends Backend> = {
    createBackend: (target: BackendTarget<TConfig>) => TBackend
    resolvePort: (config: TConfig) => number
    createTunnel?: typeof openTunnel
}

export type ManagedConnection<TConfig, TBackend> = {
    backend: TBackend
    config: TConfig
    source: string
}

export type Manager<TConfig, TBackend extends Backend> = {
    get: (name: string) => Promise<ManagedConnection<TConfig, TBackend>>
    invalidate: (name: string) => Promise<void>
    disposeAll: () => Promise<void>
}

export const createManager = <
    TConfig extends { name: string; host: string; ssh?: SshConfig },
    TBackend extends Backend
>(
    registry: Registry<TConfig>,
    deps: ManagerDeps<TConfig, TBackend>
): Manager<TConfig, TBackend> => {
    const createTunnel = deps.createTunnel ?? openTunnel
    const cache = new Map<string, CacheSlot<TBackend>>()
    const pendingDisposals = new Set<Promise<void>>()
    // Terminal: set by disposeAll, never cleared. A get that was waiting on a
    // build when shutdown began loses its slot, loops, and lands here.
    let shuttingDown = false

    const disposeEntry = async (entry: Entry<TBackend>): Promise<void> => {
        // Order matters: pg/mysql2 pool.end() waits for in-flight queries to
        // finish, so the backend drains BEFORE the tunnel closes. New work
        // lands on the rebuilt entry, not this one.
        await entry.backend.dispose().catch(() => {})
        await entry.tunnel?.close().catch(() => {})
    }

    // Fire-and-forget dispose of a rotated-out slot, but track it so disposeAll
    // can wait for in-flight rotations (hash-change/dead-tunnel) on shutdown.
    const disposeSlot = (slot: CacheSlot<TBackend>): void => {
        let pending: Promise<void>
        pending = slot.promise
            .then(disposeEntry)
            .catch(() => {})
            .finally(() => {
                pendingDisposals.delete(pending)
            })
        pendingDisposals.add(pending)
    }

    const build = async (config: TConfig): Promise<Entry<TBackend>> => {
        const port = deps.resolvePort(config)
        const ssh = config.ssh
        const tunnel = ssh ? await createTunnel(ssh, config.host, port) : undefined
        try {
            const target: BackendTarget<TConfig> = {
                config,
                connectHost: tunnel ? tunnel.localHost : config.host,
                connectPort: tunnel ? tunnel.localPort : port,
                serverName: config.host
            }
            return { backend: deps.createBackend(target), tunnel }
        } catch (error) {
            await tunnel?.close().catch(() => {})
            throw error
        }
    }

    const get = async (name: string): Promise<ManagedConnection<TConfig, TBackend>> => {
        for (;;) {
            if (shuttingDown) {
                throw new Error('server is shutting down')
            }
            let resolved: ResolvedConnection<TConfig>
            try {
                resolved = registry.resolve(name)
            } catch (error) {
                // Deleted or broken in the file: free its pools and tunnel now
                // instead of holding them until exit.
                const stale = cache.get(name)
                if (
                    stale &&
                    (error instanceof ConnectionNotFoundError || error instanceof RegistryError)
                ) {
                    cache.delete(name)
                    disposeSlot(stale)
                }
                throw error
            }
            const cached = cache.get(name)
            if (cached && cached.hash === resolved.hash) {
                const entry = await cached.promise
                // Recheck ownership: a concurrent invalidate/disposeAll/hash-change
                // may have replaced or deleted this slot while we awaited it.
                const stillOwner = cache.get(name) === cached
                if (stillOwner && !entry.tunnel?.isClosed()) {
                    return {
                        backend: entry.backend,
                        config: resolved.config,
                        source: resolved.source
                    }
                }
                if (stillOwner) {
                    cache.delete(name)
                    disposeSlot(cached)
                }
                continue
            }
            if (cached) {
                cache.delete(name)
                disposeSlot(cached)
            }
            const slot: CacheSlot<TBackend> = {
                hash: resolved.hash,
                promise: build(resolved.config)
            }
            cache.set(name, slot)
            try {
                const entry = await slot.promise
                if (cache.get(name) !== slot) {
                    // Lost ownership while building; the slot's disposal is handled
                    // by whoever replaced it. Retry to get a live entry.
                    continue
                }
                return { backend: entry.backend, config: resolved.config, source: resolved.source }
            } catch (error) {
                // Only the still-owning build surfaces its error. If ownership
                // was lost while building (invalidate/disposeAll/hash-change
                // replaced or removed the slot), the stale failure is irrelevant
                // — retry to get a live entry instead of throwing it.
                if (cache.get(name) === slot) {
                    cache.delete(name)
                    throw error
                }
            }
        }
    }

    const invalidate = async (name: string): Promise<void> => {
        const slot = cache.get(name)
        if (!slot) {
            return
        }
        cache.delete(name)
        await slot.promise.then(disposeEntry).catch(() => {})
    }

    const disposeAll = async (): Promise<void> => {
        shuttingDown = true
        const slots = [...cache.values()]
        cache.clear()
        await Promise.all([
            ...slots.map((slot) => slot.promise.then(disposeEntry).catch(() => {})),
            ...pendingDisposals
        ])
    }

    return { get, invalidate, disposeAll }
}
