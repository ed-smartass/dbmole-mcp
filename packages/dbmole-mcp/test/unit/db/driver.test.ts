import { describe, expect, it } from 'vitest'
import {
    MissingDatabaseError,
    resolveDatabase,
    resolveQualified,
    splitQualified
} from '../../../src/db/driver.js'
import type { ConnectionConfig } from '../../../src/schema.js'

const config: ConnectionConfig = {
    name: 'c',
    type: 'postgres',
    host: 'h',
    user: 'u',
    readonly: false
}

describe('resolveDatabase', () => {
    it('prefers the explicit parameter', () => {
        expect(resolveDatabase({ ...config, database: 'default-db' }, 'explicit')).toBe('explicit')
    })

    it('falls back to the connection default', () => {
        expect(resolveDatabase({ ...config, database: 'default-db' }, undefined)).toBe('default-db')
    })

    it('throws when neither is set', () => {
        expect(() => resolveDatabase(config, undefined)).toThrow(MissingDatabaseError)
    })
})

describe('splitQualified', () => {
    it('splits schema.table and db.table', () => {
        expect(splitQualified('public.users')).toEqual({ qualifier: 'public', table: 'users' })
        expect(splitQualified('shop.orders')).toEqual({ qualifier: 'shop', table: 'orders' })
    })

    it('strips backticks and double quotes', () => {
        expect(splitQualified('`shop`.`orders`')).toEqual({ qualifier: 'shop', table: 'orders' })
        expect(splitQualified('"public"."users"')).toEqual({ qualifier: 'public', table: 'users' })
    })

    it('splits only on a dot outside quotes', () => {
        expect(splitQualified('"my.table"')).toEqual({ table: 'my.table' })
        expect(splitQualified('`my.table`')).toEqual({ table: 'my.table' })
        expect(splitQualified('"s"."t.x"')).toEqual({ qualifier: 's', table: 't.x' })
        expect(splitQualified('"".users')).toEqual({ table: '"".users' })
    })

    it('strips only the enclosing delimiters and decodes doubled ones', () => {
        expect(splitQualified('"a""b"')).toEqual({ table: 'a"b' })
        expect(splitQualified('`a``b`')).toEqual({ table: 'a`b' })
        expect(splitQualified('"s""x"."t""y"')).toEqual({ qualifier: 's"x', table: 't"y' })
        expect(splitQualified('"a`b"')).toEqual({ table: 'a`b' })
        expect(splitQualified('`a"b`')).toEqual({ table: 'a"b' })
        expect(splitQualified('"a.""b"')).toEqual({ table: 'a."b' })
    })

    it('leaves unqualified and malformed names alone', () => {
        expect(splitQualified('users')).toEqual({ table: 'users' })
        expect(splitQualified('.users')).toEqual({ table: '.users' })
        expect(splitQualified('users.')).toEqual({ table: 'users.' })
    })
})

describe('resolveQualified', () => {
    it('uses the qualifier when no explicit value is given', () => {
        expect(resolveQualified('public.users', undefined, 'schema')).toEqual({
            qualifier: 'public',
            table: 'users'
        })
    })

    it('uses the explicit value for an unqualified table', () => {
        expect(resolveQualified('users', 'app', 'schema')).toEqual({
            qualifier: 'app',
            table: 'users'
        })
        expect(resolveQualified('users', undefined, 'schema')).toEqual({ table: 'users' })
    })

    it('accepts a qualifier equal to the explicit value', () => {
        expect(resolveQualified('shop.orders', 'shop', 'database')).toEqual({
            qualifier: 'shop',
            table: 'orders'
        })
    })

    it('rejects a conflicting qualifier', () => {
        expect(() => resolveQualified('public.users', 'other', 'schema')).toThrow(
            "table qualifier 'public' conflicts with schema 'other'"
        )
        expect(() => resolveQualified('shop.orders', 'crm', 'database')).toThrow(
            "table qualifier 'shop' conflicts with database 'crm'"
        )
    })
})
