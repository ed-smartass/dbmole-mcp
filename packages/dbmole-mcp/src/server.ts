import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import pkg from '../package.json' with { type: 'json' }
import { registerConnectionTools } from './tools/connections.js'
import { registerQueryTools } from './tools/query.js'
import { registerSchemaTools } from './tools/schema.js'
import type { DbManager, DbRegistry } from './wiring.js'

export const SERVER_VERSION = pkg.version

export const createServer = (registry: DbRegistry, manager: DbManager): McpServer => {
    const server = new McpServer({ name: 'dbmole-mcp', version: SERVER_VERSION })
    registerConnectionTools(server, registry, manager)
    registerQueryTools(server, manager)
    registerSchemaTools(server, manager)
    return server
}
