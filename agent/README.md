# WAVES ONE Computer Agent

Windows-first background service (plain Node `.mjs`, zero npm dependencies) that
polls the WAVES ONE control plane, executes approved computer jobs inside a
sandbox workspace, and reports results.

## Setup

```powershell
# 1. Pair this device (generates identity, prints a single-use pairing code)
node agent/pair.mjs --server http://127.0.0.1:3100

# 2. Enter the pairing code in the WAVES ONE control plane to approve the device

# 3. Run the agent
node agent/src/index.mjs --server http://127.0.0.1:3100

# 4. Rotate the device credential when needed (never prints the secret)
node agent/src/rotate.mjs --server http://127.0.0.1:3100
```

- Identity lives at `%APPDATA%\waves-one-agent\identity.json`
  (`{ deviceId, secret }`). The secret is never logged or transmitted in full —
  only its sha256 hash is sent at registration, and requests authenticate with
  `Authorization: Bearer <deviceId>.<secret>`.
- Workspace roots default to `D:\waves-one\workspace`, overridable via the
  `WORKSPACE_ROOTS` environment variable (split on `;` or newline, trim, drop
  empties). The legacy `WORKSPACE_ROOT` single value is still honored as a
  fallback. Every file/process/cwd touched by a job must resolve inside one of
  the configured roots; jobs may pin a root with `params.root` (must exactly
  match a configured root, otherwise refused). The agent creates every root at
  startup and passes them to executors as `ctx.roots` (`ctx.workspaceRoot` is
  kept as `roots[0]` for compatibility).
- Poll interval is 2s; heartbeats go out every 10s and on idle/running changes,
  each carrying a `telemetry` snapshot (see below). Server fetch failures retry
  with backoff (2s, 5s, 15s, 30s max) and a log line. A 401 response means the
  credential is invalid (revoked) — the agent exits instead of retrying, so
  re-pairing is always deliberate.
- Identity file permissions rely on the OS user profile (single-user
  workstation assumption). On shared machines, restrict
  `%APPDATA%\waves-one-agent` explicitly.

## Safety model

- `agent/src/policy.mjs` is a mirror of `src/lib/agent-protocol.ts` v2
  (28 capabilities, capability risk, 40 job kinds, job→capability map with
  `effectiveCapability` for `term.exec`, default policy with `roots: []` and
  domains, `validatePolicy` incl. roots/domains, `migratePolicy`,
  readonly/gated/admin/denied classification with `ADMIN_PATTERNS`, sandbox
  resolution with ADS-segment refusal, `resolveAcrossRoots`,
  `isUrlAllowed`/`normalizeHost`, `redactSecrets`, `sha256Hex`,
  `scrubSecretParams`, pairing/secret generators, `TERMINAL_STATUSES`).
  A server-side parity test keeps them in sync.
- Every job is re-validated locally before execution, even though the server
  pre-validates: known kind (only the 40 listed below), policy allows the
  effective capability (`terminal.read` for readonly commands, `terminal.admin`
  for privilege escalation, `terminal.execute` otherwise), `approvalId` present
  when risk isn't low or policy says `approval`, paths (`path`, `from`, `to`,
  `cwd`, `dest`, `src`) resolve inside the roots via `resolveAcrossRoots`
  honoring `params.root`, and `term.exec` commands are re-classified
  (denied → refuse + audit event; admin → needs `terminal.admin`, denied by
  default; gated → requires `approvalId`).
- All output/errors/stderr are passed through `redactSecrets` before logging
  or POSTing.
- Every refusal still POSTs `{ ok: false, error }` so the audit trail shows it.
- Stop/cancel: during execution the agent polls `/flags` every 2s; on `stop` or
  `cancelCurrent` it kills the child process tree (`taskkill /T /F`) and reports
  `{ ok: false, error, outcome }` where `outcome` is `'stopped'` for a STOP and
  `'cancelled'` for a cancel (omitted otherwise). With `stop` set and no running
  job, it idles without picking up work.
- Executors may return an optional `stderr` string alongside `output`; the
  agent posts it as `result.stderr` (redacted).

## Telemetry

Every heartbeat carries `telemetry` from `agent/src/telemetry.mjs`
(`collectTelemetry(prev)`):

- `cpuPct` — `os.cpus()` delta vs the previous sample, 0–100.
- `memPct` — `(total - free) / total` from `os.totalmem()/freemem()`.
- `diskPct` + `diskPath` — `fs.statfsSync` on the first root (guarded).
- `procs` — `tasklist` line count, cached 30s (guarded).
- `uptimeSec` — `os.uptime()`, `user` — `os.userInfo().username` (guarded),
  `os` — `` `${platform} ${release}` ``.
- `tools` — versions for `code,node,npm,pnpm,python,docker,git,gh` via
  `where.exe` + `--version` (5s timeout each), cached hourly; missing tools
  are `null`.
- `browser` — from an optional dynamic import of the browser session status
  (`getSessionStatus()`), guarded to `undefined` when the browser workstream
  module is absent.

Telemetry never throws; failed probes are omitted.

## Rotation

`agent/src/rotate.mjs --server <url>` loads the identity, POSTs to
`/api/agent/rotate` with Bearer auth, saves the returned `{ secret }` via
`saveIdentity(deviceId, secret)` in `agent/src/secret.mjs`, and prints a
confirmation **without** the secret. Failures exit non-zero with a clear
message (notably HTTP 401 for a revoked credential).

