import type { Truncation } from '@dbmole/core'
import type { ConnectionConfig } from '../schema.js'

export type QueryResult = {
    columns: string[]
    rows: unknown[][]
    rowCount: number
    truncated?: Truncation
    lastInsertId?: string
}

export type QueryArgs = {
    sql: string
    params?: unknown[]
    database?: string
    rowLimit: number
}

export type DatabaseInfo = {
    name: string
    sizeBytes: number | null
}

export type TableInfo = {
    schema: string
    name: string
    type: 'table' | 'view'
    rowEstimate: number | null
}

export type ColumnInfo = {
    name: string
    type: string
    nullable: boolean
    default: string | null
}

export type IndexInfo = {
    name: string
    columns: string[]
    unique: boolean
}

export type ForeignKeyInfo = {
    name: string
    columns: string[]
    referencedTable: string
    referencedColumns: string[]
}

export type TableDescription = {
    columns: ColumnInfo[]
    primaryKey: string[]
    indexes: IndexInfo[]
    foreignKeys: ForeignKeyInfo[]
}

export type Driver = {
    query: (args: QueryArgs) => Promise<QueryResult>
    listDatabases: () => Promise<DatabaseInfo[]>
    listTables: (args: { database?: string; schema?: string }) => Promise<TableInfo[]>
    describeTable: (args: {
        table: string
        database?: string
        schema?: string
    }) => Promise<TableDescription>
    serverVersion: () => Promise<string>
    dispose: () => Promise<void>
}

export type DriverTarget = {
    config: ConnectionConfig
    host: string
    port: number
    serverName: string
}

// Connections per database pool. Integration tests pass 1 so consecutive calls
// deterministically reuse one server session.
export type DriverOptions = {
    poolSize?: number
}

export const DEFAULT_POOL_SIZE = 4

export class MissingDatabaseError extends Error {
    constructor() {
        super(
            'no database specified: pass the database parameter or set a default database on the connection'
        )
        this.name = 'MissingDatabaseError'
    }
}

export const resolveDatabase = (config: ConnectionConfig, database?: string): string => {
    const resolved = database ?? config.database
    if (!resolved) {
        throw new MissingDatabaseError()
    }
    return resolved
}

// "a""b" → a"b, `a``b` → a`b: drops the enclosing delimiters and decodes the
// doubled ones inside. Anything else is returned as is.
const unquote = (name: string): string => {
    const quote = name[0]
    if (name.length < 2 || (quote !== '"' && quote !== '`') || !name.endsWith(quote)) {
        return name
    }
    return name.slice(1, -1).replaceAll(quote + quote, quote)
}

// 'schema.table' / 'db.table' → qualifier + table, split on the first dot outside
// double quotes / backticks, so '"my.table"' stays one name. Each side is then
// unquoted. An empty side leaves the name whole (then simply not found).
export const splitQualified = (table: string): { qualifier?: string; table: string } => {
    let quote = ''
    let dot = -1
    for (let i = 0; i < table.length && dot < 0; i++) {
        const ch = table[i]
        if (ch === quote) {
            quote = ''
        } else if (!quote && (ch === '"' || ch === '`')) {
            quote = ch
        } else if (!quote && ch === '.') {
            dot = i
        }
    }
    const qualifier = unquote(table.slice(0, Math.max(dot, 0)))
    const name = unquote(table.slice(dot + 1))
    if (!qualifier || !name) {
        return { table: unquote(table) }
    }
    return { qualifier, table: name }
}

// Merges a qualified table name with the explicit schema/database parameter.
// Both given and different is an error rather than a silent pick.
export const resolveQualified = (
    table: string,
    explicit: string | undefined,
    what: 'schema' | 'database'
): { qualifier?: string; table: string } => {
    const split = splitQualified(table)
    if (split.qualifier && explicit && split.qualifier !== explicit) {
        throw new Error(
            "table qualifier '" +
                split.qualifier +
                "' conflicts with " +
                what +
                " '" +
                explicit +
                "'"
        )
    }
    return { qualifier: split.qualifier ?? explicit, table: split.table }
}
