import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    target: 'node22',
    clean: true,
    // Inside the workspace, resolve @dbmole/core to its TypeScript source.
    esbuildOptions: (options) => {
        options.conditions = ['@dbmole/source']
    },
    // Bundle core so users install nothing extra.
    noExternal: [/@dbmole\/core/],
    // ssh2 (pulled in by core) ships an optional native addon with a pure-JS fallback;
    // keep it external so esbuild never tries to inline the .node binary.
    external: ['ssh2'],
    banner: { js: '#!/usr/bin/env node' }
})
