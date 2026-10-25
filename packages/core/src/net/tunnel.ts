import { readFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from '../config/baseSchema.js'
import { checkHostKey } from './knownHosts.js'

export type Tunnel = {
    localHost: string
    localPort: number
    isClosed: () => boolean
    close: () => Promise<void>
}

export const expandHome = (path: string): string => {
    if (path === '~' || path.startsWith('~/')) {
        return homedir() + path.slice(1)
    }
    return path
}

export const buildSshAuth = (
    ssh: SshConfig,
    env: NodeJS.ProcessEnv = process.env
): Partial<ConnectConfig> => {
    if (ssh.privateKey) {
        return { privateKey: ssh.privateKey, passphrase: ssh.passphrase }
    }
    if (ssh.privateKeyPath) {
        return {
            privateKey: readFileSync(expandHome(ssh.privateKeyPath), 'utf8'),
            passphrase: ssh.passphrase
        }
    }
    if (ssh.agent) {
        // Enabling agent is explicit intent: never silently fall through to
        // password when the socket var is missing.
        if (!env.SSH_AUTH_SOCK) {
            throw new Error('ssh agent auth requested but SSH_AUTH_SOCK is not set')
        }
        return { agent: env.SSH_AUTH_SOCK }
    }
    if (ssh.password) {
        return { password: ssh.password }
    }
    throw new Error(
        'ssh config needs one of: privateKey, privateKeyPath, agent (with SSH_AUTH_SOCK set), password'
    )
}

// A missing or unreadable known_hosts file means no entries.
const readKnownHosts = (path: string): string => {
    try {
        return readFileSync(path, 'utf8')
    } catch {
        return ''
    }
}

export const openTunnel = async (
    ssh: SshConfig,
    dstHost: string,
    dstPort: number,
    logLabel: string = 'ssh-tunnel',
    opts: { knownHostsPath?: string } = {}
): Promise<Tunnel> => {
    const client = new Client()
    const knownHostsPath = opts.knownHostsPath ?? join(homedir(), '.ssh', 'known_hosts')
    // ssh2 only reports 'Host denied (verification failed)'; keep our reason.
    let hostKeyError: string | undefined
    // Persistent, attached before connect: the once-reject below is gone after the
    // first error, and any later ssh error (failed connect or not) must not crash
    // the process.
    client.on('error', (error) => {
        console.error(logLabel + ': ssh tunnel error: ' + error.message)
    })

    await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', (error) => {
            reject(hostKeyError === undefined ? error : new Error(hostKeyError))
        })
        client.connect({
            host: ssh.host,
            port: ssh.port,
            username: ssh.user,
            ...buildSshAuth(ssh),
            // Half-open tunnels: 3 unanswered keepalives 15 s apart close the
            // client, which marks the tunnel closed so the manager rebuilds it.
            keepaliveInterval: 15_000,
            keepaliveCountMax: 3,
            hostVerifier: (key: Buffer): boolean => {
                const check = checkHostKey({
                    host: ssh.host,
                    port: ssh.port,
                    key,
                    pinned: ssh.hostKey,
                    knownHosts: ssh.hostKey === undefined ? readKnownHosts(knownHostsPath) : ''
                })
                if (!check.ok) {
                    hostKeyError = check.message
                }
                return check.ok
            }
        })
    })

    let closed = false
    const sockets = new Set<net.Socket>()

    const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => {
            sockets.delete(socket)
        })
        client.forwardOut(
            socket.remoteAddress ?? '127.0.0.1',
            socket.remotePort ?? 0,
            dstHost,
            dstPort,
            (error, stream) => {
                if (error || !stream) {
                    socket.destroy()
                    return
                }
                // The tunnel may have closed (or the socket been torn down)
                // while forwardOut was in flight; if so, drop the freshly
                // forwarded channel instead of wiring it to a dead socket.
                if (closed || socket.destroyed) {
                    socket.destroy()
                    stream.destroy()
                    return
                }
                socket.pipe(stream)
                stream.pipe(socket)
                stream.on('close', () => {
                    socket.destroy()
                })
                socket.on('close', () => {
                    stream.destroy()
                })
                stream.on('error', () => {
                    socket.destroy()
                })
                socket.on('error', () => {
                    stream.destroy()
                })
            }
        )
    })

    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })
    } catch (error) {
        client.end()
        throw error
    }

    const address = server.address() as net.AddressInfo

    // Idempotently mark the tunnel dead and stop the local listener so the
    // manager notices on the next get() and rebuilds.
    const markClosed = (): void => {
        if (closed) {
            return
        }
        closed = true
        server.close()
    }

    // listen() only attached a once-reject error handler that is now settled;
    // without a persistent one, a later listener error is swallowed and the
    // tunnel silently serves a dead socket. Mark it closed instead.
    server.on('error', (error) => {
        console.error(logLabel + ': tunnel listener error: ' + error.message)
        markClosed()
    })

    // A dead ssh connection must stop the local listener. ssh2 emits 'end'
    // before 'close'; handle both so the dead window is as small as possible.
    client.on('end', markClosed)
    client.on('close', markClosed)

    const isClosed = (): boolean => closed

    const close = async () => {
        closed = true
        // server.close() waits for active sockets to finish, so destroy the
        // forwarded sockets first or close() can hang indefinitely.
        for (const socket of sockets) {
            socket.destroy()
        }
        sockets.clear()
        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve()
            })
        })
        client.end()
    }

    return { localHost: '127.0.0.1', localPort: address.port, isClosed, close }
}
