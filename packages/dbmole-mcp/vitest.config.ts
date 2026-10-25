import { defineConfig } from 'vitest/config'

// Resolve @dbmole/core to its TypeScript source (no core build needed). The trailing
// entries are Vite's default server conditions, which a custom list replaces.
const conditions = ['@dbmole/source', 'module', 'node', 'development|production']

export default defineConfig({
    ssr: { resolve: { conditions } },
    test: {
        include: ['test/unit/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**'],
            exclude: ['src/index.ts'],
            thresholds: { lines: 90, functions: 90 }
        }
    }
})
