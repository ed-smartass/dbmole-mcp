import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ssh2State = vi.hoisted(() => {
    // vi.hoisted runs before static imports, so EventEmitter must be pulled in
    // here via require (injected by Vitest's transform) rather than a top-level
    // import, which is not yet initialised at hoist time.
    const { EventEmitter } = require('node:events') as typeof import('node:events')

    const state = {
        instances: [] as FakeSshClient[],
        failConnect: false,
        // When true, forwardOut stashes its callback instead of invoking it, so
        // a test can deliver the stream LATE (after close()).
        deferForward: false,
        streams: [] as PassThrough[],
        // Raw blob the fake server presents to hostVerifier.
        hostKey: Buffer.from('fake-host-key-blob')
    }

    class FakeSshClient extends EventEmitter {
        connectConfig: Record<string, unknown> | undefined
        forwardCalls: unknown[][] = []
        deferred: Array<() => void> = []
        ended = false

        connect(config: Record<string, unknown>) {
            this.connectConfig = config
            process.nextTick(() => {
                if (state.failConnect) {
                    this.emit('error', new Error('auth failed'))
                    return
                }
                // Same contract as ssh2: a falsy verifier result aborts the handshake.
                const verify = config.hostVerifier
                if (typeof verify === 'function' && verify(state.hostKey) !== true) {
                    this.emit('error', new Error('Host denied (verification failed)'))
                    return
                }
                this.emit('ready')
            })
        }

        forwardOut(
            srcHost: string,
            srcPort: number,
            dstHost: string,
            dstPort: number,
            callback: (err: Error | null, stream?: PassThrough) => void
        ) {
            this.forwardCalls.push([srcHost, srcPort, dstHost, dstPort])
            const stream = new PassThrough()
            state.streams.push(stream)
            const deliver = () => callback(null, stream)
            if (state.deferForward) {
                this.deferred.push(deliver)
                return
            }
            deliver()
        }

        end() {
            this.ended = true
        }
    }

    return { state, FakeSshClient }
})

vi.mock('ssh2', () => ({
    Client: class extends ssh2State.FakeSshClient {
        constructor() {
            super()
            ssh2State.state.instances.push(this)
        }
    }
}))

import type { SshConfig } from '../../../src/config/baseSchema.js'
import { fingerprint } from '../../../src/net/knownHosts.js'
import { buildSshAuth, expandHome, openTunnel } from '../../../src/net/tunnel.js'

// Pinned by default so no test reads the developer's ~/.ssh/known_hosts.
const sshConfig = (extra: Partial<SshConfig> = {}): SshConfig => ({
    host: 'bastion',
    port: 22,
    user: 'tunnel',
    hostKey: fingerprint(ssh2State.state.hostKey),
    ...extra
})

describe('expandHome', () => {
    it('expands ~ prefix', () => {
        expect(expandHome('~/.ssh/key')).not.toContain('~')
        expect(expandHome('~/.ssh/key')).toMatch(/\.ssh\/key$/)
    })

    it('leaves absolute paths alone', () => {
        expect(expandHome('/etc/key')).toBe('/etc/key')
    })
})

describe('buildSshAuth', () => {
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'dbmole-ssh-'))
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('prefers inline privateKey', () => {
        const auth = buildSshAuth(sshConfig({ privateKey: 'PEM', password: 'pw' }))
        expect(auth).toEqual({ privateKey: 'PEM', passphrase: undefined })
    })

    it('reads privateKeyPath from disk', () => {
        const keyPath = join(dir, 'id_test')
        writeFileSync(keyPath, 'FILEPEM')
        const auth = buildSshAuth(sshConfig({ privateKeyPath: keyPath, passphrase: 'pp' }))
        expect(auth).toEqual({ privateKey: 'FILEPEM', passphrase: 'pp' })
    })

    it('uses agent when enabled and SSH_AUTH_SOCK set', () => {
        const auth = buildSshAuth(sshConfig({ agent: true }), { SSH_AUTH_SOCK: '/tmp/agent.sock' })
        expect(auth).toEqual({ agent: '/tmp/agent.sock' })
    })

    it('throws when agent is requested but SSH_AUTH_SOCK is unset', () => {
        expect(() => buildSshAuth(sshConfig({ agent: true, password: 'pw' }), {})).toThrow(
            /SSH_AUTH_SOCK is not set/
        )
    })

    it('throws when agent is requested but SSH_AUTH_SOCK is empty', () => {
        expect(() => buildSshAuth(sshConfig({ agent: true }), { SSH_AUTH_SOCK: '' })).toThrow(
            /SSH_AUTH_SOCK is not set/
        )
    })

    it('still prefers privateKey over a requested agent', () => {
        const auth = buildSshAuth(sshConfig({ agent: true, privateKey: 'PEM' }), {})
        expect(auth).toEqual({ privateKey: 'PEM', passphrase: undefined })
    })

    it('falls back to password', () => {
        expect(buildSshAuth(sshConfig({ password: 'pw' }))).toEqual({ password: 'pw' })
    })

    it('throws when no method available', () => {
        expect(() => buildSshAuth(sshConfig(), {})).toThrow(/privateKey/)
    })
})

