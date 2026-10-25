import { execFileSync } from 'node:child_process'
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { readLayerFile } from '../../../src/config/layerFile.js'
import { isGitIgnored, locateProjectFile } from '../../../src/config/projectFile.js'

const FILE = '.dbmole.json'

// Same layout `git worktree add ../wt` produces (git 2.53): the worktree's
// `.git` is a file pointing at <main>/.git/worktrees/<name>, which holds a
// `commondir` file containing `../..`.
const fakeWorktree = (main: string, wt: string, gitdirLine?: string): void => {
    const gitDir = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), (gitdirLine ?? 'gitdir: ' + gitDir) + '\n')
}

describe('locateProjectFile', () => {
    let root: string

    beforeEach(() => {
        // realpath: on macOS tmpdir() is a symlink; keep expected paths stable
        root = realpathSync(mkdtempSync(join(tmpdir(), 'core-project-')))
    })

    afterEach(() => {
        rmSync(root, { recursive: true, force: true })
    })

    it('finds the file in cwd', () => {
        writeFileSync(join(root, FILE), '{}')
        expect(locateProjectFile(FILE, root)).toEqual({ path: join(root, FILE), exists: true })
    })

    it('walks up to the first ancestor holding the file', () => {
        const deep = join(root, 'a', 'b', 'c')
        mkdirSync(deep, { recursive: true })
        writeFileSync(join(root, 'a', FILE), '{}')
        writeFileSync(join(root, FILE), '{}')
        expect(locateProjectFile(FILE, deep)).toEqual({
            path: join(root, 'a', FILE),
            exists: true
        })
    })

    // existsSync is false for these; walking past them would route the same
    // names to an ancestor's file instead of reporting the broken one.
    it.each([
        ['a dangling symlink', (link: string) => symlinkSync(join(root, 'nowhere.json'), link)],
        ['a symlink loop', (link: string) => symlinkSync(link, link)]
    ])('stops at %s and reports it as broken', (_, makeLink) => {
        const cwd = join(root, 'cwd')
        mkdirSync(cwd)
        writeFileSync(join(root, FILE), '{"connections":[]}')
        makeLink(join(cwd, FILE))
        expect(locateProjectFile(FILE, cwd)).toEqual({ path: join(cwd, FILE), exists: true })
        const read = readLayerFile(join(cwd, FILE), 'object', z.unknown())
        expect(read.status === 'broken' && read.error).toMatch(/^cannot read file: /)
    })

    // root bypasses directory permissions, so lstat would not fail there
    it.skipIf(process.getuid?.() === 0)('stops at a dir it cannot search', () => {
        const locked = join(root, 'locked')
        mkdirSync(join(locked, 'cwd'), { recursive: true })
        writeFileSync(join(root, FILE), '{}')
        chmodSync(locked, 0o600)
        try {
            expect(locateProjectFile(FILE, join(locked, 'cwd'))).toEqual({
                path: join(locked, 'cwd', FILE),
                exists: true
            })
        } finally {
            chmodSync(locked, 0o700)
        }
    })

    it('finds a dangling symlink in the main checkout of a linked worktree', () => {
        const main = join(root, 'main')
        const wt = join(root, 'wt')
        fakeWorktree(main, wt)
        symlinkSync(join(root, 'nowhere.json'), join(main, FILE))
        expect(locateProjectFile(FILE, wt)).toEqual({ path: join(main, FILE), exists: true })
    })

    it('falls back to the main checkout of a linked worktree', () => {
        const main = join(root, 'main')
        const wt = join(root, 'wt')
        fakeWorktree(main, wt)
        writeFileSync(join(main, FILE), '{}')
        mkdirSync(join(wt, 'src'))
        expect(locateProjectFile(FILE, join(wt, 'src'))).toEqual({
            path: join(main, FILE),
            exists: true
        })
    })

    it('resolves a relative gitdir line against the worktree', () => {
        const main = join(root, 'main')
        const wt = join(root, 'wt')
        fakeWorktree(main, wt, 'gitdir: ../main/.git/worktrees/wt')
        writeFileSync(join(main, FILE), '{}')
        expect(locateProjectFile(FILE, wt)).toEqual({ path: join(main, FILE), exists: true })
    })

    it('prefers a file inside the worktree over the main checkout', () => {
        const main = join(root, 'main')
        const wt = join(root, 'wt')
        fakeWorktree(main, wt)
        writeFileSync(join(main, FILE), '{}')
        writeFileSync(join(wt, FILE), '{}')
        expect(locateProjectFile(FILE, wt)).toEqual({ path: join(wt, FILE), exists: true })
    })

    it('creates in the main checkout root when a worktree has no file anywhere', () => {
        const main = join(root, 'main')
        const wt = join(root, 'wt')
        fakeWorktree(main, wt)
        expect(locateProjectFile(FILE, wt)).toEqual({ path: join(main, FILE), exists: false })
    })

    it('creates in the git root when cwd is a subdir of a plain repo', () => {
        mkdirSync(join(root, '.git'))
        mkdirSync(join(root, 'pkg', 'src'), { recursive: true })
        expect(locateProjectFile(FILE, join(root, 'pkg', 'src'))).toEqual({
            path: join(root, FILE),
            exists: false
        })
    })

    it('treats a .git file without commondir (submodule) as a plain git root', () => {
        const sub = join(root, 'sub')
        mkdirSync(sub)
        writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n')
        expect(locateProjectFile(FILE, sub)).toEqual({ path: join(sub, FILE), exists: false })
    })

    it('has no main checkout when the common dir is not <main>/.git (bare repo)', () => {
        const bare = join(root, 'repo.git')
        const wt = join(root, 'wt')
        const gitDir = join(bare, 'worktrees', 'wt')
        mkdirSync(gitDir, { recursive: true })
        writeFileSync(join(gitDir, 'commondir'), '../..\n')
        mkdirSync(wt)
        writeFileSync(join(wt, '.git'), 'gitdir: ' + gitDir + '\n')
        expect(locateProjectFile(FILE, wt)).toEqual({ path: join(wt, FILE), exists: false })
    })

    it('ignores a malformed .git file', () => {
        writeFileSync(join(root, '.git'), 'garbage\n')
        expect(locateProjectFile(FILE, root)).toEqual({ path: join(root, FILE), exists: false })
    })

    it('creates in cwd outside any git repo', () => {
        const cwd = join(root, 'plain')
        mkdirSync(cwd)
        expect(locateProjectFile(FILE, cwd)).toEqual({ path: join(cwd, FILE), exists: false })
    })

    it('defaults cwd to process.cwd()', () => {
        expect(locateProjectFile('.no-such-file-' + Date.now() + '.json').exists).toBe(false)
    })
})

