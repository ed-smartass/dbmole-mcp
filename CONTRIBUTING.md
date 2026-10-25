# Contributing

Bug reports and pull requests are welcome.

## Setup

- Node.js 22 or newer and npm.
- Docker, for the integration tests (testcontainers starts real database / cluster
  containers).

Fork the repository, clone your fork, then run `npm ci` in its root.

## Commands

Run everything from the repository root.

| Command | What it does |
| --- | --- |
| `npm run lint` / `npm run lint:fix` | Biome check / fix |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | unit tests with mocked IO (fast) |
| `npm run test:int` | integration tests (needs Docker) |
| `npm run coverage` | unit tests with coverage; lines and functions must stay at 90% or more |
| `npm run build` | bundle to `dist/` |
| `npm run smoke` | build, `npm pack`, install the tarball in an empty temp dir, boot it, check `tools/list` |
| `npm run docker:smoke` | build the Docker image and check `tools/list` through `docker run -i` |

## Rules

[AGENTS.md](AGENTS.md) is the full contract; coding agents read it too. In short:

- **Tests first.** Write the failing test, watch it fail, implement, watch it pass. Unit tests
  mock IO; behavior that depends on a real server gets an integration test.
- **Style**, enforced by Biome: 4-space indent, no semicolons, single quotes, no trailing
  commas, braces on every `if`/loop body, `const fn = () => {}`, line width 100. Build strings
  with `+`, not `${}` template interpolation.
- **TypeScript:** no `as unknown as`, no `any` / `@ts-ignore` / `@ts-expect-error` in `src/`.
  If types do not line up, fix the design rather than cast.
- stdout is the MCP protocol channel: diagnostics go to `console.error` only.
- ESM with NodeNext resolution: relative imports end in `.js`.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <summary>`,
  imperative, at most 50 characters, no trailing period, no emoji, no AI attribution trailers.
- One topic per pull request, with its tests.
- CI must be green: lint, typecheck, unit tests and smoke on Node.js 22 and 24, plus the
  integration suite.
- When behavior changes, update the README and add a line under `## [Unreleased]` in
  `CHANGELOG.md`.
