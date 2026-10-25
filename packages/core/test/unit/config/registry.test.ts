import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import type { LayerName } from '../../../src/config/baseSchema.js'
import type { LayerEntry } from '../../../src/config/layerFile.js'
import {
    ConnectionNotFoundError,
    configHash,
    createFileRegistry,
    createRegistry,
    type LayerIO,
    type NamedConfig,
    RegistryError
} from '../../../src/config/registry.js'

const schema = z
    .object({
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        type: z.enum(['alpha', 'beta']),
        host: z.string().min(1),
        port: z.number().int().positive().optional(),
        label: z.string().optional(),
        ssh: z
            .object({
                host: z.string(),
                user: z.string(),
                password: z.string().optional(),
                hostKey: z.string().optional()
            })
            .strict()
            .optional()
    })
    .strict()

type Config = z.infer<typeof schema>

const conn = (name: string, extra: Partial<Config> = {}): Config => ({
    name,
    type: 'alpha',
    host: 'localhost',
    ...extra
})

// What a fake layer file holds: raw entries, nothing, or unparseable content.
type LayerState = unknown[] | 'missing' | { broken: string }

type FakeLayer = LayerIO<Config> & { state: LayerState; writes: number }

const nameOf = (raw: unknown): string | undefined => {
    if (typeof raw === 'object' && raw !== null && 'name' in raw && typeof raw.name === 'string') {
        return raw.name
    }
    return undefined
}

// Mirrors readLayerFile's per-entry validation, in memory.
const toEntry = (raw: unknown): LayerEntry<Config> => {
    const check = schema.safeParse(raw)
    if (check.success) {
        return { ok: true, raw, config: check.data }
    }
    return { ok: false, raw, name: nameOf(raw), error: check.error.issues[0].message }
}

const fakeLayer = (name: LayerName, state: LayerState = 'missing'): FakeLayer => {
    const layer: FakeLayer = {
        name,
        state,
        writes: 0,
        path: () => '/' + name + '.json',
        read: () => {
            if (layer.state === 'missing') {
                return { status: 'missing' }
            }
            if (!Array.isArray(layer.state)) {
                return { status: 'broken', error: layer.state.broken }
            }
            return { status: 'ok', entries: layer.state.map(toEntry) }
        },
        write: (raws) => {
            layer.writes += 1
            layer.state = raws
        }
    }
    return layer
}

const setup = (project: LayerState = 'missing', global: LayerState = 'missing') => {
    const layers = { project: fakeLayer('project', project), global: fakeLayer('global', global) }
    return { ...layers, registry: createRegistry({ schema, ...layers }) }
}

const BAD = { name: 'bad', type: 'gamma', host: 'h' }

