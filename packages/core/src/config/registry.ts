import { createHash } from 'node:crypto'
import type * as z from 'zod'
import type { LayerName, ResolvedConnection } from './baseSchema.js'
import { type LayerEntry, type LayerRead, readLayerFile, writeLayerFile } from './layerFile.js'
import { locateProjectFile } from './projectFile.js'

export class ConnectionNotFoundError extends Error {
    constructor(name: string, available: string[]) {
        const list = available.length > 0 ? available.join(', ') : '<none>'
        super("connection '" + name + "' not found. Available connections: " + list)
        this.name = 'ConnectionNotFoundError'
    }
}

export class RegistryError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RegistryError'
    }
}

const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(sortValue)
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, inner]) => [key, sortValue(inner)])
        )
    }
    return value
}

export const configHash = (config: unknown): string =>
    createHash('sha256')
        .update(JSON.stringify(sortValue(config)))
        .digest('hex')

export type NamedConfig = { name: string }

export type LayerIO<TConfig> = {
    name: LayerName
    path: () => string
    read: () => LayerRead<TConfig>
    write: (raws: unknown[]) => void
}

export type ListedConnection<TConfig> =
    | { ok: true; resolved: ResolvedConnection<TConfig>; shadows?: LayerName }
    | { ok: false; name: string; source: LayerName; error: string }

export type ListResult<TConfig> = {
    connections: ListedConnection<TConfig>[]
    brokenLayers: { layer: LayerName; path: string; error: string }[]
}

export type Mutation<TConfig> = { resolved: ResolvedConnection<TConfig>; notes: string[] }

export type RegistryDeps<TConfig> = {
    // Only the parse OUTPUT must be TConfig; the input stays unconstrained so
    // schemas with defaults (readonly: z.boolean().default(false)) still fit.
    schema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
    project: LayerIO<TConfig>
    global: LayerIO<TConfig>
}

export type Registry<TConfig extends NamedConfig> = {
    list: () => ListResult<TConfig>
    resolve: (name: string) => ResolvedConnection<TConfig>
    add: (config: TConfig, scope: LayerName) => Mutation<TConfig>
    update: (name: string, patch: Record<string, unknown>) => Mutation<TConfig>
    remove: (name: string) => { notes: string[] }
    paths: () => { project: string; global: string }
}

// One layer as seen by a single registry call: path and contents read once.
type Layer<TConfig> = { io: LayerIO<TConfig>; path: string; read: LayerRead<TConfig> }

// What one layer says about one name.
type Lookup<TConfig> =
    | { kind: 'none' }
    | { kind: 'ok'; config: TConfig; index: number }
    | { kind: 'error'; error: string }

const brokenMessage = (path: string, error: string): string =>
    'connection file ' + path + ' is broken: ' + error + '; fix or delete it'

const entryName = <TConfig extends NamedConfig>(entry: LayerEntry<TConfig>): string | undefined =>
    entry.ok ? entry.config.name : entry.name

const entriesOf = <TConfig>(layer: Layer<TConfig>): LayerEntry<TConfig>[] =>
    layer.read.status === 'ok' ? layer.read.entries : []

const layerHas = <TConfig extends NamedConfig>(layer: Layer<TConfig>, name: string): boolean =>
    entriesOf(layer).some((entry) => entryName(entry) === name)

const byLocale = (a: string, b: string): number => a.localeCompare(b)

const namesOf = <TConfig extends NamedConfig>(layers: Layer<TConfig>[]): string[] => {
    const names = new Set<string>()
    for (const layer of layers) {
        for (const entry of entriesOf(layer)) {
            const name = entryName(entry)
            if (name !== undefined) {
                names.add(name)
            }
        }
    }
    return [...names].sort(byLocale)
}

