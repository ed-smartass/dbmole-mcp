# @dbmole/core

Shared connection core of [dbmole-mcp](https://github.com/ed-smartass/dbmole-mcp) (PostgreSQL,
MySQL) and [esmole-mcp](https://github.com/ed-smartass/esmole-mcp) (Elasticsearch): the
two-layer connection registry (per-project `.<server>.json` + global store, re-read on every
call), SSH tunnels with host key verification, the pooled backend `Manager`, the output budget
(`fitJson`), and the MCP connection tools (`list/add/update/remove/test_connection`).

The servers bundle this package at build time, so end users never install it. It is published
so the esmole repo can build against it. The API follows semver but is shaped by those two
servers; there are no stability promises beyond that.

ESM only, Node.js 22 or newer. MIT license.