describe('createRegistry: resolution', () => {
    it('prefers the project layer over the global one', () => {
        const { registry } = setup(
            [conn('a', { host: 'from-project' })],
            [conn('a', { host: 'from-global' }), conn('g')]
        )
        expect(registry.resolve('a')).toMatchObject({
            source: 'project',
            config: { host: 'from-project' }
        })
        expect(registry.resolve('g').source).toBe('global')
    })

    it('treats a missing file as an empty layer', () => {
        const { registry } = setup('missing', [conn('g')])
        expect(registry.resolve('g').source).toBe('global')
    })

    it('hashes the resolved config', () => {
        const { registry } = setup([conn('a')])
        expect(registry.resolve('a').hash).toBe(configHash(conn('a')))
    })

    it('throws not-found listing the names of both layers', () => {
        const { registry } = setup([conn('p')], [conn('g'), BAD])
        expect(() => registry.resolve('nope')).toThrow(ConnectionNotFoundError)
        expect(() => registry.resolve('nope')).toThrow('Available connections: bad, g, p')
    })

    it('an invalid project entry blocks a same-name global entry', () => {
        const { registry } = setup([BAD], [conn('bad')])
        expect(() => registry.resolve('bad')).toThrow(RegistryError)
        expect(() => registry.resolve('bad')).toThrow(
            "connection 'bad' in /project.json is invalid: "
        )
    })

    it('a name defined twice in one layer is an error, other names still resolve', () => {
        const { registry } = setup('missing', [conn('dup'), conn('dup', { host: 'x' }), conn('ok')])
        expect(() => registry.resolve('dup')).toThrow(
            "connection 'dup' is defined twice in /global.json"
        )
        expect(registry.resolve('ok').source).toBe('global')
    })

    it('a broken project file blocks every name', () => {
        const { registry } = setup({ broken: 'Unexpected token' }, [conn('g')])
        expect(() => registry.resolve('g')).toThrow(
            'connection file /project.json is broken: Unexpected token; fix or delete it'
        )
    })

    it('a broken global store blocks only names the project does not define', () => {
        const { registry } = setup([conn('p')], { broken: 'not an array' })
        expect(registry.resolve('p').source).toBe('project')
        expect(() => registry.resolve('g')).toThrow('connection file /global.json is broken')
    })

    it('re-reads both layers on every call', () => {
        const { registry, project } = setup()
        expect(() => registry.resolve('late')).toThrow(ConnectionNotFoundError)
        project.state = [conn('late')]
        expect(registry.resolve('late').source).toBe('project')
    })
})

describe('createRegistry: list', () => {
    it('lists names sorted with their winning layer and what they shadow', () => {
        const { registry } = setup([conn('b'), conn('shared')], [conn('a'), conn('shared')])
        const { connections, brokenLayers } = registry.list()
        expect(brokenLayers).toEqual([])
        expect(
            connections.map((c) => (c.ok ? [c.resolved.config.name, c.resolved.source] : []))
        ).toEqual([
            ['a', 'global'],
            ['b', 'project'],
            ['shared', 'project']
        ])
        expect(connections[2]).toMatchObject({ ok: true, shadows: 'global' })
        expect(connections[0]).not.toHaveProperty('shadows')
    })

    it('shows invalid and duplicated entries instead of hiding them', () => {
        const { registry } = setup([BAD], [conn('bad'), conn('dup'), conn('dup')])
        const { connections } = registry.list()
        expect(connections).toEqual([
            {
                ok: false,
                name: 'bad',
                source: 'project',
                error: expect.stringContaining("connection 'bad' in /project.json is invalid")
            },
            {
                ok: false,
                name: 'dup',
                source: 'global',
                error: "connection 'dup' is defined twice in /global.json"
            }
        ])
    })

    it('reports a broken layer and marks the names it blocks', () => {
        const { registry } = setup({ broken: 'bad json' }, [conn('g')])
        const { connections, brokenLayers } = registry.list()
        expect(brokenLayers).toEqual([
            { layer: 'project', path: '/project.json', error: 'bad json' }
        ])
        expect(connections).toEqual([
            {
                ok: false,
                name: 'g',
                source: 'global',
                error: 'connection file /project.json is broken: bad json; fix or delete it'
            }
        ])
    })

    it('sorts names case-insensitively, like 0.1', () => {
        const { registry } = setup([conn('B')], [conn('a'), conn('c')])
        expect(
            registry.list().connections.map((c) => (c.ok ? c.resolved.config.name : ''))
        ).toEqual(['a', 'B', 'c'])
        expect(() => registry.resolve('nope')).toThrow('Available connections: a, B, c')
    })

    it('a broken global store leaves project names usable', () => {
        const { registry } = setup([conn('p')], { broken: 'bad json' })
        const { connections, brokenLayers } = registry.list()
        expect(brokenLayers).toEqual([{ layer: 'global', path: '/global.json', error: 'bad json' }])
        expect(connections).toMatchObject([{ ok: true, resolved: { source: 'project' } }])
    })
})

