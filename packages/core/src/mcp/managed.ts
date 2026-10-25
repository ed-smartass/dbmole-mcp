import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Backend } from '../backend.js'
import { BackendDisposedError } from '../backend.js'
import type { ManagedConnection, Manager } from '../manager.js'
import { errorMessage, fail, ok, ToolFailure } from './respond.js'

export type WithManagedDeps<TConfig> = {
    formatError: (config: TConfig, error: unknown) => string
    // Engine-specific "the socket/session is gone" test (e.g. ECONNRESET).
    isLostConnection?: (error: unknown) => boolean
    // Replay once after a lost connection. Only for the fixed read-only helpers:
    // arbitrary statements may already have had side effects.
    retrySafe?: boolean
}

export const LOST_CONNECTION_NOTE =
    'connection lost; pool reset; the statement may or may not have run'

// Runs fn against the named connection and maps the outcome to a tool result:
// - ToolFailure: its message verbatim;
// - BackendDisposedError (a concurrent invalidate/rotation ended the pools):
//   one transparent retry on the rebuilt entry;
// - lost connection: the cached backend is invalidated so the next call gets
//   a fresh pool; replayed once only when retrySafe;
// - anything else: formatError.
export const withManaged = async <TConfig extends { name: string }, TBackend extends Backend>(
    manager: Manager<TConfig, TBackend>,
    connection: string,
    fn: (managed: ManagedConnection<TConfig, TBackend>) => Promise<unknown>,
    deps: WithManagedDeps<TConfig>
): Promise<CallToolResult> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let managed: ManagedConnection<TConfig, TBackend>
        try {
            managed = await manager.get(connection)
        } catch (error) {
            return fail(errorMessage(error))
        }
        try {
            return ok(await fn(managed))
        } catch (error) {
            if (error instanceof ToolFailure) {
                return fail(error.message)
            }
            if (error instanceof BackendDisposedError) {
                if (attempt === 0) {
                    continue
                }
                // Disposed again on the retry: the connection is being churned
                // faster than we can use it.
                break
            }
            if (deps.isLostConnection?.(error)) {
                await manager.invalidate(connection)
                if (deps.retrySafe && attempt === 0) {
                    continue
                }
                return fail(deps.formatError(managed.config, error) + '\n' + LOST_CONNECTION_NOTE)
            }
            return fail(deps.formatError(managed.config, error))
        }
    }
    return fail('connection is being reconfigured: retry the call')
}