const lookup = <TConfig extends NamedConfig>(
    layer: Layer<TConfig>,
    name: string
): Lookup<TConfig> => {
    const entries = entriesOf(layer)
    const indexes = entries.flatMap((entry, index) => (entryName(entry) === name ? [index] : []))
    if (indexes.length === 0) {
        return { kind: 'none' }
    }
    if (indexes.length > 1) {
        return {
            kind: 'error',
            error: "connection '" + name + "' is defined twice in " + layer.path
        }
    }
    const entry = entries[indexes[0]]
    if (!entry.ok) {
        return {
            kind: 'error',
            error: "connection '" + name + "' in " + layer.path + ' is invalid: ' + entry.error
        }
    }
    return { kind: 'ok', config: entry.config, index: indexes[0] }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

// null deletes a field, undefined leaves it. An `ssh` object is merged into the
// stored one (or an empty one) field by field with the same rules.
const applyPatch = (
    base: Record<string, unknown>,
    patch: Record<string, unknown>
): Record<string, unknown> => {
    const next = { ...base }
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete next[key]
        } else if (key === 'ssh' && isRecord(value)) {
            next.ssh = applyPatch(isRecord(next.ssh) ? next.ssh : {}, value)
        } else if (value !== undefined) {
            next[key] = value
        }
    }
    return next
}

const resolvedFrom = <TConfig>(
    config: TConfig,
    source: LayerName
): ResolvedConnection<TConfig> => ({
    config,
    source,
    hash: configHash(config)
})