describe('createRegistry: add', () => {
    it('adds to the requested layer only, keeping invalid entries verbatim', () => {
        const { registry, project, global } = setup('missing', [BAD])
        const added = registry.add(conn('fresh'), 'global')
        expect(added).toEqual({
            resolved: { config: conn('fresh'), source: 'global', hash: configHash(conn('fresh')) },
            notes: []
        })
        expect(global.state).toEqual([BAD, conn('fresh')])
        expect(project.writes).toBe(0)
    })

    it('creates a missing project file', () => {
        const { registry, project } = setup()
        expect(registry.add(conn('p'), 'project').resolved.source).toBe('project')
        expect(project.state).toEqual([conn('p')])
    })

    it('rejects a name that already exists in the target layer, even if invalid', () => {
        const { registry, project } = setup([conn('p'), BAD])
        expect(() => registry.add(conn('p'), 'project')).toThrow(
            "connection 'p' already exists in project (/project.json)"
        )
        expect(() => registry.add(conn('bad'), 'project')).toThrow('already exists')
        expect(project.writes).toBe(0)
    })

    it('allows a name from the other layer and says which entry shadows which', () => {
        const { registry } = setup([conn('p')], [conn('g')])
        expect(registry.add(conn('g'), 'project').notes).toEqual([
            "project connection 'g' shadows the global one in /global.json"
        ])
        expect(registry.add(conn('p'), 'global').notes).toEqual([
            "global connection 'p' is shadowed by the project one in /project.json; " +
                'the project entry stays active'
        ])
    })

    it('adding a global entry under an invalid project one notes nothing', () => {
        const { registry } = setup([BAD])
        expect(registry.add(conn('bad'), 'global').notes).toEqual([])
    })

    it('adding a global entry while the project file is broken says it cannot resolve yet', () => {
        const { registry, global } = setup({ broken: 'bad json' })
        expect(registry.add(conn('g'), 'global').notes).toEqual([
            'project file /project.json is broken: bad json; ' +
                'connections resolve only after it is fixed'
        ])
        expect(global.state).toEqual([conn('g')])
    })

    it('refuses to overwrite a broken layer file', () => {
        const { registry, global } = setup('missing', { broken: 'bad json' })
        expect(() => registry.add(conn('g'), 'global')).toThrow(
            'connection file /global.json is broken'
        )
        expect(global.writes).toBe(0)
    })
})