describe('isGitIgnored', () => {
    let root: string
    const saved = {
        global: process.env.GIT_CONFIG_GLOBAL,
        nosystem: process.env.GIT_CONFIG_NOSYSTEM
    }

    const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }

    // Isolate from the dev's global/system git config (e.g. core.excludesFile).
    beforeAll(() => {
        process.env.GIT_CONFIG_GLOBAL = '/dev/null'
        process.env.GIT_CONFIG_NOSYSTEM = '1'
    })

    afterAll(() => {
        restore('GIT_CONFIG_GLOBAL', saved.global)
        restore('GIT_CONFIG_NOSYSTEM', saved.nosystem)
    })

    beforeEach(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), 'core-ignore-')))
    })

    afterEach(() => {
        rmSync(root, { recursive: true, force: true })
    })

    it('is true when .gitignore covers the file', () => {
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
        writeFileSync(join(root, '.gitignore'), FILE + '\n')
        expect(isGitIgnored(join(root, FILE))).toBe(true)
    })

    it('handles a path relative to process.cwd()', () => {
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
        writeFileSync(join(root, '.gitignore'), FILE + '\n')
        expect(isGitIgnored(relative(process.cwd(), join(root, FILE)))).toBe(true)
    })

    it('is false when the file is not ignored', () => {
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' })
        expect(isGitIgnored(join(root, FILE))).toBe(false)
    })

    it('is undefined outside a git repo', () => {
        expect(isGitIgnored(join(root, FILE))).toBeUndefined()
    })

    it('is undefined when the directory does not exist', () => {
        expect(isGitIgnored(join(root, 'missing', FILE))).toBeUndefined()
    })
})
