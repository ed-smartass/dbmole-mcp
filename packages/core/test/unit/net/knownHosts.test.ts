import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkHostKey, fingerprint } from '../../../src/net/knownHosts.js'

// OpenSSH wire blob for an ed25519 key: string 'ssh-ed25519' + string <32 raw bytes>.
const sshString = (value: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length)
    return Buffer.concat([length, value])
}

const newHostKey = (): Buffer => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(raw)])
}

const KEY = newHostKey()
const OTHER = newHostKey()
const line = (hosts: string, key: Buffer = KEY): string =>
    hosts + ' ssh-ed25519 ' + key.toString('base64') + ' comment'

const hashed = (name: string): string => {
    const salt = randomBytes(20)
    const hash = createHmac('sha1', salt).update(name).digest('base64')
    return '|1|' + salt.toString('base64') + '|' + hash
}

const check = (knownHosts: string, host = 'db.example.com', port = 22) =>
    checkHostKey({ host, port, key: KEY, knownHosts })

describe('fingerprint', () => {
    it('matches ssh-keygen -lf output (SHA256, unpadded base64)', () => {
        const blob = Buffer.from(
            'AAAAC3NzaC1lZDI1NTE5AAAAIJ7b5MDbsWoq5AmxNk/x3Wa3iwSDatA/hwmXWxqvpKfe',
            'base64'
        )
        expect(fingerprint(blob)).toBe('SHA256:y7R/XB69YxB33LfH4yzcb8uck0tqIZXt8iwwSZ5SuZo')
    })
})

describe('checkHostKey: pinned', () => {
    it('accepts the pinned fingerprint without consulting known_hosts', () => {
        const revoked = '@revoked ' + line('db.example.com')
        expect(
            checkHostKey({
                host: 'db.example.com',
                port: 22,
                key: KEY,
                pinned: fingerprint(KEY),
                knownHosts: revoked
            })
        ).toEqual({ ok: true })
    })

    it('accepts a pin written with base64 padding', () => {
        expect(
            checkHostKey({
                host: 'db.example.com',
                port: 22,
                key: KEY,
                pinned: fingerprint(KEY) + '='
            })
        ).toEqual({ ok: true })
    })

    it('rejects a different key with both fingerprints and the update hint', () => {
        const result = checkHostKey({
            host: 'db.example.com',
            port: 2222,
            key: KEY,
            pinned: fingerprint(OTHER),
            knownHosts: line('[db.example.com]:2222')
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.message).toContain('db.example.com:2222')
            expect(result.message).toContain(fingerprint(KEY))
            expect(result.message).toContain(fingerprint(OTHER))
            expect(result.message).toContain(
                "set ssh.hostKey to '" + fingerprint(KEY) + "' via update_connection"
            )
        }
    })
})

describe('checkHostKey: known_hosts', () => {
    it('matches a plain host name on port 22', () => {
        expect(check(line('db.example.com'))).toEqual({ ok: true })
    })

    it('needs the [host]:port form for other ports', () => {
        expect(check(line('db.example.com'), 'db.example.com', 2222).ok).toBe(false)
        expect(check(line('[db.example.com]:2222'), 'db.example.com', 2222)).toEqual({ ok: true })
    })

    it('matches any name of a comma-separated list, case-insensitively', () => {
        expect(check(line('other,DB.example.com,10.0.0.5'), 'db.EXAMPLE.com')).toEqual({ ok: true })
    })

    it('matches hashed host names', () => {
        expect(check(line(hashed('db.example.com')))).toEqual({ ok: true })
        expect(check(line(hashed('[db.example.com]:2222')), 'db.example.com', 2222)).toEqual({
            ok: true
        })
        expect(check(line(hashed('other.example.com'))).ok).toBe(false)
    })

    it('ignores wildcard patterns', () => {
        const result = check(line('*.example.com,db.example.co?'))
        expect(result).toEqual({
            ok: false,
            message: expect.stringContaining('is not in known_hosts')
        })
    })

    it('a negated exact name excludes the line', () => {
        expect(check(line('!db.example.com,db.example.com')).ok).toBe(false)
    })

    it('a negated wildcard excludes nothing, so the line is ignored', () => {
        expect(check(line('db.example.com,!d*')).ok).toBe(false)
        expect(check(line('db.example.com,!db.example.co?')).ok).toBe(false)
    })

    it('a malformed hashed entry never matches', () => {
        expect(check(line('|1|')).ok).toBe(false)
        expect(check(line('|1|c2FsdA==|')).ok).toBe(false)
    })

    it('accepts CRLF line endings', () => {
        expect(check('# comment\r\n' + line('db.example.com') + '\r\n')).toEqual({ ok: true })
    })

    it('ignores lines with an unknown marker', () => {
        expect(check('@revokd ' + line('db.example.com')).ok).toBe(false)
    })

    it('a @revoked key is rejected whatever the host pattern, wildcards included', () => {
        const wildcard = [line('db.example.com'), '@revoked ' + line('*')].join('\n')
        expect(check(wildcard)).toEqual({
            ok: false,
            message: expect.stringContaining('@revoked')
        })
        const otherHost = [line('db.example.com'), '@revoked ' + line('other.example.com')]
        expect(check(otherHost.join('\n')).ok).toBe(false)
    })

    it('a @revoked entry for another key does not count as a known_hosts entry', () => {
        const result = check('@revoked ' + line('*', OTHER))
        expect(result).toEqual({
            ok: false,
            message: expect.stringContaining('is not in known_hosts')
        })
    })

    it('skips comments, blank lines and malformed lines', () => {
        const file = ['# comment', '', 'db.example.com', line('db.example.com')].join('\n')
        expect(check(file)).toEqual({ ok: true })
    })

    it('rejects a key marked @revoked for the host, even if also listed plainly', () => {
        const file = [line('db.example.com'), '@revoked ' + line('db.example.com')].join('\n')
        const result = check(file)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.message).toContain(fingerprint(KEY))
            expect(result.message).toContain('@revoked')
            expect(result.message).not.toContain('update_connection')
        }
    })

    it('ignores @cert-authority lines', () => {
        expect(check('@cert-authority ' + line('db.example.com')).ok).toBe(false)
    })

    it('reports a changed key for a known host', () => {
        const result = check(line('db.example.com', OTHER))
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.message).toContain('does not match the known_hosts entry')
            expect(result.message).toContain('or the server offered a different key type')
            expect(result.message).toContain(fingerprint(KEY))
        }
    })

    it('rejects an unknown host with the fingerprint and the update hint', () => {
        const result = checkHostKey({ host: 'db.example.com', port: 22, key: KEY })
        expect(result).toEqual({
            ok: false,
            message:
                'ssh host key ' +
                fingerprint(KEY) +
                ' for db.example.com:22 is not in known_hosts; verify it out of band, then set ' +
                "ssh.hostKey to '" +
                fingerprint(KEY) +
                "' via update_connection"
        })
    })
})