describe('createRegistry: update', () => {
    it('edits the winning layer and leaves the shadowed one alone', () => {
        const { registry, project, global } = setup(
            [conn('a', { host: 'p' }), BAD],
            [conn('a', { host: 'g' })]
        )
        const { resolved, notes } = registry.update('a', { host: 'new' })
        expect(resolved).toMatchObject({ source: 'project', config: { host: 'new' } })
        expect(notes).toEqual([])
        expect(project.state).toEqual([conn('a', { host: 'new' }), BAD])
        expect(global.writes).toBe(0)
    })

    it('sets fields and deletes them via null', () => {
        const { registry } = setup('missing', [conn('u', { label: 'old', port: 100 })])
        const { resolved } = registry.update('u', { label: 'new', port: null })
        expect(resolved.config.label).toBe('new')
        expect(resolved.config.port).toBeUndefined()
        expect(registry.resolve('u').config.label).toBe('new')
    })

    it('keeps the port when type is unchanged', () => {
        const { registry } = setup('missing', [conn('same', { port: 100 })])
        expect(registry.update('same', { label: 'x' }).resolved.config.port).toBe(100)
    })

    it('drops the inherited port when switching type without an explicit port', () => {
        const { registry } = setup('missing', [conn('switch', { port: 100 })])
        const { resolved } = registry.update('switch', { type: 'beta' })
        expect(resolved.config.type).toBe('beta')
        expect(resolved.config.port).toBeUndefined()
    })

    it('keeps an explicit port when switching type', () => {
        const { registry } = setup('missing', [conn('switch', { port: 100 })])
        expect(registry.update('switch', { type: 'beta', port: 200 }).resolved.config.port).toBe(
            200
        )
    })

    it('clears the port when switching type with an explicit null', () => {
        const { registry } = setup('missing', [conn('switch', { port: 100 })])
        const { resolved } = registry.update('switch', { type: 'beta', port: null })
        expect(resolved.config.port).toBeUndefined()
    })

    it('merges an ssh patch into the stored ssh object; null removes a field', () => {
        const ssh = { host: 'bastion', user: 'u', password: 'pw' }
        const { registry } = setup('missing', [conn('t', { ssh })])
        const { resolved } = registry.update('t', { ssh: { hostKey: 'SHA256:x', password: null } })
        expect(resolved.config.ssh).toEqual({ host: 'bastion', user: 'u', hostKey: 'SHA256:x' })
    })

    it('sets ssh wholesale when none is stored, and drops it with ssh: null', () => {
        const { registry } = setup('missing', [conn('t')])
        const ssh = { host: 'bastion', user: 'u' }
        expect(registry.update('t', { ssh }).resolved.config.ssh).toEqual(ssh)
        expect(registry.update('t', { ssh: null }).resolved.config.ssh).toBeUndefined()
    })

    it('drops nulls from an ssh patch when none is stored', () => {
        const { registry } = setup('missing', [conn('t')])
        const { resolved } = registry.update('t', {
            ssh: { host: 'bastion', user: 'u', password: null }
        })
        expect(resolved.config.ssh).toEqual({ host: 'bastion', user: 'u' })
    })

    it('validates the patched config', () => {
        const { registry, global } = setup('missing', [conn('u')])
        expect(() => registry.update('u', { host: '' })).toThrow()
        expect(global.writes).toBe(0)
    })

    it('renames unless the new name is taken in either layer', () => {
        const { registry } = setup([conn('taken-p')], [conn('old'), conn('taken-g')])
        registry.update('old', { name: 'new' })
        expect(registry.resolve('new').source).toBe('global')
        expect(() => registry.resolve('old')).toThrow(ConnectionNotFoundError)
        expect(() => registry.update('new', { name: 'taken-p' })).toThrow(
            "cannot rename to 'taken-p': name already taken"
        )
        expect(() => registry.update('new', { name: 'taken-g' })).toThrow('already taken')
    })

    it('renaming a project entry that shadowed a global one notes the reveal', () => {
        const { registry } = setup([conn('a')], [conn('a')])
        expect(registry.update('a', { name: 'b' }).notes).toEqual([
            "global connection 'a' in /global.json is now active"
        ])
    })

    it('renaming a project entry over an invalid global one notes nothing', () => {
        const { registry } = setup([conn('bad')], [BAD])
        expect(registry.update('bad', { name: 'b' }).notes).toEqual([])
    })

    it('refuses to update an invalid entry, naming the problem', () => {
        const { registry } = setup([BAD])
        expect(() => registry.update('bad', { host: 'x' })).toThrow('is invalid')
    })

    it('throws not-found for an unknown name', () => {
        const { registry } = setup()
        expect(() => registry.update('ghost', {})).toThrow(ConnectionNotFoundError)
    })
})

