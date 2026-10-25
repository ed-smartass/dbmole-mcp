import * as z from 'zod'

// A strict tool input object whose unknown-key error tells the agent what to
// send instead. The SDK validates arguments before the handler runs, so the
// hint has to come from the schema itself. Still a plain ZodObject: the SDK
// advertises its .shape with additionalProperties: false.
export const strictInput = <T extends z.ZodRawShape>(
    shape: T,
    aliases: Record<string, string> = {}
): z.ZodObject<T, 'strict'> => {
    const allowed = Object.keys(shape).join(', ')
    const hint = (key: string): string =>
        Object.hasOwn(aliases, key)
            ? "unknown key '" + key + "' — did you mean '" + aliases[key] + "'?"
            : "unknown key '" + key + "'; allowed keys: " + allowed
    return z
        .object(shape, {
            errorMap: (issue, ctx) =>
                issue.code === z.ZodIssueCode.unrecognized_keys
                    ? { message: issue.keys.map(hint).join('\n') }
                    : { message: ctx.defaultError }
        })
        .strict()
}
