import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { Backend } from '../backend.js'
import { BackendDisposedError } from '../backend.js'
import type { ResolvedConnection } from '../config/baseSchema.js'
import { isGitIgnored } from '../config/projectFile.js'
import type { ListedConnection, Registry } from '../config/registry.js'
import type { ManagedConnection, Manager } from '../manager.js'
import { errorMessage, fail, ok } from './respond.js'

export type ConnectionToolsDeps<TConfig extends { name: string }, TBackend extends Backend> = {
    registry: Registry<TConfig>
    manager: Manager<TConfig, TBackend>
    // Advertised as add_connection's inputSchema (plus `scope`) AND used to
    // parse the call. Typed as a `ZodObject` (NOT a bare `ZodType`) on purpose:
    // the SDK can only emit JSON Schema properties for a schema that exposes
    // `.shape`. Put cross-field refinements on `parseSchema`, not here.
    fullSchema: z.ZodObject<z.ZodRawShape, z.UnknownKeysParam, z.ZodTypeAny, TConfig, unknown>
    // Optional stricter validator (e.g. cross-field `.superRefine`) applied in the
    // handler after the wire-level parse.
    parseSchema?: z.ZodType<TConfig, z.ZodTypeDef, unknown>
    patchSchema: z.ZodTypeAny
    publicView: (resolved: ResolvedConnection<TConfig>) => Record<string, unknown>
    ping: (managed: ManagedConnection<TConfig, TBackend>) => Promise<Record<string, unknown>>
    formatError: (config: TConfig, error: unknown) => string
    // Engine-specific "the socket/session is gone" test. test_connection then
    // invalidates the cached backend and pings once more on a fresh one.
    isLostConnection?: (error: unknown) => boolean
    descriptions: { list: string; add: string; update: string; remove: string; test: string }
}

const scopeSchema = z.enum(['project', 'global']).default('global')

const gitWarnings = (path: string): string[] =>
    isGitIgnored(path) === true
        ? []
        : [path + ' is not ignored by git; add it to .gitignore so credentials are not committed']

export const registerConnectionTools = <TConfig extends { name: string }, TBackend extends Backend>(
    server: McpServer,
    deps: ConnectionToolsDeps<TConfig, TBackend>
): void => {
    const { registry, manager } = deps

    const listItem = (item: ListedConnection<TConfig>): Record<string, unknown> => {
        if (!item.ok) {
            return { name: item.name, source: item.source, invalid: item.error }
        }
        const view = deps.publicView(item.resolved)
        return item.shadows ? { ...view, shadows: item.shadows } : view
    }

    server.registerTool('list_connections', { description: deps.descriptions.list }, async () => {
        const { connections, brokenLayers } = registry.list()
        return ok({ connections: connections.map(listItem), brokenLayers })
    })

    server.registerTool(
        'add_connection',
        {
            description: deps.descriptions.add,
            // A strict object (not .shape) so the SDK rejects unknown keys at the
            // boundary instead of silently stripping them; .extend keeps strict.
            inputSchema: deps.fullSchema.extend({ scope: scopeSchema })
        },
        async ({ scope: rawScope, ...config }) => {
            try {
                // Already validated by the SDK; re-parsed only to narrow the type
                // (the extended generic shape types `scope` as unknown).
                const scope = scopeSchema.parse(rawScope)
                const parsed = (deps.parseSchema ?? deps.fullSchema).parse(config)
                const { resolved, notes } = registry.add(parsed, scope)
                const warnings = scope === 'project' ? gitWarnings(registry.paths().project) : []
                return ok({
                    added: deps.publicView(resolved),
                    notes,
                    ...(warnings.length > 0 ? { warnings } : {})
                })
            } catch (error) {
                return fail(errorMessage(error))
            }
        }
    )

    server.registerTool(
        'update_connection',
        {
            description: deps.descriptions.update,
            inputSchema: { name: z.string(), patch: deps.patchSchema }
        },
        async ({ name, patch }) => {
            try {
                const { resolved, notes } = registry.update(name, patch)
                await manager.invalidate(name)
                return ok({ updated: deps.publicView(resolved), notes })
            } catch (error) {
                return fail(errorMessage(error))
            }
        }
    )

    server.registerTool(
        'remove_connection',
        {
            description: deps.descriptions.remove,
            inputSchema: { name: z.string() }
        },
        async ({ name }) => {
            try {
                const { notes } = registry.remove(name)
                await manager.invalidate(name)
                return ok({ removed: name, notes })
            } catch (error) {
                return fail(errorMessage(error))
            }
        }
    )

    server.registerTool(
        'test_connection',
        {
            description: deps.descriptions.test,
            inputSchema: { name: z.string() }
        },
        async ({ name }) => {
            // Start the clock before get() so cold tunnel/pool establishment counts.
            const started = performance.now()
            for (let attempt = 0; attempt < 2; attempt += 1) {
                let managed: ManagedConnection<TConfig, TBackend>
                try {
                    managed = await manager.get(name)
                } catch (error) {
                    return fail(errorMessage(error))
                }
                try {
                    const info = await deps.ping(managed)
                    return ok({
                        ok: true,
                        ...info,
                        latencyMs: Math.round(performance.now() - started)
                    })
                } catch (error) {
                    const lost = deps.isLostConnection?.(error) === true
                    if (lost) {
                        await manager.invalidate(name)
                    }
                    // The ping is read-only, so one retry is safe after a
                    // concurrent reconfigure disposed the backend or the
                    // connection was lost.
                    if (attempt === 0 && (lost || error instanceof BackendDisposedError)) {
                        continue
                    }
                    return fail(deps.formatError(managed.config, error))
                }
            }
            return fail('connection is being reconfigured: retry the call')
        }
    )
}
