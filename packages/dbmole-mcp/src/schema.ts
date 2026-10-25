import { isIP } from 'node:net'
import {
    baseConnectionShape,
    type ResolvedConnection as CoreResolvedConnection
} from '@dbmole/core'
import * as z from 'zod'

export const sslConfigSchema = z.union([
    z.literal(true),
    z.object({ rejectUnauthorized: z.boolean().optional(), ca: z.string().optional() }).strict()
])

// Advertised by add_connection: a plain strict object, so the SDK can publish
// its `.shape`. Cross-field rules live on connectionConfigSchema below.
export const connectionObjectSchema = z
    .object({
        ...baseConnectionShape,
        type: z.enum(['postgres', 'mysql']),
        database: z.string().optional(),
        ssl: sslConfigSchema.optional()
    })
    .strict()

export type ConnectionConfig = z.infer<typeof connectionObjectSchema>
export type SslConfig = NonNullable<ConnectionConfig['ssl']>

export const MYSQL_IP_TLS_MESSAGE =
    'mysql TLS hostname verification does not work with an IP host; ' +
    'use a hostname, or set ssl.rejectUnauthorized: false'

const verifiesTls = (ssl: SslConfig | undefined): boolean =>
    ssl === true || (ssl !== undefined && ssl.rejectUnauthorized !== false)

// mysql2 sends no servername and skips the identity check for an IP-literal host,
// so "verify" would silently mean "chain only". Refuse it up front.
export const connectionConfigSchema = connectionObjectSchema.superRefine((config, ctx) => {
    if (config.type === 'mysql' && isIP(config.host) !== 0 && verifiesTls(config.ssl)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ssl'], message: MYSQL_IP_TLS_MESSAGE })
    }
})

export type ResolvedConnection = CoreResolvedConnection<ConnectionConfig>

export const defaultPort = (type: ConnectionConfig['type']): number =>
    type === 'postgres' ? 5432 : 3306
