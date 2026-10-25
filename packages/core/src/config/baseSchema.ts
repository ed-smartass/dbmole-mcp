import * as z from 'zod'

// OpenSSH fingerprint of the server host key, e.g. 'SHA256:abc...'. When set it
// is the only key accepted; ~/.ssh/known_hosts is not consulted.
const hostKeySchema = z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/, "hostKey must look like 'SHA256:<base64>'")

export const sshConfigSchema = z
    .object({
        host: z.string().min(1),
        port: z.number().int().positive().default(22),
        user: z.string().min(1),
        password: z.string().optional(),
        privateKey: z.string().optional(),
        privateKeyPath: z.string().optional(),
        passphrase: z.string().optional(),
        agent: z.boolean().optional(),
        hostKey: hostKeySchema.optional()
    })
    .strict()

export type SshConfig = z.infer<typeof sshConfigSchema>

// update_connection's `ssh` value. The registry merges it into the stored ssh
// object field by field (null removes a field), so e.g. { hostKey } can be set
// without resending secrets the agent never saw. `ssh: null` drops the tunnel.
export const sshPatchSchema = z
    .object({
        host: z.string().min(1).optional(),
        port: z.number().int().positive().optional(),
        user: z.string().min(1).optional(),
        password: z.string().nullable().optional(),
        privateKey: z.string().nullable().optional(),
        privateKeyPath: z.string().nullable().optional(),
        passphrase: z.string().nullable().optional(),
        agent: z.boolean().nullable().optional(),
        hostKey: hostKeySchema.nullable().optional()
    })
    .strict()

// Fields shared by every backend. Leaf packages spread this, add `type` and
// engine-specific fields, then call `.strict()`. `user` is required here to
// match dbmole exactly; esmole overrides it to optional.
export const baseConnectionShape = {
    name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'name must match [a-zA-Z0-9_-]+'),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    user: z.string().min(1),
    password: z.string().optional(),
    readonly: z.boolean().default(false),
    // Per-statement/request deadline; backends fall back to DEFAULT_QUERY_TIMEOUT_MS.
    queryTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    ssh: sshConfigSchema.optional()
} as const

export const DEFAULT_QUERY_TIMEOUT_MS = 60_000

export type LayerName = 'project' | 'global'

export type ConnectionSource = LayerName

export type ResolvedConnection<TConfig> = {
    config: TConfig
    source: LayerName
    hash: string
}
