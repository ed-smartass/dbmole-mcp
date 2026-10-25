export type { Backend, BackendTarget } from './backend.js'
export { BackendDisposedError } from './backend.js'
export type {
    ConnectionSource,
    LayerName,
    ResolvedConnection,
    SshConfig
} from './config/baseSchema.js'
export {
    baseConnectionShape,
    DEFAULT_QUERY_TIMEOUT_MS,
    sshPatchSchema
} from './config/baseSchema.js'
export type { LayerEntry, LayerRead, LayerShape } from './config/layerFile.js'
export { writeLayerFile } from './config/layerFile.js'
export type { ProjectLocation } from './config/projectFile.js'
export type {
    LayerIO,
    ListedConnection,
    ListResult,
    Mutation,
    NamedConfig,
    Registry,
    RegistryDeps
} from './config/registry.js'
export { createFileRegistry } from './config/registry.js'
export type { Truncation } from './format.js'
export { clampLimit, fitJson, MAX_ROW_LIMIT, sliceUtf8 } from './format.js'
export { removedConfigHint } from './legacyConfig.js'
export type { ManagedConnection, Manager, ManagerDeps } from './manager.js'
export { createManager } from './manager.js'
export type { ConnectionToolsDeps } from './mcp/connectionTools.js'
export { registerConnectionTools } from './mcp/connectionTools.js'
export type { WithManagedDeps } from './mcp/managed.js'
export { LOST_CONNECTION_NOTE, withManaged } from './mcp/managed.js'
export { ToolFailure } from './mcp/respond.js'
export { strictInput } from './mcp/strictInput.js'
export type { HostKeyCheck } from './net/knownHosts.js'
export { fingerprint } from './net/knownHosts.js'
export type { Tunnel } from './net/tunnel.js'
export { expandHome, openTunnel } from './net/tunnel.js'
