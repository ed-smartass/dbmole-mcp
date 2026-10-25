import { describe, expect, it } from 'vitest'
import { removedConfigHint } from '../../src/legacyConfig.js'

describe('removedConfigHint', () => {
    it('is silent without the removed env vars or --config', () => {
        expect(removedConfigHint('dbmole', { DBMOLE_STORE: '/s' }, ['node', 'x'])).toBeUndefined()
    })

    it('names what was set and points at the project file and global store', () => {
        expect(
            removedConfigHint('dbmole', { DBMOLE_CONNECTIONS: '[]', DBMOLE_CONFIG: '' }, [
                'node',
                'x',
                '--config=/c.json'
            ])
        ).toBe(
            'dbmole: DBMOLE_CONNECTIONS, DBMOLE_CONFIG, --config: removed in 0.2 and ignored; ' +
                'use the project file .dbmole.json or the global store'
        )
    })

    it('uses the server name for the env prefix and project file', () => {
        expect(removedConfigHint('esmole', {}, ['node', 'x', '--config', '/c.json'])).toBe(
            'esmole: --config: removed in 0.2 and ignored; ' +
                'use the project file .esmole.json or the global store'
        )
    })
})