## Upload flow

- `upload.artifact` jobs (capability `uploads.write`, approval required) are
  handled by `agent/src/exec/upload.mjs` `execUpload(params, ctx)`: it reads a
  roots-contained file (`params.path`, ≤15MB), sha256-hashes it, and POSTs
  `{ jobId: ctx.jobId, name, kind: params.kind || 'file', mime, dataBase64 }`
  to `${ctx.serverUrl}/api/agent/artifacts` with `ctx.authHeader()`,
  returning `{ ok, output, after: { size, sha256, artifactId } }`.
- The router file (`agent/src/exec/index.mjs`) is owned by the primary
  workstream and is **not** wired here — integration wires `upload.artifact`
  (and the new fs/git kinds) at merge time.
- Executors that need to upload outside a job use `ctx.uploadArtifact({ name,
  kind, mime, data: Buffer })` (provided by `index.mjs` as
  `{ artifactId, size, sha256 }` via the same endpoint with
  `{ jobId: ctx.jobId }`). `ctx` also carries `serverUrl` (string),
  `authHeader()` (returns `` `Bearer id.secret` ``), and `policy` (the poll
  policy object).

## Job kinds (40)

| Kind | Notes |
| --- | --- |
| `fs.list`, `fs.read` | Low risk. Reads capped at 200KB with a truncation note. `before` = `{ size, mtimeMs, sha256? }` (sha256 only for files < 1MB). |
| `fs.write`, `fs.mkdir` | Need `approvalId`. `before`/`after` file info included. Link/junction escape refused. |
| `fs.move` | Needs `approvalId`. Any-directory move (`src`/`from`/`path` → `dest`/`to`). |
| `fs.copy` | Needs `approvalId`. Dest parent dirs created. Link/ADS escape refused. Files via `copyFile`, directories recursive. |
| `fs.rename` | Needs `approvalId`. Same-directory only; cross-directory renames are refused with a pointer to `fs.move`. |
| `fs.hash` | Low risk. sha256 of a file of any size via stream. Returns the hex digest plus `after: { size, sha256 }`. |
| `fs.search` | Low risk. Recursive literal-substring filename+content search from `path` (default `.`), `query` required. Max depth 6, max 2000 files, 200KB output cap, redacted. |
| `fs.meta` | Low risk. `{ size, mtimeMs, sha256-if-small, isDir, realpath }` as JSON plus `after`. |
| `fs.delete` | Needs `approvalId`. Refuses deletes of the workspace root and hidden/system paths. |
| `term.exec` | `powershell.exe -NoProfile -NonInteractive -Command`. Timeout default 120s, max 600s. Output cap 200KB, redacted, `stderr` posted separately. cwd must be in-roots. Classification: readonly → `terminal.read` (no approval), gated → `terminal.execute` + approval, admin → `terminal.admin` (denied by default, unimplemented), denied → refused. |
| `proc.list` | Low risk (`tasklist`). |
| `proc.start` | Needs `approvalId`. Allowlist: `code`, `notepad`, `node`, `npm`, `python`. Non-flag args must be in-roots paths. PIDs tracked in `%APPDATA%\waves-one-agent\procs.json`. |
| `proc.stop` | Needs `approvalId`. Only PIDs this agent started, otherwise refused. |
| `browser.open` | https URLs only, opened via `Start-Process` (no shell interpolation). Other `browser.*` kinds (navigate/inspect/click/type/select/scroll/download/upload/screenshot/wait/extract/close) are validated by policy but executed by the sibling browser workstream. |
| `git.status`, `git.log`, `git.diff` | Low risk. cwd must be in-roots and inside a repo. |
| `git.commit`, `git.push` | Need `approvalId`. Remote/branch/ref validated against a safe pattern. |
| `git.pull` | Needs `approvalId`. Runs `pull --ff-only` (optional validated `remote`/`branch`). |
| `git.branch` | Needs `approvalId`. `name` (validated) creates a branch (optional validated `startPoint`); without `name` lists branches. |
| `git.checkout` | Needs `approvalId`. `ref`/`branch`/`name` validated. |
| `github.issue`, `github.pr` | Need `approvalId`. Run via the `gh` CLI; refused with a clear error when `gh` is missing. `title` required; `body`/`repo`/`head`/`base` validated. Output redacted, `stderr` separated. |
| `net.download` | Needs `approvalId`. https only (redirects off https refused), 50MB cap. Executable types (`.exe/.msi/.ps1/.bat/...`) additionally need `params.allowExecutable === true`. |
| `upload.artifact` | Needs `approvalId`. See Upload flow above. |

## What is NOT implemented

- `terminal.admin` (privilege escalation: runas/psexec/sudo/schtasks/dism/… —
  classified as `admin`, capability denied by default) and `filesystem.execute`
  are denied and have no executor.
- `deployment.execute`, `credentials.use`, `financial_actions`,
  `external_communication`, `system_configuration` are denied server-side and
  refused by the agent (unknown/unsupported kinds are refused with an audit
  result). No credential handling, deployment, payment, or external-messaging
  executors exist.
- Beyond `browser.open`, the `browser.*` control surface (DOM, screenshots,
  form control) lives with the sibling browser workstream, as does router
  wiring in `agent/src/exec/index.mjs`.
- Filesystem watching, screenshots, interactive desktop control, concurrent
  jobs (one at a time), auto-update.
