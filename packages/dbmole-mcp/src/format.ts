export const normalizeCell = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(normalizeCell)
    }
    if (typeof value === 'bigint') {
        return value.toString()
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    if (Buffer.isBuffer(value)) {
        return '\\x' + value.toString('hex')
    }
    return value
}

type DbErrorShape = Error & {
    code?: string | number
    detail?: string
    hint?: string
    sqlMessage?: string
}

export const formatDbError = (engine: string, error: unknown): string => {
    if (error instanceof Error) {
        const e = error as DbErrorShape
        const code = e.code !== undefined && e.code !== null ? ' ' + e.code : ''
        const message = e.sqlMessage ?? e.message
        const extras = [e.detail, e.hint].filter(Boolean).join(' | ')
        const suffix = extras ? ' (' + extras + ')' : ''
        return '[' + engine + code + '] ' + message + suffix
    }
    return '[' + engine + '] ' + String(error)
}
