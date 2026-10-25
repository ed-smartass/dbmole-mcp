import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type * as z from 'zod'

// array = global store `[...]`, object = project file `{ "connections": [...] }`
export type LayerShape = 'array' | 'object'

export type LayerEntry<TConfig> =
    | { ok: true; raw: unknown; config: TConfig }
    | { ok: false; raw: unknown; name?: string; error: string }

export type LayerRead<TConfig> =
    | { status: 'missing' }
    | { status: 'broken'; error: string }
    | { status: 'ok'; entries: LayerEntry<TConfig>[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

// V8 messages can quote the source (`"{"password":x}" is not valid JSON`), and
// this error reaches list_connections: keep only the line/column, never text.
const jsonSyntaxMessage = (error: unknown): string => {
    const message = messageOf(error)
    const where = / in JSON at position \d+ \(line (\d+) column (\d+)\)$/.exec(message)
    if (where) {
        return 'syntax error at line ' + where[1] + ' column ' + where[2]
    }
    return message === 'Unexpected end of JSON input' ? 'unexpected end of input' : 'syntax error'
}

const zodMessage = (error: z.ZodError): string =>
    error.issues
        .map((issue) => (issue.path.length > 0 ? issue.path.join('.') + ': ' : '') + issue.message)
        .join('; ')

const parseEntry = <TConfig>(
    schema: z.ZodType<TConfig, z.ZodTypeDef, unknown>,
    raw: unknown
): LayerEntry<TConfig> => {
    const result = schema.safeParse(raw)
    if (result.success) {
        return { ok: true, raw, config: result.data }
    }
    const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name : undefined
    return { ok: false, raw, name, error: zodMessage(result.error) }
}

export const readLayerFile = <TConfig>(
    path: string,
    shape: LayerShape,
    schema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
): LayerRead<TConfig> => {
    let text: string
    try {
        text = readFileSync(path, 'utf8')
    } catch (error) {
        // A dangling symlink is ENOENT too, but it is a broken file, not a missing one.
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT' &&
            lstatSync(path, { throwIfNoEntry: false }) === undefined
        ) {
            return { status: 'missing' }
        }
        return { status: 'broken', error: 'cannot read file: ' + messageOf(error) }
    }
    let parsed: unknown
    try {
        // Windows editors may save a UTF-8 BOM, which JSON.parse rejects.
        parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch (error) {
        return { status: 'broken', error: 'invalid JSON: ' + jsonSyntaxMessage(error) }
    }
    const items = shape === 'array' ? parsed : isRecord(parsed) ? parsed.connections : undefined
    if (!Array.isArray(items)) {
        const expected = shape === 'array' ? 'a JSON array' : 'an object { "connections": [...] }'
        return { status: 'broken', error: 'expected ' + expected }
    }
    return { status: 'ok', entries: items.map((raw) => parseEntry(schema, raw)) }
}

// Atomic: write a unique tmp file (0600) next to the target, then rename.
export const writeLayerFile = (path: string, shape: LayerShape, raws: unknown[]): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const body = shape === 'array' ? raws : { connections: raws }
    const tmp = path + '.' + randomUUID() + '.tmp'
    try {
        writeFileSync(tmp, JSON.stringify(body, null, 4) + '\n', { mode: 0o600, flag: 'wx' })
        renameSync(tmp, path)
    } catch (error) {
        rmSync(tmp, { force: true })
        throw error
    }
}
