# Changelog

All notable changes to dbmole-mcp and `@dbmole/core`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-25

First public release. `@dbmole/core` is published to npm for the first time (0.2.0).

### Breaking changes

- Removed `DBMOLE_CONNECTIONS`, `DBMOLE_CONFIG` and `--config <path>`. Connections live in a
  per-project `.dbmole.json` or the global store; see Migrating below.
- `list_connections` `source` values are now `project` / `global` (were `env` / `config` /
  `store`), and the result is `{ connections, brokenLayers }`.
- `readonly` is enforced by the database session on every call (`BEGIN READ ONLY` on
  PostgreSQL, `SET SESSION TRANSACTION READ ONLY` on MySQL) and the session is reset after
  every call. The SQL lexer guard is gone: session statements such as `SET` or `USE` now run,
  but their effect ends with the call. The README lists what readonly does not stop.
- PostgreSQL `COPY ... FROM STDIN` and `COPY ... TO STDOUT` are refused with an error; use
  `INSERT` and `SELECT`.
- SSH host keys are verified against `~/.ssh/known_hosts` or a pinned `ssh.hostKey`. Existing
  SSH connections fail until the bastion's key is in `known_hosts` or pinned.
- Results that exceed the 40 KB budget carry a `truncated` object and stay valid JSON. A
  `preview` string remains only in the last-resort fallback envelope.
- Node.js 22 or newer.

### Added

- Per-project connection file `.dbmole.json`, found by walking up from the working
  directory, with a fallback to the main checkout from linked git worktrees; both layers are
  re-read on every call.
- `add_connection` `scope: "project" | "global"`, shadowing notes, and a warning when the
  project file is not ignored by git.
- `update_connection` merges an `ssh` patch into the stored tunnel field by field, so a
  `hostKey` can be pinned without resending SSH secrets.
- TLS for PostgreSQL and MySQL: `ssl: true | { ca, rejectUnauthorized }`, hostname verified
  against `host`, also through SSH.
- `queryTimeoutMs` per connection (default 60 s): PostgreSQL `statement_timeout`; MySQL
  stops the statement on the server with `KILL QUERY`.
- `list_tables` includes views and materialized views with a `type` column; `describe_table`
  accepts `schema.table` and `db.table`.
- MySQL error hints for unknown columns, unknown tables and reserved words.
- Unknown tool arguments are rejected with a hint (`unknown key 'query' — did you mean
  'sql'?`).
- SSH keepalive (15 s, 3 misses).
- A one-line stderr warning at startup when a removed 0.1 setting is still present.
- MCPB bundle for Claude Desktop, Claude Code plugin marketplace, MCP Registry metadata.

### Fixed

- Row limits are applied while reading (PostgreSQL cursor, MySQL stream), so large results no
  longer load into memory.
- The output budget no longer overshoots.
- Session state (transactions, variables, current database) no longer leaks between calls on
  a pooled connection.
- A lost connection resets the pool; read-only helpers retry once, `execute_sql` never
  replays.
- MySQL: a query with no resolvable database runs instead of failing with "no database
  specified"; `TIMESTAMP` is returned as a string; `CALL` returns its first result set.
- PostgreSQL: date and timestamp arrays keep wall-clock strings.
- Writing a connection file no longer drops entries that fail validation.
- Shutdown no longer races new connections.

### Migrating from 0.1

1. Move connections from `DBMOLE_CONNECTIONS` or a `--config` file into `.dbmole.json` at the
   project root, shape `{ "connections": [ ... ] }`, or into the global store
   (`~/.config/dbmole/connections.json`, a plain array). Add `.dbmole.json` to `.gitignore`.
2. Drop the env var and the flag from your MCP client config. Until you do, the server starts
   without them and prints one line on stderr, for example
   `dbmole: DBMOLE_CONFIG: removed in 0.2 and ignored; use the project file .dbmole.json or the
   global store`. Wrapper launchers that computed a config path, for example
   `sh -c 'npx -y dbmole-mcp --config "$(git rev-parse --git-common-dir)/../x.json"'` to share
   one file across worktrees, become plain `npx -y dbmole-mcp`: linked worktrees fall back to
   the main checkout's `.dbmole.json`.
3. Scripts that generate the connection file: write `.dbmole.json` in the main checkout
   instead. If the script rewrites the whole file, connections the agent adds with
   `scope: "project"` are lost on the next run; keep personal ones in the global store.
4. SSH connections: run `test_connection`. On a host key error, verify the printed
   fingerprint, then add the host to `~/.ssh/known_hosts` or set `ssh.hostKey`.
5. Anything that read `source: "store"` from `list_connections` now sees `"global"`.

## [0.1.2] and earlier

Internal releases.
