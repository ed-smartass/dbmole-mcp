import { strictInput, withManaged } from '@dbmole/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import { type DbManager, formatError, isLostConnection } from '../wiring.js'

// Fixed read-only catalog queries: safe to replay once after a lost connection.
const RETRY_SAFE = { formatError, isLostConnection, retrySafe: true }

const connectionField = z.string().describe('connection name, see list_connections')

export const registerSchemaTools = (server: McpServer, manager: DbManager): void => {
    server.registerTool(
        'list_databases',
        {
            description:
                'List databases on a connection with size in bytes. Hides postgres template databases and mysql system schemas.',
            inputSchema: strictInput({ connection: connectionField })
        },
        async ({ connection }) =>
            withManaged(
                manager,
                connection,
                (managed) => managed.backend.listDatabases(),
                RETRY_SAFE
            )
    )

    server.registerTool(
        'list_tables',
        {
            description:
                'List tables and views (type: table | view) with approximate row counts. For postgres, optionally filter by schema; for mysql, schema is the database.',
            inputSchema: strictInput(
                {
                    connection: connectionField,
                    database: z.string().optional(),
                    schema: z.string().optional()
                },
                { db: 'database' }
            )
        },
        async ({ connection, database, schema }) =>
            withManaged(
                manager,
                connection,
                (managed) => managed.backend.listTables({ database, schema }),
                RETRY_SAFE
            )
    )

    server.registerTool(
        'describe_table',
        {
            description:
                'Describe a table or view: columns (type, nullable, default), primary key, indexes and foreign keys.',
            inputSchema: strictInput(
                {
                    connection: connectionField,
                    table: z
                        .string()
                        .min(1)
                        .describe(
                            'table name; may be qualified: schema.table (postgres), db.table (mysql)'
                        ),
                    database: z.string().optional(),
                    schema: z.string().optional().describe('postgres schema, defaults to public')
                },
                { name: 'table', db: 'database' }
            )
        },
        async ({ connection, table, database, schema }) =>
            withManaged(
                manager,
                connection,
                (managed) => managed.backend.describeTable({ table, database, schema }),
                RETRY_SAFE
            )
    )
}
