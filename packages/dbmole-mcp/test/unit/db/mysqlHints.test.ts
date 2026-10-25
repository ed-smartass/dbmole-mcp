import { describe, expect, it, vi } from 'vitest'
import {
    extractTables,
    type HintQuery,
    MYSQL_RESERVED,
    mysqlHint,
    nearToken
} from '../../../src/db/mysqlHints.js'

// Messages and statements adapted from real failed execute_sql calls; schema names
// genericized.
const mysqlError = (errno: number, code: string, message: string): Error =>
    Object.assign(new Error(message), { errno, code, sqlMessage: message })

const badField = (column: string) =>
    mysqlError(1054, 'ER_BAD_FIELD_ERROR', "Unknown column '" + column + "' in 'field list'")

const PARSE_PREFIX =
    'You have an error in your SQL syntax; check the manual that corresponds to your MySQL ' +
    'server version for the right syntax to use near '

const parseError = (near: string) =>
    mysqlError(1064, 'ER_PARSE_ERROR', PARSE_PREFIX + "'" + near + "' at line 1")

describe('MYSQL_RESERVED', () => {
    it('holds the 8.4 reserved words seen in real failures', () => {
        for (const word of ['keys', 'stored', 'reads', 'fetch', 'empty', 'by', 'rank', 'groups']) {
            expect(MYSQL_RESERVED.has(word)).toBe(true)
        }
        expect(MYSQL_RESERVED.size).toBe(262)
    })

    it('does not hold non-reserved keywords', () => {
        for (const word of ['user', 'status', 'name', 'text', 'json']) {
            expect(MYSQL_RESERVED.has(word)).toBe(false)
        }
    })
})

describe('extractTables', () => {
    it('reads FROM and JOIN targets, ignoring aliases', () => {
        expect(
            extractTables(
                'SELECT c.id, c.name, u.username FROM channel c LEFT JOIN user u ON u.id = c.archived_by'
            )
        ).toEqual(['channel', 'user'])
    })

    it('keeps db.table qualifiers and strips backticks', () => {
        expect(extractTables('SELECT a.id FROM app_v4.account a WHERE a.id = 3')).toEqual([
            'app_v4.account'
        ])
        expect(extractTables('SELECT `key` FROM `app` . `setting`')).toEqual(['app.setting'])
    })

    it('tolerates subqueries and dedupes', () => {
        expect(
            extractTables(
                'select r.id, (select count(*) from beat b where b.run_id = r.id) av ' +
                    'from run r join beat b2 on b2.run_id = r.id'
            )
        ).toEqual(['beat', 'run'])
        expect(extractTables('SELECT * FROM (SELECT 1) x')).toEqual([])
    })

    it('reads UPDATE and INSERT INTO targets', () => {
        expect(extractTables('UPDATE run SET attention = 1')).toEqual(['run'])
        expect(extractTables('INSERT INTO job (kind) VALUES (1)')).toEqual(['job'])
    })
})

describe('nearToken', () => {
    it('returns the first word after near', () => {
        expect(
            nearToken(PARSE_PREFIX + "'keys,json_extract(data,'$.client') client' at line 1")
        ).toBe('keys')
        expect(nearToken(PARSE_PREFIX + "'fetch)) fetch_jobs, ROUND(AVG(tr))' at line 1")).toBe(
            'fetch'
        )
        expect(nearToken(PARSE_PREFIX + "'stored FROM video v JOIN channel c' at line 1")).toBe(
            'stored'
        )
    })

    it('returns undefined when there is no word', () => {
        expect(nearToken(PARSE_PREFIX + "'' at line 1")).toBeUndefined()
        expect(nearToken('Unknown column')).toBeUndefined()
    })
})

