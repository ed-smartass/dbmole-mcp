// 0.1 read connections from <SERVER>_CONNECTIONS / <SERVER>_CONFIG / --config.
// 0.2 ignores them; say so once at startup instead of failing silently.
export const removedConfigHint = (
    server: string,
    env: NodeJS.ProcessEnv,
    argv: string[]
): string | undefined => {
    const prefix = server.toUpperCase()
    const found = [prefix + '_CONNECTIONS', prefix + '_CONFIG'].filter(
        (key) => env[key] !== undefined
    )
    if (argv.some((arg) => arg === '--config' || arg.startsWith('--config='))) {
        found.push('--config')
    }
    if (found.length === 0) {
        return undefined
    }
    return (
        server +
        ': ' +
        found.join(', ') +
        ': removed in 0.2 and ignored; use the project file .' +
        server +
        '.json or the global store'
    )
}
