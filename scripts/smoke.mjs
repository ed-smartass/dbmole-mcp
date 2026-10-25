// Boot smoke test: the server must start over stdio and list exactly the expected tools.
//   node scripts/smoke.mjs pack <packageDir...>    npm pack → install into an empty temp dir → boot
//   node scripts/smoke.mjs docker <packageDir...>  docker build <packageDir>/Dockerfile → boot
//   node scripts/smoke.mjs run <dbmole|esmole> -- <command...>   boot any command (npx, node, ...)
// Library packages (no `bin`, i.e. @dbmole/core) are installed and imported instead of booted.
// Run from the repository root. Exits 1 on the first failure.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const CONNECTION_TOOLS = [
    'add_connection',
    'list_connections',
    'remove_connection',
    'test_connection',
    'update_connection'
]
const EXPECTED = {
    dbmole: [...CONNECTION_TOOLS, 'describe_table', 'execute_sql', 'list_databases', 'list_tables'],
    esmole: [
        ...CONNECTION_TOOLS,
        'es_cluster_health',
        'es_get_mapping',
        'es_list_indices',
        'es_request',
        'es_search'
    ]
}
const BOOT_TIMEOUT_MS = 120_000

const fail = (message) => {
    throw new Error(message)
}

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' })

const readPkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

// dbmole-mcp → dbmole
const serverOf = (pkg) => Object.keys(pkg.bin)[0].replace(/-mcp$/, '')

const listTools = async (server, command, args, opts = {}) => {
    const expected = EXPECTED[server] ?? fail('unknown server ' + server)
    const transport = new StdioClientTransport({
        command,
        args,
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stderr: 'inherit'
    })
    const client = new Client({ name: 'smoke', version: '0.0.0' })
    const timer = setTimeout(() => {
        console.error('smoke: FAIL: ' + server + ' gave no tools/list within 120 s')
        process.exit(1)
    }, BOOT_TIMEOUT_MS)
    try {
        await client.connect(transport)
        const info = client.getServerVersion()
        const { tools } = await client.listTools()
        const names = tools.map((t) => t.name).sort()
        const want = [...expected].sort()
        if (names.join() !== want.join()) {
            fail('tools mismatch\n  got:  ' + names.join(', ') + '\n  want: ' + want.join(', '))
        }
        if (opts.version && info?.version !== opts.version) {
            fail('serverInfo.version ' + info?.version + ' !== package version ' + opts.version)
        }
        // Token cost of the tool definitions: approximate, ~4 characters per token.
        const chars = JSON.stringify(tools).length
        console.error(
            'smoke: OK ' + info?.name + '@' + info?.version + ', ' + names.length + ' tools'
        )
        console.error(
            'smoke: tools/list ' + chars + ' chars, ~' + Math.round(chars / 4) + ' tokens'
        )
    } finally {
        clearTimeout(timer)
        await client.close()
    }
}

// server.json (MCP Registry), manifest.json (MCPB) and the Claude Code plugin.json must carry
// the package version; the plugin's `<name>@<pin>` npx pin must match it (0.2 matches 0.2.x).
const checkMetadataVersions = (dir, pkg) => {
    const plugin = join('plugins', pkg.name.replace(/-mcp$/, ''), '.claude-plugin', 'plugin.json')
    const paths = [
        join(dir, 'server.json'),
        join(dir, 'manifest.json'),
        join(dir, plugin),
        resolve(plugin)
    ]
    for (const path of paths) {
        if (!existsSync(path)) {
            continue
        }
        const meta = JSON.parse(readFileSync(path, 'utf8'))
        const versions = [meta.version, ...(meta.packages ?? []).map((p) => p.version)]
        if (versions.some((v) => v !== pkg.version)) {
            fail(path + ' versions ' + versions.join(', ') + ' !== package ' + pkg.version)
        }
        const args = Object.values(meta.mcpServers ?? {}).flatMap((server) => server.args ?? [])
        for (const arg of args) {
            if (!arg.startsWith(pkg.name + '@')) {
                continue
            }
            const pin = arg.slice(pkg.name.length + 1)
            if (pin !== pkg.version && !pkg.version.startsWith(pin + '.')) {
                fail(path + ' pins ' + arg + ', package is ' + pkg.version)
            }
        }
    }
}

const packAndBoot = async (pkgDir) => {
    const dir = resolve(pkgDir)
    const pkg = readPkg(dir)
    checkMetadataVersions(dir, pkg)
    const tmp = mkdtempSync(join(tmpdir(), 'mole-smoke-'))
    try {
        const packed = JSON.parse(sh('npm', ['pack', '--json', '--pack-destination', tmp], dir))[0]
        const files = packed.files.map((f) => f.path)
        if (!files.includes('LICENSE')) {
            fail(pkg.name + ': tarball has no LICENSE')
        }
        sh('npm', ['init', '-y'], tmp)
        sh('npm', ['install', '--no-audit', '--no-fund', join(tmp, packed.filename)], tmp)
        if (!pkg.bin) {
            const probe =
                'import("' + pkg.name + '").then((m) => console.log(Object.keys(m).length))'
            const count = Number(sh('node', ['-e', probe], tmp))
            if (!(count > 0) || !files.includes('dist/index.d.ts')) {
                fail(pkg.name + ': installed copy exports nothing or ships no dist/index.d.ts')
            }
            console.error('smoke: OK ' + pkg.name + '@' + pkg.version + ', ' + count + ' exports')
            return
        }
        const bin = join(tmp, 'node_modules', '.bin', Object.keys(pkg.bin)[0])
        const store = join(tmp, 'store.json')
        await listTools(serverOf(pkg), bin, [], {
            cwd: tmp,
            env: { DBMOLE_STORE: store, ESMOLE_STORE: store },
            version: pkg.version
        })
    } finally {
        rmSync(tmp, { recursive: true, force: true })
    }
}

const dockerBoot = async (pkgDir) => {
    const pkg = readPkg(resolve(pkgDir))
    const tag = Object.keys(pkg.bin)[0] + ':smoke'
    execFileSync('docker', ['build', '-q', '-f', join(pkgDir, 'Dockerfile'), '-t', tag, '.'], {
        stdio: 'inherit'
    })
    await listTools(serverOf(pkg), 'docker', ['run', '-i', '--rm', tag], { version: pkg.version })
}

const main = async () => {
    const [mode, ...rest] = process.argv.slice(2)
    if (mode === 'pack' && rest.length > 0) {
        for (const dir of rest) {
            await packAndBoot(dir)
        }
    } else if (mode === 'docker' && rest.length > 0) {
        for (const dir of rest) {
            await dockerBoot(dir)
        }
    } else if (mode === 'run' && rest[1] === '--' && rest.length > 2) {
        await listTools(rest[0], rest[2], rest.slice(3))
    } else {
        fail('usage: smoke.mjs pack <dir...> | docker <dir...> | run <dbmole|esmole> -- <cmd...>')
    }
}

main().catch((error) => {
    console.error('smoke: FAIL: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
})
