// Build MCPB bundles (Claude Desktop extensions), one per server package:
//   node scripts/mcpb.mjs <packageDir...>
// Each bundle = npm tarball contents + production node_modules + <packageDir>/manifest.json
// + assets/<server>-logo.png as icon.png. Output: <packageDir>/<name>-<version>.mcpb
// Run from the repository root after `npm run build`.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const run = (cmd, args, cwd) =>
    execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })

const bundle = (pkgDir) => {
    const dir = resolve(pkgDir)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const server = Object.keys(pkg.bin)[0].replace(/-mcp$/, '')
    const tmp = mkdtempSync(join(tmpdir(), 'mole-mcpb-'))
    try {
        const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', tmp], dir))
        run('tar', ['xzf', join(tmp, packed[0].filename), '-C', tmp])
        const stage = join(tmp, 'package')
        copyFileSync(join(dir, 'manifest.json'), join(stage, 'manifest.json'))
        copyFileSync(resolve('assets', server + '-logo.png'), join(stage, 'icon.png'))
        // devDependencies (the bundled @dbmole/core, tooling) are not needed at runtime;
        // --ignore-scripts keeps native addons out, ssh2 falls back to pure JS on every OS.
        run('npm', ['pkg', 'delete', 'devDependencies', 'scripts'], stage)
        run(
            'npm',
            [
                'install',
                '--omit=dev',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--no-package-lock'
            ],
            stage
        )
        const out = join(dir, pkg.name + '-' + pkg.version + '.mcpb')
        execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2', 'pack', stage, out], {
            stdio: 'inherit'
        })
    } finally {
        rmSync(tmp, { recursive: true, force: true })
    }
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
    console.error('usage: mcpb.mjs <packageDir...>')
    process.exit(1)
}
for (const dir of dirs) {
    bundle(dir)
}
