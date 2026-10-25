import { defineConfig } from 'vitest/config'

export default defineConfig({
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
