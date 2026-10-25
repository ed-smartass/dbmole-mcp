import { describe, expect, it } from 'vitest'
import { isLostConnection } from '../../src/wiring.js'

const withCode = (code: string, message = 'boom'): Error =>
    Object.assign(new Error(message), { code })

describe('isLostConnection', () => {
    it('detects dropped mysql and postgres connections', () => {
        for (const code of ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', '57P01']) {
            expect(isLostConnection(withCode(code))).toBe(true)
        }
        expect(isLostConnection(new Error('Connection terminated unexpectedly'))).toBe(true)
        expect(isLostConnection(new Error('Connection terminated'))).toBe(true)
    })

    it('does not treat timeouts as lost connections', () => {
        expect(
            isLostConnection(withCode('PROTOCOL_SEQUENCE_TIMEOUT', 'Query inactivity timeout'))
        ).toBe(false)
        expect(
            isLostConnection(withCode('57014', 'canceling statement due to statement timeout'))
        ).toBe(false)
        expect(isLostConnection(withCode('ETIMEDOUT', 'connect ETIMEDOUT'))).toBe(false)
        expect(isLostConnection(new Error('Connection terminated due to connection timeout'))).toBe(
            false
        )
    })

    it('does not treat query errors or non-errors as lost connections', () => {
        expect(isLostConnection(withCode('ER_BAD_FIELD_ERROR'))).toBe(false)
        expect(isLostConnection(withCode('42P01'))).toBe(false)
        expect(isLostConnection('ECONNRESET')).toBe(false)
    })
})
