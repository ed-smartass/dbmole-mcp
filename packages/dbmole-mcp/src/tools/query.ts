import { clampLimit, MAX_ROW_LIMIT, strictInput, withManaged } from '@dbmole/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import { type DbManager, formatError, isLostConnection } from '../wiring.js'

const executeSqlInput = strictInput(
    {
        connection: z.string().describe('connection name, see list_connections'),
        sql: z.string().min(1),
        params: z
            .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional()
            .describe('positional query parameters'),
        database: z
            .string()
            .optional()
            .describe('database to run against; defaults to the connection default'),
        rowLimit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional()
    },
    { query: 'sql', statement: 'sql', db: 'database', limit: 'rowLimit' }
)

export const registerQueryTools = (server: McpServer, manager: DbManager): void => {
    server.registerTool(
        'execute_sql',
        {
            description:
                'Execute a single SQL statement on a named connection. SELECT returns columns/rows; ' +
                'DML returns rowCount (and lastInsertId for mysql). Use positional params: $1.. for postgres, ? for mysql.',
            inputSchema: executeSqlInput
        },
        async ({ connection, sql, params, database, rowLimit }) =>
            // No retrySafe: after a lost connection the statement may already have
            // run (routines, dblink), so it is reported, never replayed.
            withManaged(
                manager,
                connection,
                (managed) =>
                    managed.backend.query({
                        sql,
                        params: params ?? [],
                        database,
                        rowLimit: clampLimit(rowLimit)
                    }),
                { formatError, isLostConnection }
            )
    )
}
