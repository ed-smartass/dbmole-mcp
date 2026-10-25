// MySQL 8.4 reserved words: the entries marked (R) in
// https://dev.mysql.com/doc/refman/8.4/en/keywords.html, lowercased.
export const MYSQL_RESERVED: ReadonlySet<string> = new Set(
    `
accessible add all alter analyze and as asc asensitive before between bigint binary blob both
by call cascade case change char character check collate column condition constraint continue
convert create cross cube cume_dist current_date current_time current_timestamp current_user
cursor database databases day_hour day_microsecond day_minute day_second dec decimal declare
default delayed delete dense_rank desc describe deterministic distinct distinctrow div double
drop dual each else elseif empty enclosed escaped except exists exit explain false fetch
first_value float float4 float8 for force foreign from fulltext function generated get grant
group grouping groups having high_priority hour_microsecond hour_minute hour_second if ignore
in index infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer intersect
interval into io_after_gtids io_before_gtids is iterate join json_table key keys kill lag
last_value lateral lead leading leave left like limit linear lines load localtime
localtimestamp lock long longblob longtext loop low_priority match maxvalue mediumblob
mediumint mediumtext middleint minute_microsecond minute_second mod modifies natural not
no_write_to_binlog nth_value ntile null numeric of on optimize optimizer_costs option
optionally or order out outer outfile over partition percent_rank precision primary procedure
purge qualify range rank read reads read_write real recursive references regexp release rename
repeat replace require resignal restrict return revoke right rlike row row_number rows schema
schemas second_microsecond select sensitive separator set show signal smallint spatial specific
sql sql_big_result sql_calc_found_rows sqlexception sql_small_result sqlstate sqlwarning ssl
starting stored straight_join system table tablesample terminated then tinyblob tinyint
tinytext to trailing trigger true undo union unique unlock unsigned update usage use using
utc_date utc_time utc_timestamp values varbinary varchar varcharacter varying virtual when
where while window with write xor year_month zerofill
`
        .trim()
        .split(/\s+/)
)

export const HINT_TIMEOUT_MS = 2000

export type HintQuery = (sql: string, params: unknown[]) => Promise<unknown[][]>

const ER_BAD_FIELD_ERROR = 1054
const ER_PARSE_ERROR = 1064
const ER_NO_SUCH_TABLE = 1146
const MAX_TABLES = 5
const MAX_COLUMNS = 60
const MAX_SUGGESTIONS = 5

// Reserved words that usually just follow the real mistake (e.g. a trailing comma
// before FROM) instead of being a misused identifier.
// ponytail: fixed list; widen it if the hint misleads on other clause words.
const CLAUSE_WORDS: ReadonlySet<string> = new Set(
    `
select from where join on group order having limit union and or not as set values into inner
left right using when then else case in is null like between
`
        .trim()
        .split(/\s+/)
)

const TABLE_REF =
    /\b(?:from|join|update|into)\s+((?:`[^`]+`|[\w$]+)(?:\s*\.\s*(?:`[^`]+`|[\w$]+))?)/gi

