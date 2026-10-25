import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLayerFile } from '@dbmole/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../../src/schema.js'
import { createDbRegistry } from '../../src/wiring.js'

const conn = (name: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
    name,
    type: 'postgres',
    host: 'localhost',
    user: 'postgres',
    readonly: false,
    ...extra
})

describe('createDbRegistry', () => {
    let dir: string
    let storePath: string

    beforeEach(() => {
        // Its own git root, so an enclosing repo or symlinked tmpdir can't move the project file.
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'dbmole-registry-')))
        execFileSync('git', ['init', '-q', dir])
        storePath = join(dir, 'store', 'connections.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('uses .dbmole.json for the project layer and DBMOLE_STORE for the global one', () => {
        const registry = createDbRegistry({ cwd: dir, env: { DBMOLE_STORE: storePath } })
        expect(registry.paths()).toEqual({ project: join(dir, '.dbmole.json'), global: storePath })
    })

    it('defaults the store to ~/.config/dbmole/connections.json', () => {
        const registry = createDbRegistry({ cwd: dir, env: {} })
        expect(registry.paths().global).toBe(
            join(homedir(), '.config', 'dbmole', 'connections.json')
        )
    })

    it('resolves the project file over the store, validated with the dbmole schema', () => {
        writeLayerFile(storePath, 'array', [conn('app', { host: 'global-host' }), conn('g')])
        writeFileSync(
            join(dir, '.dbmole.json'),
            JSON.stringify({
                connections: [
                    conn('app', { host: 'project-host' }),
                    { name: 'bad', type: 'oracle' }
                ]
            })
        )
        const registry = createDbRegistry({ cwd: dir, env: { DBMOLE_STORE: storePath } })
        expect(registry.resolve('app')).toMatchObject({
            source: 'project',
            config: { host: 'project-host' }
        })
        expect(registry.resolve('g').source).toBe('global')
        expect(() => registry.resolve('bad')).toThrow(
            "connection 'bad' in " + join(dir, '.dbmole.json') + ' is invalid'
        )
    })

    it('ignores the removed DBMOLE_CONNECTIONS and DBMOLE_CONFIG variables', () => {
        const configPath = join(dir, 'config.json')
        writeFileSync(configPath, JSON.stringify({ connections: [conn('from-config')] }))
        const registry = createDbRegistry({
            cwd: dir,
            env: {
                DBMOLE_STORE: storePath,
                DBMOLE_CONNECTIONS: JSON.stringify([conn('from-env')]),
                DBMOLE_CONFIG: configPath
            }
        })
        expect(registry.list()).toEqual({ connections: [], brokenLayers: [] })
    })
})
