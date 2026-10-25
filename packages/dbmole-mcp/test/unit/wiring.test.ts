import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../../src/schema.js'
import { createDbManager, createDbRegistry, formatError } from '../../src/wiring.js'

const conn = (name: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    name,
    type: 'postgres',
    host: 'localhost',
    user: 'postgres',
    readonly: false,
    ...extra
})

describe('createDbManager', () => {
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'dbmole-wiring-'))
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('builds a postgres or mysql driver per connection type without connecting', async () => {
        const registry = createDbRegistry({ cwd: dir, env: { DBMOLE_STORE: join(dir, 'c.json') } })
        registry.add(conn('pg'), 'global')
        registry.add(conn('my', { type: 'mysql', port: 13306 }), 'global')
        const manager = createDbManager(registry)
        const pg = await manager.get('pg')
        const my = await manager.get('my')
        expect(typeof pg.backend.query).toBe('function')
        expect(typeof my.backend.query).toBe('function')
        expect(pg.backend).not.toBe(my.backend)
        await manager.disposeAll()
    })
})

describe('formatError', () => {
    it('prefixes the engine and the driver code', () => {
        const error = Object.assign(new Error('boom'), { code: '42P01' })
        expect(formatError(conn('c'), error)).toBe('[postgres 42P01] boom')
        expect(formatError(conn('m', { type: 'mysql' }), 'plain')).toBe('[mysql] plain')
    })
})
