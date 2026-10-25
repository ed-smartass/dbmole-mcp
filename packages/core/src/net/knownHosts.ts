import { createHash, createHmac } from 'node:crypto'

export type HostKeyCheck = { ok: true } | { ok: false; message: string }

// OpenSSH fingerprint format: 'SHA256:' + unpadded base64 of the key blob's SHA-256.
export const fingerprint = (key: Buffer): string =>
    'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')

// known_hosts names a non-default port as '[host]:port'. OpenSSH lowercases names.
const hostField = (host: string, port: number): string => {
    const name = host.toLowerCase()
    return port === 22 ? name : '[' + name + ']:' + port
}

// '|1|<base64 salt>|<base64 HMAC-SHA1(salt, host)>'
const matchesHashed = (pattern: string, field: string): boolean => {
    const [, , salt, hash] = pattern.split('|')
    if (!salt || !hash) {
        return false
    }
    const digest = createHmac('sha1', Buffer.from(salt, 'base64')).update(field).digest('base64')
    return digest === hash
}

// Plain comma-separated names and hashed names only. Wildcard patterns are not
// supported (never match); a negated exact name excludes the whole line, and a
// negated wildcard makes the line unusable (fail closed).
const matchesHost = (patterns: string, field: string): boolean => {
    if (patterns.startsWith('|1|')) {
        return matchesHashed(patterns, field)
    }
    const list = patterns.toLowerCase().split(',')
    if (list.some((p) => p.startsWith('!') && (p === '!' + field || /[*?]/.test(p)))) {
        return false
    }
    return list.includes(field)
}

type KnownKeys = { revoked: Buffer[]; trusted: Buffer[] }

const keysFor = (knownHosts: string, field: string): KnownKeys => {
    const keys: KnownKeys = { revoked: [], trusted: [] }
    for (const line of knownHosts.split('\n')) {
        const fields = line.trim().split(/\s+/)
        const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined
        // Like OpenSSH, skip unknown markers; certificates are unsupported, so
        // @cert-authority lines are skipped too.
        if (marker !== undefined && marker !== '@revoked') {
            continue
        }
        if (fields.length < 3 || fields[0].startsWith('#')) {
            continue
        }
        const key = Buffer.from(fields[2], 'base64')
        // Fail closed: a revoked key is revoked for every host, whatever the
        // pattern (wildcards included).
        if (marker === '@revoked') {
            keys.revoked.push(key)
        } else if (matchesHost(fields[0], field)) {
            keys.trusted.push(key)
        }
    }
    return keys
}

const pinHint = (print: string): string =>
    "; verify it out of band, then set ssh.hostKey to '" + print + "' via update_connection"

// Pinned key first; otherwise the presented raw key blob must equal the key of a
// known_hosts entry for this host. Anything else rejects with the fingerprint.
export const checkHostKey = (args: {
    host: string
    port: number
    key: Buffer
    pinned?: string
    knownHosts?: string
}): HostKeyCheck => {
    const print = fingerprint(args.key)
    const target = args.host + ':' + args.port
    if (args.pinned !== undefined) {
        if (args.pinned.replace(/=+$/, '') === print) {
            return { ok: true }
        }
        return {
            ok: false,
            message:
                'ssh host key for ' +
                target +
                ' is ' +
                print +
                ', which does not match the pinned ssh.hostKey ' +
                args.pinned +
                pinHint(print)
        }
    }
    const known = keysFor(args.knownHosts ?? '', hostField(args.host, args.port))
    if (known.revoked.some((key) => key.equals(args.key))) {
        return {
            ok: false,
            message: 'ssh host key ' + print + ' for ' + target + ' is @revoked in known_hosts'
        }
    }
    if (known.trusted.some((key) => key.equals(args.key))) {
        return { ok: true }
    }
    const reason =
        known.trusted.length > 0
            ? ' does not match the known_hosts entry for this host (it may have changed, ' +
              'or the server offered a different key type than the one in known_hosts)'
            : ' is not in known_hosts'
    return {
        ok: false,
        message: 'ssh host key ' + print + ' for ' + target + reason + pinHint(print)
    }
}
