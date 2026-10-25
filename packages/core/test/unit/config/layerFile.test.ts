import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { readLayerFile, writeLayerFile } from '../../../src/config/layerFile.js'

// When set, the next writeFileSync writes half its data then fails (ENOSPC).
const failNextWrite = vi.hoisted(() => ({ on: false }))

vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>()
    const writeFileSync: typeof fs.writeFileSync = (file, data, options) => {
        if (failNextWrite.on && typeof data === 'string') {
            failNextWrite.on = false
            fs.writeFileSync(file, data.slice(0, data.length / 2), options)
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
        fs.writeFileSync(file, data, options)
    }
    return { ...fs, writeFileSync }
})

const schema = z
    .object({
        name: z.string(),
        port: z.number().int(),
        readonly: z.boolean().default(false)
    })
    .strict()

describe('readLayerFile', () => {
    let dir: string
    let path: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'core-layer-'))
        path = join(dir, 'layer.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('reports a missing file as missing, not broken', () => {
        expect(readLayerFile(path, 'array', schema)).toEqual({ status: 'missing' })
    })

    it('reports an unreadable path as broken', () => {
        mkdirSync(path)
        const read = readLayerFile(path, 'array', schema)
        expect(read.status).toBe('broken')
        expect(read.status === 'broken' && read.error).toMatch(/^cannot read file: /)
    })

    it('reports invalid JSON as broken', () => {
        writeFileSync(path, '{ nope')
        const read = readLayerFile(path, 'object', schema)
        expect(read.status).toBe('broken')
        expect(read.status === 'broken' && read.error).toMatch(/^invalid JSON: /)
    })

    it('never echoes file content in a JSON syntax error', () => {
        const cases: [string, string][] = [
            ['{"password":hunter2}', 'invalid JSON: syntax error'],
            ['{\n  "password": "hunter2"\n  x', 'invalid JSON: syntax error at line 3 column 3'],
            ['{"password":"hunter2', 'invalid JSON: syntax error at line 1 column 21'],
            ['{"password":', 'invalid JSON: unexpected end of input'],
            // V8 quotes short sources whole: a decoy position must not be echoed
            ['x(line 1 column 42)', 'invalid JSON: syntax error']
        ]
        for (const [content, error] of cases) {
            writeFileSync(path, content)
            expect(readLayerFile(path, 'object', schema)).toEqual({ status: 'broken', error })
        }
    })

    it('reports a wrong top-level shape as broken', () => {
        writeFileSync(path, JSON.stringify({ connections: [] }))
        expect(readLayerFile(path, 'array', schema)).toEqual({
            status: 'broken',
            error: 'expected a JSON array'
        })
        for (const content of ['[]', 'null', '"text"', '{"connections": 5}', '{}']) {
            writeFileSync(path, content)
            expect(readLayerFile(path, 'object', schema)).toEqual({
                status: 'broken',
                error: 'expected an object { "connections": [...] }'
            })
        }
    })

    it('parses valid entries of an array layer, applying schema defaults', () => {
        writeFileSync(path, JSON.stringify([{ name: 'a', port: 1 }]))
        expect(readLayerFile(path, 'array', schema)).toEqual({
            status: 'ok',
            entries: [
                {
                    ok: true,
                    raw: { name: 'a', port: 1 },
                    config: { name: 'a', port: 1, readonly: false }
                }
            ]
        })
    })

    it('parses the connections of an object layer', () => {
        writeFileSync(path, JSON.stringify({ connections: [{ name: 'p', port: 2 }] }))
        const read = readLayerFile(path, 'object', schema)
        expect(read.status === 'ok' && read.entries.map((e) => e.ok)).toEqual([true])
    })

    it('ignores a leading UTF-8 BOM', () => {
        writeFileSync(path, '\uFEFF' + JSON.stringify({ connections: [{ name: 'p', port: 2 }] }))
        const read = readLayerFile(path, 'object', schema)
        expect(read.status === 'ok' && read.entries.map((e) => e.ok)).toEqual([true])
    })

    it('keeps invalid entries in order with their raw value, name and zod error', () => {
        const raws = [{ name: 'good', port: 1 }, { name: 'bad', port: 'x' }, { port: 3 }, 'junk']
        writeFileSync(path, JSON.stringify(raws))
        const read = readLayerFile(path, 'array', schema)
        if (read.status !== 'ok') {
            throw new Error('expected ok, got ' + read.status)
        }
        expect(read.entries.map((e) => e.raw)).toEqual(raws)
        const [good, bad, unnamed, junk] = read.entries
        expect(good.ok).toBe(true)
        expect(bad).toMatchObject({ ok: false, name: 'bad' })
        expect(!bad.ok && bad.error).toBe('port: Expected number, received string')
        expect(unnamed).toMatchObject({ ok: false, name: undefined })
        expect(!unnamed.ok && unnamed.error).toContain('name: Required')
        expect(junk).toMatchObject({ ok: false, name: undefined })
        expect(!junk.ok && junk.error).toBe('Expected object, received string')
    })
})

describe('writeLayerFile', () => {
    let dir: string
    let path: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'core-layer-'))
        path = join(dir, 'nested', 'deeper', 'layer.json')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    const leftovers = (): string[] =>
        readdirSync(join(dir, 'nested', 'deeper')).filter((f) => f.endsWith('.tmp'))

    it('writes an array layer, creating parent dirs with 0700', () => {
        writeLayerFile(path, 'array', [{ name: 'a', port: 1 }])
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ name: 'a', port: 1 }])
        expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
        expect(statSync(join(dir, 'nested', 'deeper')).mode & 0o777).toBe(0o700)
    })

    it('writes an object layer as { connections }', () => {
        writeLayerFile(path, 'object', [{ name: 'p', port: 2 }])
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
            connections: [{ name: 'p', port: 2 }]
        })
    })

    it('writes pretty JSON with mode 0600 and leaves no tmp files', () => {
        writeLayerFile(path, 'array', [{ name: 'a', port: 1 }])
        expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(readFileSync(path, 'utf8')).toContain('\n        "name": "a"')
        expect(leftovers()).toEqual([])
    })

    it('replaces an existing world-readable file atomically with a 0600 one', () => {
        mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
        writeFileSync(path, '[]', { mode: 0o644 })
        writeLayerFile(path, 'array', [{ name: 'b', port: 2 }])
        expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ name: 'b', port: 2 }])
    })

    it('round-trips invalid raw entries verbatim', () => {
        const raws = [{ name: 'bad', port: 'x', extra: true }, 42]
        writeLayerFile(path, 'object', raws)
        const read = readLayerFile(path, 'object', schema)
        expect(read.status === 'ok' && read.entries.map((e) => e.raw)).toEqual(raws)
    })

    it('removes the tmp file and rethrows when the rename fails', () => {
        mkdirSync(path, { recursive: true })
        expect(() => writeLayerFile(path, 'array', [])).toThrow()
        expect(leftovers()).toEqual([])
    })

    it('removes a partial tmp file and rethrows when the tmp write fails', () => {
        failNextWrite.on = true
        expect(() => writeLayerFile(path, 'array', [{ name: 'a', port: 1 }])).toThrow('ENOSPC')
        expect(leftovers()).toEqual([])
    })
})
