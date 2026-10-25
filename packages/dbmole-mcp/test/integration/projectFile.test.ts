import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbManager, createDbRegistry, type DbManager } from '../../src/wiring.js'

// The project file is re-read on every call: editing .dbmole.json mid-session
// must reach the next call through the manager without a restart.
describe('project file hot reload', () => {
    let container: StartedPostgreSqlContainer | undefined
    let dir = ''
    let manager: DbManager | undefined

    beforeAll(async () => {
        container = await new PostgreSqlContainer('postgres:17-alpine').start()
        dir = mkdtempSync(join(tmpdir(), 'dbmole-int-project-'))
        manager = createDbManager(
            createDbRegistry({ cwd: dir, env: { DBMOLE_STORE: join(dir, 'store.json') } })
        )
    })

    afterAll(async () => {
        await manager?.disposeAll().catch(() => {})
        await container?.stop().catch(() => {})
        rmSync(dir, { recursive: true, force: true })
    })

    const pg = (): StartedPostgreSqlContainer => {
        if (!container) {
            throw new Error('setup failed: container not initialized')
        }
        return container
    }

    const db = (): DbManager => {
        if (!manager) {
            throw new Error('setup failed: manager not initialized')
        }
        return manager
    }

    const writeProject = (database: string): void => {
        const app = {
            name: 'app',
            type: 'postgres',
            host: pg().getHost(),
            port: pg().getPort(),
            user: pg().getUsername(),
            password: pg().getPassword(),
            database
        }
        writeFileSync(join(dir, '.dbmole.json'), JSON.stringify({ connections: [app] }))
    }

    const run = async (sql: string): Promise<unknown[][]> => {
        const { backend, source } = await db().get('app')
        expect(source).toBe('project')
        return (await backend.query({ sql, rowLimit: 10 })).rows
    }

    it('uses the edited project file on the next call', async () => {
        writeProject(pg().getDatabase())
        expect(await run('SELECT current_database()')).toEqual([[pg().getDatabase()]])
        await run('CREATE DATABASE other')

        writeProject('other')

        expect(await run('SELECT current_database()')).toEqual([['other']])
    })
})
