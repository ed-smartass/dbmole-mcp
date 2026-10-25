import { removedConfigHint } from '@dbmole/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { createDbManager, createDbRegistry } from './wiring.js'

const main = async () => {
    const hint = removedConfigHint('dbmole', process.env, process.argv.slice(2))
    if (hint !== undefined) {
        console.error(hint)
    }
    const registry = createDbRegistry()
    const manager = createDbManager(registry)
    const server = createServer(registry, manager)

    let shuttingDown = false
    const shutdown = async () => {
        if (shuttingDown) {
            return
        }
        shuttingDown = true
        // Close the transport first so no new request can create pools mid-teardown.
        await server.close().catch(() => {})
        await manager.disposeAll().catch(() => {})
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    process.stdin.on('close', shutdown)

    await server.connect(new StdioServerTransport())
    console.error('dbmole: MCP server listening on stdio')
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('dbmole: fatal: ' + message)
    process.exit(1)
})