describe('mysqlHint', () => {
    const neverRun: HintQuery = async () => {
        throw new Error('should not query')
    }

    it('lists the real columns on ER_BAD_FIELD_ERROR', async () => {
        const run = vi.fn<HintQuery>(async () => [
            ['main', 'job', 'id'],
            ['main', 'job', 'run_id'],
            ['main', 'job', 'attempts']
        ])
        const hint = await mysqlHint(badField('j.attempt'), {
            sql: "SELECT j.run_id, j.attempt FROM job j WHERE j.kind = 'avatar'",
            database: 'main',
            run
        })
        expect(hint).toBe('columns of job: id, run_id, attempts')
        expect(run).toHaveBeenCalledTimes(1)
        expect(run.mock.calls[0][0]).toContain('information_schema.columns')
        expect(run.mock.calls[0][1]).toEqual(['main', 'job'])
    })

    it('uses the db qualifier and covers joined tables in one query', async () => {
        const run = vi.fn<HintQuery>(async () => [
            ['shop', 'channel', 'channel_id'],
            ['main', 'user', 'user_id'],
            ['main', 'user', 'username']
        ])
        const hint = await mysqlHint(badField('c.id'), {
            sql: 'SELECT c.id FROM shop.channel c LEFT JOIN user u ON u.user_id = c.owner_id',
            database: 'main',
            run
        })
        expect(hint).toBe('columns of shop.channel: channel_id; columns of user: user_id, username')
        expect(run.mock.calls[0][1]).toEqual(['shop', 'channel', 'main', 'user'])
    })

    it('caps long column lists', async () => {
        const run: HintQuery = async () =>
            Array.from({ length: 65 }, (_, i) => ['main', 'wide', 'c' + i])
        const hint = await mysqlHint(badField('x'), {
            sql: 'SELECT x FROM wide',
            database: 'main',
            run
        })
        expect(hint).toMatch(/^columns of wide: c0, c1, .*c59, … \(\+5 more\)$/)
    })

    it('skips unqualified tables without a current database', async () => {
        const hint = await mysqlHint(badField('x'), {
            sql: 'SELECT x FROM t',
            database: null,
            run: neverRun
        })
        expect(hint).toBeUndefined()
    })

    it('suggests similar tables on ER_NO_SUCH_TABLE', async () => {
        const run = vi.fn<HintQuery>(async () => [
            ['setting'],
            ['user_profile'],
            ['video'],
            ['settings_log']
        ])
        const hint = await mysqlHint(
            mysqlError(1146, 'ER_NO_SUCH_TABLE', "Table 'crm.settings' doesn't exist"),
            { sql: 'select name from settings', database: 'crm', run }
        )
        expect(hint).toBe('similar tables in crm: setting, settings_log')
        expect(run.mock.calls[0][1]).toEqual(['crm'])
    })

    it('matches by containment and caps suggestions at 5', async () => {
        const run: HintQuery = async () =>
            ['user_profile', 'profile_a', 'profile_b', 'profile_c', 'profile_d', 'profiles'].map(
                (name) => [name]
            )
        const hint = await mysqlHint(
            mysqlError(1146, 'ER_NO_SUCH_TABLE', "Table 'crm.profile' doesn't exist"),
            { sql: 'SELECT * FROM profile p', database: 'crm', run }
        )
        expect(hint?.startsWith('similar tables in crm: profiles, ')).toBe(true)
        expect(hint?.split(', ')).toHaveLength(5)
    })

    it('matches catalog names case-insensitively', async () => {
        const run: HintQuery = async () => [['main', 'users', 'id']]
        const hint = await mysqlHint(badField('x'), {
            sql: 'SELECT x FROM Main.Users',
            database: 'main',
            run
        })
        expect(hint).toBe('columns of Main.Users: id')
    })

    it('skips containment for names shorter than 3 characters', async () => {
        const hint = await mysqlHint(
            mysqlError(1146, 'ER_NO_SUCH_TABLE', "Table 'crm.orders_archive' doesn't exist"),
            {
                sql: 'SELECT * FROM orders_archive',
                database: 'crm',
                run: async () => [['a'], ['or'], ['orders']]
            }
        )
        expect(hint).toBe('similar tables in crm: orders')
    })

    it('returns undefined when nothing is similar', async () => {
        const hint = await mysqlHint(
            mysqlError(1146, 'ER_NO_SUCH_TABLE', "Table 'crm.zzz' doesn't exist"),
            { sql: 'SELECT * FROM zzz', database: 'crm', run: async () => [['video']] }
        )
        expect(hint).toBeUndefined()
    })

    it('flags a reserved word near a parse error', async () => {
        const hint = await mysqlHint(parseError('keys FROM asset'), {
            sql: 'select json_keys(data) keys from asset',
            database: 'main',
            run: neverRun
        })
        expect(hint).toBe(
            "'keys' is a reserved word in MySQL; quote it with backticks if it is an identifier"
        )
    })

    it('ignores clause words and non-reserved words near a parse error', async () => {
        for (const near of ['FROM users', 'status FROM x', '']) {
            const hint = await mysqlHint(parseError(near), {
                sql: 'SELECT a, FROM users',
                database: 'main',
                run: neverRun
            })
            expect(hint).toBeUndefined()
        }
    })

    it('ignores other errors and non-errors', async () => {
        const ctx = { sql: 'SELECT 1', database: 'main', run: neverRun }
        expect(await mysqlHint(mysqlError(1045, 'ER_ACCESS_DENIED_ERROR', 'denied'), ctx)).toBe(
            undefined
        )
        expect(await mysqlHint(new Error('plain'), ctx)).toBeUndefined()
        expect(await mysqlHint('boom', ctx)).toBeUndefined()
    })

    it('swallows lookup failures', async () => {
        const hint = await mysqlHint(badField('x'), {
            sql: 'SELECT x FROM t',
            database: 'main',
            run: neverRun
        })
        expect(hint).toBeUndefined()
    })

    it('gives up after timeoutMs', async () => {
        vi.useFakeTimers()
        try {
            const pending = mysqlHint(badField('x'), {
                sql: 'SELECT x FROM t',
                database: 'main',
                run: () => new Promise(() => {}),
                timeoutMs: 50
            })
            await vi.advanceTimersByTimeAsync(50)
            expect(await pending).toBeUndefined()
        } finally {
            vi.useRealTimers()
        }
    })
})
