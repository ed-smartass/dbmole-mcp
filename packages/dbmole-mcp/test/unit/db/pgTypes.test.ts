import type { CustomTypesConfig } from 'pg'
import { describe, expect, it } from 'vitest'
import { buildTypeOverrides } from '../../../src/db/postgres.js'

// Through CustomTypesConfig the parser is typed `any`; TypeOverrides types it as
// taking a number.
const types: CustomTypesConfig = buildTypeOverrides()
const parse = (oid: number, value: string): unknown => types.getTypeParser(oid, 'text')(value)

describe('buildTypeOverrides', () => {
    it('keeps date and timestamp scalars as wall-clock strings', () => {
        expect(parse(1082, '2026-10-24')).toBe('2026-10-24')
        expect(parse(1114, '2026-10-24 00:30:00')).toBe('2026-10-24 00:30:00')
    })

    it('keeps date[] and timestamp[] as wall-clock strings', () => {
        expect(parse(1182, '{2026-10-24,NULL}')).toEqual(['2026-10-24', null])
        expect(parse(1115, '{"2026-10-24 00:30:00"}')).toEqual(['2026-10-24 00:30:00'])
    })

    it('leaves timestamptz and timestamptz[] absolute', () => {
        expect(parse(1184, '2026-10-24 00:30:00+00')).toEqual(new Date('2026-10-24T00:30:00Z'))
        expect(parse(1185, '{"2026-10-24 00:30:00+00"}')).toEqual([
            new Date('2026-10-24T00:30:00Z')
        ])
    })
})
