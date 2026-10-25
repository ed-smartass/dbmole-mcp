import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { type Backend, BackendDisposedError } from '../../../src/backend.js'
import type { ManagedConnection, Manager } from '../../../src/manager.js'
import { LOST_CONNECTION_NOTE, withManaged } from '../../../src/mcp/managed.js'
import { ToolFailure } from '../../../src/mcp/respond.js'

type TestConfig = { name: string; type: string }
type TestBackend = Backend & { ping: () => Promise<string> }
type TestManaged = ManagedConnection<TestConfig, TestBackend>

const config: TestConfig = { name: 'c', type: 'postgres' }

const managed = (backend: Partial<TestBackend> = {}): TestManaged => ({
    backend: { dispose: vi.fn(async () => {}), ping: vi.fn(async () => 'ok'), ...backend },
    config,
    source: 'global'
})

type FakeManager = Manager<TestConfig, TestBackend> & {
    get: ReturnType<typeof vi.fn>
    invalidate: ReturnType<typeof vi.fn>
    disposeAll: ReturnType<typeof vi.fn>
}

const fakeManager = (): FakeManager => ({
    get: vi.fn(),
    invalidate: vi.fn(async () => {}),
    disposeAll: vi.fn(async () => {})
})

const formatError = (cfg: TestConfig, error: unknown): string =>
    '[' + cfg.type + '] ' + (error instanceof Error ? error.message : String(error))

const lostError = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

const isLostConnection = (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === 'ECONNRESET'

const text = (result: CallToolResult): string => {
    const first = result.content[0]
    return first && first.type === 'text' ? first.text : ''
}

describe('withManaged', () => {
    it('returns ok with the fn result on success', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn(async () => ({ value: 42 }))

        const result = await withManaged(manager, 'c', fn, { formatError })

        expect(result.isError).toBeFalsy()
        expect(JSON.parse(text(result))).toEqual({ value: 42 })
        expect(manager.get).toHaveBeenCalledTimes(1)
    })

    it('fails when manager.get throws, without invoking fn', async () => {
        const manager = fakeManager()
        manager.get.mockRejectedValue(new Error('no such connection'))
        const fn = vi.fn()

        const result = await withManaged(manager, 'c', fn, { formatError })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('no such connection')
        expect(fn).not.toHaveBeenCalled()
    })

    it('returns a ToolFailure message verbatim, without formatError', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn().mockRejectedValue(new ToolFailure('index name must not contain /'))

        const result = await withManaged(manager, 'c', fn, { formatError, isLostConnection })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('index name must not contain /')
        expect(manager.invalidate).not.toHaveBeenCalled()
    })

    it('retries once when the backend was disposed under the caller', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new BackendDisposedError())
            .mockResolvedValueOnce({ value: 7 })

        const result = await withManaged(manager, 'c', fn, { formatError })

        expect(result.isError).toBeFalsy()
        expect(JSON.parse(text(result))).toEqual({ value: 7 })
        expect(manager.get).toHaveBeenCalledTimes(2)
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('gives up with a reconfiguring message after a second disposal', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn().mockRejectedValue(new BackendDisposedError())

        const result = await withManaged(manager, 'c', fn, { formatError })

        expect(result.isError).toBe(true)
        expect(text(result)).toContain('being reconfigured')
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('formats other errors via formatError, no retry, no invalidate', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn().mockRejectedValue(new Error('boom'))

        const result = await withManaged(manager, 'c', fn, { formatError, isLostConnection })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('[postgres] boom')
        expect(fn).toHaveBeenCalledTimes(1)
        expect(manager.invalidate).not.toHaveBeenCalled()
    })

    it('a lost connection invalidates the backend and is never replayed by default', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn().mockRejectedValue(lostError())

        const result = await withManaged(manager, 'c', fn, { formatError, isLostConnection })

        expect(result.isError).toBe(true)
        expect(text(result)).toBe('[postgres] read ECONNRESET\n' + LOST_CONNECTION_NOTE)
        expect(LOST_CONNECTION_NOTE).toBe(
            'connection lost; pool reset; the statement may or may not have run'
        )
        expect(manager.invalidate).toHaveBeenCalledWith('c')
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('retrySafe replays once on a fresh backend after a lost connection', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn().mockRejectedValueOnce(lostError()).mockResolvedValueOnce(['db1'])

        const result = await withManaged(manager, 'c', fn, {
            formatError,
            isLostConnection,
            retrySafe: true
        })

        expect(result.isError).toBeFalsy()
        expect(JSON.parse(text(result))).toEqual(['db1'])
        expect(manager.invalidate).toHaveBeenCalledTimes(1)
        expect(manager.get).toHaveBeenCalledTimes(2)
    })

    it('retrySafe gives up after the replay is lost too', async () => {
        const manager = fakeManager()
        manager.get.mockResolvedValue(managed())
        const fn = vi.fn().mockRejectedValue(lostError())

        const result = await withManaged(manager, 'c', fn, {
            formatError,
            isLostConnection,
            retrySafe: true
        })

        expect(text(result)).toBe('[postgres] read ECONNRESET\n' + LOST_CONNECTION_NOTE)
        expect(manager.invalidate).toHaveBeenCalledTimes(2)
        expect(fn).toHaveBeenCalledTimes(2)
    })
})
