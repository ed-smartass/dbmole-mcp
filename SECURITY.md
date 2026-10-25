# Security policy

## Supported versions

Security fixes go into the latest minor release (currently 0.2.x).

## Reporting a vulnerability

Report it privately through GitHub: this repository's **Security** tab → **Report a
vulnerability**. Please do not open a public issue. You get an answer within 7 days.

## Threat model in brief

- The server runs locally with your user's permissions and talks to its MCP client over stdio.
  The only listening sockets are SSH tunnels: each open tunnel listens on `127.0.0.1` at a
  random port without authentication, so while it is open any local process, including other
  users on a shared host, can connect through it to the target host. The database or cluster
  still asks for its own credentials.
- Connection files (`.dbmole.json` / `.esmole.json` and the global store under `~/.config/`)
  hold plaintext credentials with mode `0600`, the same trust model as `~/.pgpass`: whoever
  can read the file has the credentials. Keep project files in `.gitignore`; the server warns
  when one is not ignored.
- Connections added through the tools pass through the model's context.
- A project file is trusted as is. Opening a cloned or untrusted repository loads its
  `.dbmole.json` / `.esmole.json`, which can add connections or shadow a global connection of
  the same name, for example pointing a name you use every day at an attacker's host so the
  agent sends your queries there. Discovery walks up from the working directory to `/`, so a
  file in a parent directory (such as `~`) applies to every project below it. Check
  `list_connections` (it shows each connection's source) before working in an unfamiliar
  repository.
- Whoever can change a connection (the agent through `update_connection`, or anyone who can
  write the file) can redirect its credentials: a changed `host` or `ssh.host` keeps the
  stored password, API key or SSH key, and the next call sends them to the new host.
- `readonly` protects against accidental writes. It is not a security boundary: an agent can
  switch it off with `update_connection`, by design. For a hard guarantee, use a
  least-privilege database role or an Elasticsearch role with read privileges only.
- SSH host keys are verified against `~/.ssh/known_hosts` or a pinned `ssh.hostKey`; unknown
  keys are rejected (no trust-on-first-use).
- Database and cluster error messages are returned to the MCP client verbatim, by design.

Reports about any of the above being weaker than described are in scope.