export const createRegistry = <TConfig extends NamedConfig>(
    deps: RegistryDeps<TConfig>
): Registry<TConfig> => {
    const load = (io: LayerIO<TConfig>): Layer<TConfig> => ({
        io,
        path: io.path(),
        read: io.read()
    })

    // Highest priority first. Both files are re-read on every call (hot reload).
    const snapshot = (): [Layer<TConfig>, Layer<TConfig>] => [load(deps.project), load(deps.global)]

    // The layer that holds `name`: the first one defining it. A broken layer
    // above it is an error, never a silent fall-through to a lower layer.
    const locate = (
        layers: Layer<TConfig>[],
        name: string
    ): { layer: Layer<TConfig>; found: Exclude<Lookup<TConfig>, { kind: 'none' }> } => {
        for (const layer of layers) {
            if (layer.read.status === 'broken') {
                throw new RegistryError(brokenMessage(layer.path, layer.read.error))
            }
            const found = lookup(layer, name)
            if (found.kind !== 'none') {
                return { layer, found }
            }
        }
        throw new ConnectionNotFoundError(name, namesOf(layers))
    }

    // Like locate, but an invalid or duplicated entry is an error too.
    const owner = (
        layers: Layer<TConfig>[],
        name: string
    ): { layer: Layer<TConfig>; config: TConfig; index: number } => {
        const { layer, found } = locate(layers, name)
        if (found.kind === 'error') {
            throw new RegistryError(found.error)
        }
        return { layer, config: found.config, index: found.index }
    }

    // Writes keep every other entry verbatim (invalid ones included) and refuse
    // to overwrite a file that is not valid JSON or has the wrong shape.
    const writableRaws = (layer: Layer<TConfig>): unknown[] => {
        if (layer.read.status === 'broken') {
            throw new RegistryError(brokenMessage(layer.path, layer.read.error))
        }
        return entriesOf(layer).map((entry) => entry.raw)
    }

    // A name that leaves the project layer while the global layer defines it validly.
    const revealNotes = (
        layers: Layer<TConfig>[],
        from: Layer<TConfig>,
        name: string
    ): string[] => {
        const [project, global] = layers
        if (from !== project || lookup(global, name).kind !== 'ok') {
            return []
        }
        return ["global connection '" + name + "' in " + global.path + ' is now active']
    }

    const list = (): ListResult<TConfig> => {
        const byName = new Map<string, ListedConnection<TConfig>>()
        const brokenLayers: ListResult<TConfig>['brokenLayers'] = []
        // Once a broken layer is seen, names only lower layers define resolve
        // to its error, so they must not be listed as usable.
        let blockedBy: string | undefined
        for (const layer of snapshot()) {
            const source = layer.io.name
            if (layer.read.status === 'broken') {
                brokenLayers.push({ layer: source, path: layer.path, error: layer.read.error })
                blockedBy = blockedBy ?? brokenMessage(layer.path, layer.read.error)
                continue
            }
            for (const name of namesOf([layer])) {
                const winner = byName.get(name)
                if (winner) {
                    if (winner.ok) {
                        winner.shadows = source
                    }
                    continue
                }
                const found = lookup(layer, name)
                if (blockedBy !== undefined) {
                    byName.set(name, { ok: false, name, source, error: blockedBy })
                } else if (found.kind === 'ok') {
                    byName.set(name, { ok: true, resolved: resolvedFrom(found.config, source) })
                } else if (found.kind === 'error') {
                    byName.set(name, { ok: false, name, source, error: found.error })
                }
            }
        }
        const connections = [...byName.keys()].sort(byLocale).flatMap((name) => {
            const item = byName.get(name)
            return item ? [item] : []
        })
        return { connections, brokenLayers }
    }

    const resolve = (name: string): ResolvedConnection<TConfig> => {
        const { layer, config } = owner(snapshot(), name)
        return resolvedFrom(config, layer.io.name)
    }

    const add = (config: TConfig, scope: LayerName): Mutation<TConfig> => {
        const layers = snapshot()
        const [project, global] = layers
        const target = scope === 'project' ? project : global
        const raws = writableRaws(target)
        if (layerHas(target, config.name)) {
            throw new RegistryError(
                "connection '" +
                    config.name +
                    "' already exists in " +
                    scope +
                    ' (' +
                    target.path +
                    ')'
            )
        }
        target.io.write([...raws, config])
        const notes: string[] = []
        if (scope === 'project' && layerHas(global, config.name)) {
            notes.push(
                "project connection '" + config.name + "' shadows the global one in " + global.path
            )
        }
        if (scope === 'global' && lookup(project, config.name).kind === 'ok') {
            notes.push(
                "global connection '" +
                    config.name +
                    "' is shadowed by the project one in " +
                    project.path +
                    '; the project entry stays active'
            )
        }
        if (scope === 'global' && project.read.status === 'broken') {
            notes.push(
                'project file ' +
                    project.path +
                    ' is broken: ' +
                    project.read.error +
                    '; connections resolve only after it is fixed'
            )
        }
        return { resolved: resolvedFrom(config, scope), notes }
    }

    const update = (name: string, patch: Record<string, unknown>): Mutation<TConfig> => {
        const layers = snapshot()
        const { layer, config, index } = owner(layers, name)
        const base: Record<string, unknown> = { ...config }
        const switchesEngine =
            patch.type !== undefined && patch.type !== base.type && !('port' in patch)
        if (switchesEngine) {
            delete base.port
        }
        const next = deps.schema.parse(applyPatch(base, patch))
        const renamed = next.name !== name
        if (renamed && layers.some((l) => layerHas(l, next.name))) {
            throw new RegistryError("cannot rename to '" + next.name + "': name already taken")
        }
        const raws = writableRaws(layer)
        raws[index] = next
        layer.io.write(raws)
        return {
            resolved: resolvedFrom(next, layer.io.name),
            notes: renamed ? revealNotes(layers, layer, name) : []
        }
    }

    // Works on invalid and duplicated entries too, so they can be cleaned up
    // through the tools.
    const remove = (name: string): { notes: string[] } => {
        const layers = snapshot()
        const { layer } = locate(layers, name)
        const kept = entriesOf(layer).filter((entry) => entryName(entry) !== name)
        layer.io.write(kept.map((entry) => entry.raw))
        return { notes: revealNotes(layers, layer, name) }
    }

    const paths = (): { project: string; global: string } => ({
        project: deps.project.path(),
        global: deps.global.path()
    })

    return { list, resolve, add, update, remove, paths }
}

export const createFileRegistry = <TConfig extends NamedConfig>(opts: {
    schema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
    projectFileName: string
    storePath: string
    cwd?: string
}): Registry<TConfig> => {
    // Re-located on every call: a project file created mid-session is picked up.
    const projectPath = (): string => locateProjectFile(opts.projectFileName, opts.cwd).path
    const storePath = (): string => opts.storePath
    return createRegistry<TConfig>({
        schema: opts.schema,
        project: {
            name: 'project',
            path: projectPath,
            read: () => readLayerFile(projectPath(), 'object', opts.schema),
            write: (raws) => writeLayerFile(projectPath(), 'object', raws)
        },
        global: {
            name: 'global',
            path: storePath,
            read: () => readLayerFile(storePath(), 'array', opts.schema),
            write: (raws) => writeLayerFile(storePath(), 'array', raws)
        }
    })
}
