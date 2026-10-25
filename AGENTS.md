# Agent rules for dbmole-mcp

Applies to every change in this repo, by any agent or human.

## Architecture

- npm workspace monorepo, packages under `packages/`:
  - `@dbmole/core` — shared Manager/registry/project-file/SSH-tunnel/MCP plumbing, published
    to npm. Leaves bundle it via tsup (`noExternal`). Inside the workspace every tool resolves
    it to `src/` through the `@dbmole/source` export condition (tsconfig `customConditions`,
    vitest `ssr.resolve.conditions`, tsup `esbuildOptions.conditions`,
    `tsx --conditions=@dbmole/source`), so nothing needs a core build first.
  - `dbmole-mcp` — PostgreSQL + MySQL server
- Backends spread `baseConnectionShape`, add engine fields + `type`, call `.strict()`.
- Run workspace commands from the root, they fan out across packages:
  `npm run typecheck` / `build` / `test:unit` / `test:int` / `coverage` / `lint` / `smoke`.

## Code style

- 4-space indentation
- No semicolons where possible (`semicolons: asNeeded`)
- Single quotes where possible
- Functions as `const fn = () => {}` where possible
- No trailing commas before a closing `}`, `]`, `)` (`trailingCommas: none`)
- Always use braces for `if`/`else`/loop bodies — never single-line bodies like
  `if (x) return y`. Write:

  ```ts
  if (typeof value === 'bigint') {
      return value.toString()
  }
  ```

  (Biome `useBlockStatements` enforces this)
- No template-literal interpolation for building strings: use concatenation —
  `'[' + engine + '] ' + message`, NOT `` `[${engine}] ${message}` ``.
  Plain multi-line template literals WITHOUT `${}` (e.g. SQL text blocks) are fine.
- Biome enforces all of the above — run `npm run lint:fix` before every commit
- Line width 100

## TypeScript discipline

- No `as unknown as X` double-casts anywhere
- No `@ts-ignore` / `@ts-expect-error` / `any` in `src/`
- In tests prefer typed fakes (see `packages/dbmole-mcp/test/unit/helpers.ts`); a
  single `as` cast is a last resort, only when there is genuinely no typed way
- Types must line up by construction — if they don't, fix the design, not the cast

## Testing

- TDD: write the failing test first, watch it fail, implement, watch it pass
- Full coverage: unit tests (mocked IO) + integration tests via testcontainers
- Coverage thresholds ≥90% lines/functions on the unit project — never lower them
- `npm run test:unit` (fast), `npm run test:int` (needs Docker)

## Commits

- Conventional Commits: `<type>(<scope>): <imperative summary>`
- Subject ≤50 chars (hard cap 72), no trailing period
- Body only when the *why* is not obvious from the diff; wrap at 72
- NO AI attribution: no `Co-Authored-By: Claude ...`, no "Generated with ..."
- No emoji

## Project constraints

- stdout is the MCP protocol channel — diagnostics go to `console.error` ONLY,
  never `console.log`
- ESM with NodeNext resolution: relative imports need the `.js` extension
- MCP SDK v1 (`@modelcontextprotocol/sdk`): `registerTool` accepts a ZodRawShape
  (plain object of zod fields) OR a full Zod object (verified on 1.29: AnySchema,
  `.strict()` honored at runtime). The advertised `inputSchema` MUST expose
  `.shape` — pass a ZodRawShape or a plain `z.object`/`.strict()`, NEVER a
  `.superRefine`/`.refine` (ZodEffects has no `.shape`, so the SDK publishes an
  empty `{ properties: {} }` and clients see no fields). Keep cross-field
  refinements on a separate parse schema: `registerConnectionTools` takes
  `fullSchema` (strict object, advertised) plus optional `parseSchema` (refined,
  applied in the handler) — see `connectionObjectSchema` / `connectionConfigSchema` in
  each server's `schema.ts`. Use a strict `z.object`
  where unknown-key rejection matters; raw shapes are fine elsewhere. Subpath
  imports (`server/mcp.js`, `server/stdio.js`, `client/index.js`, `inMemory.js`,
  `types.js`)
- zod 3 (`import * as z from 'zod'`)
