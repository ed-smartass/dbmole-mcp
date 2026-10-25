import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type ProjectLocation = { path: string; exists: boolean }

const ancestors = (start: string): string[] => {
    const dirs: string[] = []
    let dir = resolve(start)
    for (;;) {
        dirs.push(dir)
        const parent = dirname(dir)
        if (parent === dir) {
            return dirs
        }
        dir = parent
    }
}

// A linked worktree's `.git` is a file `gitdir: <common>/worktrees/<name>`
// (absolute or relative to the worktree); that dir holds `commondir`
// (relative to it, normally `../..`). The main checkout root is <common>/..
// only when <common> is `<main>/.git`; a bare repo or --separate-git-dir main
// has no checkout there. Submodules have a `.git` file but no commondir.
const mainCheckoutRoot = (dotGit: string): string | undefined => {
    try {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
        if (!match) {
            return undefined
        }
        const gitDir = resolve(dirname(dotGit), match[1].trim())
        const commonFile = join(gitDir, 'commondir')
        if (!existsSync(commonFile)) {
            return undefined
        }
        const common = resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
        return basename(common) === '.git' ? dirname(common) : undefined
    } catch {
        return undefined
    }
}

// Any entry counts, even a dangling symlink, a loop or one we cannot stat:
// readLayerFile then reports it as broken, instead of discovery walking past
// it to an ancestor's file and routing the same names there.
const isPresent = (path: string): boolean => {
    try {
        lstatSync(path)
        return true
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        return code !== 'ENOENT' && code !== 'ENOTDIR'
    }
}

export const locateProjectFile = (
    fileName: string,
    cwd: string = process.cwd()
): ProjectLocation => {
    let gitRoot: string | undefined
    let mainRoot: string | undefined
    for (const dir of ancestors(cwd)) {
        const candidate = join(dir, fileName)
        if (isPresent(candidate)) {
            return { path: candidate, exists: true }
        }
        const dotGit = join(dir, '.git')
        if (gitRoot === undefined && existsSync(dotGit)) {
            gitRoot = dir
            mainRoot = statSync(dotGit).isFile() ? mainCheckoutRoot(dotGit) : undefined
        }
    }
    if (mainRoot !== undefined && isPresent(join(mainRoot, fileName))) {
        return { path: join(mainRoot, fileName), exists: true }
    }
    return { path: join(mainRoot ?? gitRoot ?? resolve(cwd), fileName), exists: false }
}

// `git check-ignore -q`: 0 = ignored, 1 = not ignored, else (128 outside a
// repo, git missing, bad cwd) = unknown.
export const isGitIgnored = (path: string): boolean | undefined => {
    const result = spawnSync('git', ['check-ignore', '-q', basename(path)], {
        cwd: dirname(path),
        stdio: 'ignore'
    })
    if (result.status === 0) {
        return true
    }
    if (result.status === 1) {
        return false
    }
    return undefined
}