describe('openTunnel', () => {
    beforeEach(() => {
        ssh2State.state.instances.length = 0
        ssh2State.state.failConnect = false
        ssh2State.state.deferForward = false
        ssh2State.state.streams.length = 0
    })

    it('forwards local TCP traffic through ssh forwardOut', async () => {
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        expect(tunnel.localHost).toBe('127.0.0.1')
        expect(tunnel.localPort).toBeGreaterThan(0)

        const echoed = await new Promise<string>((resolve, reject) => {
            const socket = net.connect(tunnel.localPort, tunnel.localHost, () => {
                socket.write('ping')
            })
            socket.once('data', (chunk) => {
                socket.end()
                resolve(chunk.toString())
            })
            socket.once('error', reject)
        })

        // FakeSshClient hands back a PassThrough, so bytes written into the
        // tunnel come straight back: pipe wiring works in both directions.
        expect(echoed).toBe('ping')
        const client = ssh2State.state.instances[0]
        expect(client.forwardCalls[0]).toEqual(expect.arrayContaining(['db-host', 5432]))
        expect(client.connectConfig).toMatchObject({
            host: 'bastion',
            port: 22,
            username: 'tunnel',
            password: 'pw'
        })

        await tunnel.close()
        expect(client.ended).toBe(true)
    })

    it('rejects when ssh connection fails', async () => {
        ssh2State.state.failConnect = true
        await expect(openTunnel(sshConfig({ password: 'pw' }), 'db', 5432)).rejects.toThrow(
            'auth failed'
        )
    })

    it('survives a second ssh error after a failed connect', async () => {
        ssh2State.state.failConnect = true
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(openTunnel(sshConfig({ password: 'pw' }), 'db', 5432)).rejects.toThrow(
            'auth failed'
        )
        const client = ssh2State.state.instances[0]
        expect(() => client.emit('error', new Error('late reset'))).not.toThrow()
        expect(spy).toHaveBeenCalledWith('ssh-tunnel: ssh tunnel error: late reset')
        spy.mockRestore()
    })

    it('close() resolves even with an open forwarded socket', async () => {
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        const socket = await new Promise<net.Socket>((resolve, reject) => {
            const s = net.connect(tunnel.localPort, tunnel.localHost, () => {
                s.write('hold')
                resolve(s)
            })
            s.once('error', reject)
        })
        const clientClosed = new Promise<void>((resolve) => {
            if (socket.closed) {
                resolve()
                return
            }
            socket.once('close', () => resolve())
        })
        // Deliberately do NOT end the socket; close() must still resolve.
        await tunnel.close()
        // The forwarded socket on the server side is destroyed, which tears
        // down our client end too.
        await clientClosed
        expect(socket.destroyed).toBe(true)
    })

    it('reports isClosed false for a fresh tunnel', async () => {
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        expect(tunnel.isClosed()).toBe(false)
        await tunnel.close()
    })

    it('flips isClosed to true when the ssh client closes', async () => {
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        const client = ssh2State.state.instances[0]
        client.emit('close')
        expect(tunnel.isClosed()).toBe(true)
        await tunnel.close()
    })

    it('flips isClosed to true when the ssh client ends', async () => {
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        const client = ssh2State.state.instances[0]
        client.emit('end')
        expect(tunnel.isClosed()).toBe(true)
        await tunnel.close()
    })

    it('flips isClosed to true on a late listener error', async () => {
        const created: net.Server[] = []
        const realCreateServer = net.createServer.bind(net)
        const spy = vi.spyOn(net, 'createServer').mockImplementation((handler) => {
            const server = realCreateServer(handler as (socket: net.Socket) => void)
            created.push(server)
            return server
        })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        // A listener error after listen() resolved must not be swallowed: it
        // marks the tunnel closed so the manager can rebuild it.
        created[0].emit('error', new Error('EADDRNOTAVAIL'))
        expect(tunnel.isClosed()).toBe(true)
        // Default log label brands the diagnostic with 'ssh-tunnel:'.
        expect(errSpy).toHaveBeenCalledWith('ssh-tunnel: tunnel listener error: EADDRNOTAVAIL')
        errSpy.mockRestore()
        spy.mockRestore()
        await tunnel.close()
    })

    it('uses a custom logLabel prefix on diagnostics', async () => {
        const created: net.Server[] = []
        const realCreateServer = net.createServer.bind(net)
        const spy = vi.spyOn(net, 'createServer').mockImplementation((handler) => {
            const server = realCreateServer(handler as (socket: net.Socket) => void)
            created.push(server)
            return server
        })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432, 'dbmole')
        created[0].emit('error', new Error('EADDRNOTAVAIL'))
        expect(tunnel.isClosed()).toBe(true)
        // The injected label replaces the default prefix token.
        expect(errSpy).toHaveBeenCalledWith('dbmole: tunnel listener error: EADDRNOTAVAIL')
        errSpy.mockRestore()
        spy.mockRestore()
        await tunnel.close()
    })

    it('destroys a late forwardOut stream delivered after close, wiring no pipes', async () => {
        ssh2State.state.deferForward = true
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        const client = ssh2State.state.instances[0]

        // Connect a socket; the server's forwardOut callback is held back.
        await new Promise<net.Socket>((resolve, reject) => {
            const s = net.connect(tunnel.localPort, tunnel.localHost, () => resolve(s))
            s.once('error', reject)
        })
        // Wait until the deferred forwardOut callback has been registered.
        await vi.waitFor(() => {
            expect(client.deferred).toHaveLength(1)
        })

        const stream = ssh2State.state.streams[0]
        const pipeSpy = vi.spyOn(stream, 'pipe')

        // Tear the tunnel down, THEN deliver the forwarded stream late.
        await tunnel.close()
        client.deferred[0]()

        // The late stream is destroyed and never piped.
        expect(stream.destroyed).toBe(true)
        expect(pipeSpy).not.toHaveBeenCalled()
    })

    it('enables ssh keepalive so half-open tunnels are detected', async () => {
        const tunnel = await openTunnel(sshConfig({ password: 'pw' }), 'db-host', 5432)
        expect(ssh2State.state.instances[0].connectConfig).toMatchObject({
            keepaliveInterval: 15_000,
            keepaliveCountMax: 3
        })
        await tunnel.close()
    })

    it('rejects a host key that does not match the pinned one', async () => {
        const presented = fingerprint(ssh2State.state.hostKey)
        const wrong = 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '')
        const opening = openTunnel(sshConfig({ password: 'pw', hostKey: wrong }), 'db', 5432)
        await expect(opening).rejects.toThrow(presented)
        await expect(opening).rejects.toThrow('via update_connection')
    })

    describe('without a pinned key', () => {
        let dir: string

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'dbmole-known-hosts-'))
        })

        afterEach(() => {
            rmSync(dir, { recursive: true, force: true })
        })

        const unpinned = (): SshConfig =>
            sshConfig({ port: 2222, password: 'pw', hostKey: undefined })

        it('accepts a key listed in known_hosts', async () => {
            const knownHostsPath = join(dir, 'known_hosts')
            writeFileSync(
                knownHostsPath,
                '[bastion]:2222 ssh-ed25519 ' + ssh2State.state.hostKey.toString('base64') + '\n'
            )
            const tunnel = await openTunnel(unpinned(), 'db', 5432, 'test', { knownHostsPath })
            expect(tunnel.isClosed()).toBe(false)
            await tunnel.close()
        })

        it('rejects with the fingerprint when known_hosts is missing', async () => {
            const knownHostsPath = join(dir, 'absent')
            await expect(
                openTunnel(unpinned(), 'db', 5432, 'test', { knownHostsPath })
            ).rejects.toThrow(
                'ssh host key ' +
                    fingerprint(ssh2State.state.hostKey) +
                    ' for bastion:2222 is not in known_hosts'
            )
        })
    })
})
