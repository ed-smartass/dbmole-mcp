import { registerConnectionTools as coreRegister, sshPatchSchema } from '@dbmole/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { Driver } from '../db/driver.js'
import {
    type ConnectionConfig,
    connectionConfigSchema,
    connectionObjectSchema,
    defaultPort,
    type ResolvedConnection,
    sslConfigSchema
} from '../schema.js'
import { type DbManager, type DbRegistry, formatError, isLostConnection } from '../wiring.js'

const patchSchema = z
    .object({
        name: z
            .string()
            .regex(/^[a-zA-Z0-9_-]+$/)
            .optional(),
        type: z.enum(['postgres', 'mysql']).optional(),
        host: z.string().min(1).optional(),
        port: z.number().int().positive().nullable().optional(),
        user: z.string().min(1).optional(),
        password: z.string().nullable().optional(),
        database: z.string().nullable().optional(),
        readonly: z.boolean().optional(),
        ssh: sshPatchSchema.nullable().optional(),
        queryTimeoutMs: z.number().int().positive().max(2_147_483_647).nullable().optional(),
        ssl: sslConfigSchema.nullable().optional()
    })
    .strict()

const publicView = (resolved: ResolvedConnection) => ({
    name: resolved.config.name,
    type: resolved.config.type,
    host: resolved.config.host,
    port: resolved.config.port ?? defaultPort(resolved.config.type),
    database: resolved.config.database ?? null,
    readonly: resolved.config.readonly,
    source: resolved.source,
    ssh: Boolean(resolved.config.ssh)
})

export const registerConnectionTools = (
    server: McpServer,
    registry: DbRegistry,
    manager: DbManager
): void =>
    coreRegister<ConnectionConfig, Driver>(server, {
        registry,
        manager,
        fullSchema: connectionObjectSchema,
        parseSchema: connectionConfigSchema,
        patchSchema,
        publicView,
        formatError,
        isLostConnection,
        ping: async (managed) => ({ version: await managed.backend.serverVersion() }),
        descriptions: {
            list: 'List database connections with the layer each comes from: project (.dbmole.json, found by walking up from the project dir) or global (user store). Also shows invalid entries and broken files. Secrets are omitted.',
            add: 'Add a named postgres/mysql connection. scope "global" (default) saves it to the user store; "project" saves it to .dbmole.json in the project root. Supports an optional ssh tunnel and a readonly flag. Optional ssl: true or { rejectUnauthorized, ca } (ca = PEM or file path).',
            update: 'Patch a connection by name in the layer it lives in (project or global). Set a field to null to remove it (e.g. "ssh": null); an ssh object is merged field by field, e.g. { "ssh": { "hostKey": "SHA256:..." } }. queryTimeoutMs sets the per-statement timeout (null restores the 60 s default). ssl is replaced as a whole, not merged like ssh.',
            remove: 'Remove a connection by name from the layer it lives in (invalid entries too) and drop its cached pools/tunnel.',
            test: 'Verify a connection works end to end (including ssh tunnel if configured). Reports server version and connect+query latency.'
        }
    })
