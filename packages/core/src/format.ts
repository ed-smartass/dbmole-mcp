export const DEFAULT_ROW_LIMIT = 100
export const MAX_ROW_LIMIT = 1000
export const OUTPUT_BUDGET = 40_000
export const CELL_CAP = 2_000

export type Truncation =
    | { reason: 'rowLimit'; limit: number }
    | { reason: 'budget'; dropped: number; kept?: number }
    | { reason: 'too large'; bytes: number }

export const clampLimit = (
    requested: number | undefined,
    fallback = DEFAULT_ROW_LIMIT,
    max = MAX_ROW_LIMIT
): number => {
    if (requested === undefined) {
        return fallback
    }
    return Math.max(1, Math.min(Math.trunc(requested), max))
}

// Slice a string to at most `maxBytes` UTF-8 bytes without splitting a
// multi-byte sequence (back off to a code-point boundary).
export const sliceUtf8 = (s: string, maxBytes: number): string => {
    const buf = Buffer.from(s, 'utf8')
    if (buf.length <= maxBytes) {
        return s
    }
    let end = maxBytes
    while (end > 0 && (buf[end] & 0xc0) === 0x80) {
        end -= 1
    }
    return buf.subarray(0, end).toString('utf8')
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

// Deep copy of JSON-like data with every string longer than `cap` UTF-8 bytes
// cut to `cap` bytes plus a '…[+N bytes]' marker (N = bytes removed).
export const capStrings = (value: unknown, cap = CELL_CAP): unknown => {
    if (typeof value === 'string') {
        const size = byteLength(value)
        if (size <= cap) {
            return value
        }
        const kept = sliceUtf8(value, cap)
        return kept + '…[+' + (size - byteLength(kept)) + ' bytes]'
    }
    if (Array.isArray(value)) {
        return value.map((item) => capStrings(item, cap))
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, inner]) => [key, capStrings(inner, cap)])
        )
    }
    return value
}

type SqlLike = Record<string, unknown> & { columns: unknown[]; rows: unknown[] }

const isSqlResult = (value: unknown): value is SqlLike =>
    isRecord(value) && Array.isArray(value.columns) && Array.isArray(value.rows)

// Keep a marker the producer already set (e.g. the driver's rowLimit) when
// fitJson itself dropped nothing and only capped strings; with no producer
// marker, capped strings alone read { reason: 'budget', dropped: 0 }.
const budgetMark = (prior: unknown, dropped: number, kept?: number): unknown => {
    if (dropped === 0) {
        const mark: Truncation = { reason: 'budget', dropped: 0 }
        return prior ? prior : mark
    }
    const mark: Truncation =
        kept === undefined ? { reason: 'budget', dropped } : { reason: 'budget', dropped, kept }
    return mark
}

const fitSql = (result: SqlLike, text: string, budget: number, cap: number): string | undefined => {
    const rows = result.rows.map((row) => capStrings(row, cap))
    const cut = JSON.stringify(rows) !== JSON.stringify(result.rows)
    if (!cut && byteLength(text) <= budget) {
        return text
    }
    const all = JSON.stringify({ ...result, rows, truncated: budgetMark(result.truncated, 0) })
    if (byteLength(all) <= budget) {
        return all
    }
    const render = (kept: number): string =>
        JSON.stringify({
            ...result,
            rows: rows.slice(0, kept),
            rowCount: kept,
            truncated: budgetMark(result.truncated, rows.length - kept, kept)
        })
    if (byteLength(render(0)) > budget) {
        return undefined
    }
    // Every row can still fit when only the producer's rowCount made `all` too
    // big (render rewrites rowCount to the kept count).
    const full = render(rows.length)
    if (byteLength(full) <= budget) {
        return full
    }
    // Largest kept count that fits: render(lo) fits, render(hi) does not.
    let lo = 0
    let hi = rows.length
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2)
        if (byteLength(render(mid)) <= budget) {
            lo = mid
        } else {
            hi = mid
        }
    }
    return render(lo)
}

const longestArray = (node: unknown, best?: unknown[]): unknown[] | undefined => {
    let found = best
    if (Array.isArray(node)) {
        if (node.length > 0 && (found === undefined || node.length > found.length)) {
            found = node
        }
        for (const item of node) {
            found = longestArray(item, found)
        }
    } else if (isRecord(node)) {
        for (const child of Object.values(node)) {
            found = longestArray(child, found)
        }
    }
    return found
}

// ponytail: bounded passes, so a value made of thousands of tiny arrays falls
// back to the envelope instead of re-serializing thousands of times.
const MAX_PASSES = 64

const fitGeneric = (
    json: unknown,
    text: string,
    budget: number,
    cap: number
): string | undefined => {
    const prior = isRecord(json) ? json.truncated : undefined
    const work = capStrings(json, cap)
    if (byteLength(text) <= budget && JSON.stringify(work) === text) {
        return text
    }
    let dropped = 0
    const render = (): string => {
        const truncated = budgetMark(prior, dropped)
        return JSON.stringify(isRecord(work) ? { ...work, truncated } : { value: work, truncated })
    }
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
        const text = render()
        if (byteLength(text) <= budget) {
            return text
        }
        const longest = longestArray(work)
        if (longest === undefined) {
            return undefined
        }
        const keep = Math.floor(longest.length / 2)
        dropped += longest.length - keep
        longest.length = keep
    }
    return undefined
}

// Shrink the preview until the envelope fits. Re-escaping costs 1 or 2 output
// bytes per source byte ('"' and '\\' double), so cutting ceil(over / 2) source
// bytes never cuts more than needed and still strictly shrinks `room`.
const envelope = (text: string, budget: number): string => {
    const truncated: Truncation = { reason: 'too large', bytes: byteLength(text) }
    const render = (preview: string): string => JSON.stringify({ truncated, preview })
    let room = budget - byteLength(render(''))
    for (;;) {
        const out = render(room > 0 ? sliceUtf8(text, room) : '')
        const over = byteLength(out) - budget
        if (over <= 0 || room <= 0) {
            return out
        }
        room -= Math.ceil(over / 2)
    }
}

// Serialize `value` for a tool result: always valid JSON and at most `budget`
// UTF-8 bytes (for any budget that can hold the ~60-byte fallback envelope).
// Strings are capped first, even when the value is already under budget; the
// value passes through byte-identical only when nothing was cut.
export const fitJson = (value: unknown, budget = OUTPUT_BUDGET, cap = CELL_CAP): string => {
    const text = JSON.stringify(value) ?? 'null'
    const json: unknown = JSON.parse(text)
    const fitted = isSqlResult(json)
        ? fitSql(json, text, budget, cap)
        : fitGeneric(json, text, budget, cap)
    return fitted ?? envelope(text, budget)
}