describe('createRegistry: remove', () => {
    it('removes from the winning layer and notes the revealed global entry', () => {
        const { registry, project, global } = setup([conn('a'), conn('keep')], [conn('a')])
        expect(registry.remove('a').notes).toEqual([
            "global connection 'a' in /global.json is now active"
        ])
        expect(project.state).toEqual([conn('keep')])
        expect(global.writes).toBe(0)
        expect(registry.resolve('a').source).toBe('global')
    })

    it('removing a project entry over an invalid global one notes nothing', () => {
        const { registry } = setup([conn('bad')], [BAD])
        expect(registry.remove('bad').notes).toEqual([])
    })

    it('removes a global entry without notes', () => {
        const { registry, global } = setup('missing', [conn('g'), BAD])
        expect(registry.remove('g').notes).toEqual([])
        expect(global.state).toEqual([BAD])
    })

    it('removes invalid and duplicated entries so they can be cleaned up', () => {
        const { registry, project, global } = setup([BAD], [conn('dup'), conn('dup')])
        registry.remove('bad')
        registry.remove('dup')
        expect(project.state).toEqual([])
        expect(global.state).toEqual([])
    })

    it('throws not-found for an unknown name', () => {
        const { registry } = setup()
        expect(() => registry.remove('ghost')).toThrow(ConnectionNotFoundError)
    })

    it('a broken project file blocks removal of global names', () => {
        const { registry, global } = setup({ broken: 'bad json' }, [conn('g')])
        expect(() => registry.remove('g')).toThrow('connection file /project.json is broken')
        expect(global.writes).toBe(0)
    })
})

describe('createRegistry: paths', () => {
    it('reports both layer paths', () => {
        const { registry } = setup()
        expect(registry.paths()).toEqual({ project: '/project.json', global: '/global.json' })
    })
})

describe('createFileRegistry', () => {
    let dir: string
    let storePath: string

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'core-registry-')))
        storePath = join(dir, 'home', 'connections.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    const projectFile = (): string => join(dir, '.dbmole.json')

    const writeProject = (connections: unknown[]): void => {
        writeFileSync(projectFile(), JSON.stringify({ connections }))
    }

    const open = (cwd = dir) =>
        createFileRegistry({ schema, projectFileName: '.dbmole.json', storePath, cwd })

    it('picks up project file edits between calls (hot reload)', () => {
        writeProject([conn('a', { host: 'one' })])
        const registry = open()
        const first = registry.resolve('a')
        expect(first.config.host).toBe('one')

        writeProject([conn('a', { host: 'two' }), conn('b')])
        const second = registry.resolve('a')
        expect(second.config.host).toBe('two')
        expect(second.hash).not.toBe(first.hash)
        expect(registry.resolve('b').source).toBe('project')
    })

    it('keeps secrets from malformed JSON out of list() and errors', () => {
        writeFileSync(projectFile(), '{"connections":[{"password":hunter2}]}')
        const registry = open()
        expect(JSON.stringify(registry.list())).not.toContain('hunter2')
        let message = ''
        try {
            registry.resolve('a')
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        expect(message).toContain('invalid JSON: syntax error')
        expect(message).not.toContain('hunter2')
    })

    it('finds the project file from a subdirectory', () => {
        writeProject([conn('a')])
        const sub = join(dir, 'src', 'deep')
        mkdirSync(sub, { recursive: true })
        expect(open(sub).resolve('a').source).toBe('project')
    })

    it('writes project entries as { connections } and global ones as an array', () => {
        const registry = open()
        expect(registry.paths()).toEqual({ project: projectFile(), global: storePath })
        registry.add(conn('p'), 'project')
        registry.add(conn('g'), 'global')
        expect(JSON.parse(readFileSync(projectFile(), 'utf8'))).toEqual({
            connections: [conn('p')]
        })
        expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual([conn('g')])
        expect(registry.resolve('p').source).toBe('project')
        expect(registry.resolve('g').source).toBe('global')
    })
})

describe('configHash', () => {
    it('is stable across key order', () => {
        const a: NamedConfig & Record<string, unknown> = { name: 'h', port: 1, host: 'x' }
        const b: NamedConfig & Record<string, unknown> = { host: 'x', name: 'h', port: 1 }
        expect(configHash(a)).toBe(configHash(b))
    })

    it('changes when a nested value changes', () => {
        expect(configHash({ name: 'h', tags: ['a', 'b'] })).not.toBe(
            configHash({ name: 'h', tags: ['a', 'c'] })
        )
    })
})
