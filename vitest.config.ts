import { defineConfig } from 'vitest/config'

// Resolve @dbmole/core to its TypeScript source (no core build needed). The trailing
// entries are Vite's default server conditions, which a custom list replaces.
const conditions = ['@dbmole/source', 'module', 'node', 'development|production']

export default defineConfig({
    ssr: { resolve: { conditions } },
    test: {
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['packages/*/test/unit/**/*.test.ts']
                }
            },
            {
                extends: true,
                test: {
                    name: 'integration',
                    include: ['packages/*/test/integration/**/*.test.ts'],
                    testTimeout: 120_000,
                    hookTimeout: 240_000
                }
            }
        ],
        coverage: {
            provider: 'v8',
            include: ['packages/*/src/**'],
            exclude: ['packages/*/src/index.ts'],
            thresholds: { lines: 90, functions: 90 }
        }
    }
})
