export type Backend = { dispose: () => Promise<void> }

export type BackendTarget<TConfig> = {
    config: TConfig
    connectHost: string
    connectPort: number
    // The logical remote host (original config.host). When a tunnel is in play,
    // connectHost is 127.0.0.1; serverName carries the real host for TLS SNI /
    // certificate hostname verification. Backends that don't do TLS ignore it.
    serverName: string
}

export class BackendDisposedError extends Error {
    constructor() {
        super('connection was reconfigured or removed: retry the call')
        this.name = 'BackendDisposedError'
    }
}