// Tables named after FROM/JOIN/UPDATE/INTO, backticks stripped, db.table kept.
// ponytail: regex, not a parser; comma joins and quoted strings can miss or add names.
export const extractTables = (sql: string): string[] => {
    const found = new Set<string>()
    for (const match of sql.matchAll(TABLE_REF)) {
        found.add(match[1].replace(/\s*\.\s*/, '.').replace(/`/g, ''))
    }
    return [...found]
}

export const nearToken = (message: string): string | undefined =>
    /near '([A-Za-z_][\w$]*)/.exec(message)?.[1]

const splitName = (name: string): { schema?: string; table: string } => {
    const dot = name.indexOf('.')
    return dot > 0 ? { schema: name.slice(0, dot), table: name.slice(dot + 1) } : { table: name }
}

// lower_case_table_names=1/2 servers report `users` for `FROM Users`.
const sameName = (catalog: unknown, wanted: string): boolean =>
    String(catalog).toLowerCase() === wanted.toLowerCase()

// Containment only for parts of 3+ chars: table `a` is inside almost any name.
const MIN_CONTAINED = 3
const contains = (outer: string, inner: string): boolean =>
    inner.length >= MIN_CONTAINED && outer.includes(inner)

const levenshtein = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i += 1) {
        const row = [i]
        for (let j = 1; j <= b.length; j += 1) {
            const swap = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            row.push(Math.min(prev[j] + 1, row[j - 1] + 1, swap))
        }
        prev = row
    }
    return prev[b.length]
}

const columnsHint = async (
    sql: string,
    database: string | null,
    run: HintQuery
): Promise<string | undefined> => {
    const targets = extractTables(sql)
        .slice(0, MAX_TABLES)
        .flatMap((name) => {
            const { schema, table } = splitName(name)
            const resolved = schema ?? database
            return resolved ? [{ label: name, schema: resolved, table }] : []
        })
    if (targets.length === 0) {
        return undefined
    }
    const rows = await run(
        'SELECT table_schema, table_name, column_name FROM information_schema.columns ' +
            'WHERE (table_schema, table_name) IN (' +
            targets.map(() => '(?, ?)').join(', ') +
            ') ORDER BY ordinal_position',
        targets.flatMap((target) => [target.schema, target.table])
    )
    const parts = targets.flatMap((target) => {
        const columns = rows
            .filter((row) => sameName(row[0], target.schema) && sameName(row[1], target.table))
            .map((row) => String(row[2]))
        if (columns.length === 0) {
            return []
        }
        const shown = columns.slice(0, MAX_COLUMNS).join(', ')
        const more =
            columns.length > MAX_COLUMNS ? ', … (+' + (columns.length - MAX_COLUMNS) + ' more)' : ''
        return ['columns of ' + target.label + ': ' + shown + more]
    })
    return parts.length > 0 ? parts.join('; ') : undefined
}

const tablesHint = async (message: string, run: HintQuery): Promise<string | undefined> => {
    const missing = /Table '([^']+)' doesn't exist/.exec(message)
    if (!missing) {
        return undefined
    }
    const { schema, table } = splitName(missing[1])
    if (!schema) {
        return undefined
    }
    const wanted = table.toLowerCase()
    const rows = await run(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
        [schema]
    )
    const similar = rows
        .map((row) => String(row[0]))
        .map((name) => {
            const lower = name.toLowerCase()
            const distance = levenshtein(wanted, lower)
            const related = distance <= 2 || contains(lower, wanted) || contains(wanted, lower)
            return { name, distance, related }
        })
        .filter((candidate) => candidate.related)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_SUGGESTIONS)
        .map((candidate) => candidate.name)
    return similar.length > 0
        ? 'similar tables in ' + schema + ': ' + similar.join(', ')
        : undefined
}

const reservedHint = (message: string): string | undefined => {
    const word = nearToken(message)?.toLowerCase()
    if (!word || !MYSQL_RESERVED.has(word) || CLAUSE_WORDS.has(word)) {
        return undefined
    }
    return (
        "'" + word + "' is a reserved word in MySQL; quote it with backticks if it is an identifier"
    )
}

const buildHint = async (
    error: unknown,
    ctx: { sql: string; database: string | null; run: HintQuery }
): Promise<string | undefined> => {
    if (!(error instanceof Error) || !('errno' in error)) {
        return undefined
    }
    if (error.errno === ER_BAD_FIELD_ERROR) {
        return columnsHint(ctx.sql, ctx.database, ctx.run)
    }
    if (error.errno === ER_NO_SUCH_TABLE) {
        return tablesHint(error.message, ctx.run)
    }
    if (error.errno === ER_PARSE_ERROR) {
        return reservedHint(error.message)
    }
    return undefined
}

// Best-effort extra context for a failed statement. Never throws; gives up after
// timeoutMs so a slow catalog never delays the original error for long.
export const mysqlHint = async (
    error: unknown,
    ctx: { sql: string; database: string | null; run: HintQuery; timeoutMs?: number }
): Promise<string | undefined> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ctx.timeoutMs ?? HINT_TIMEOUT_MS)
    })
    try {
        return await Promise.race([buildHint(error, ctx).catch(() => undefined), timeout])
    } finally {
        clearTimeout(timer)
    }
}
