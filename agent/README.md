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
```

- Identity lives at `%APPDATA%\waves-one-agent\identity.json`
  (`{ deviceId, secret }`). The secret is never logged or transmitted in full —
  only its sha256 hash is sent at registration, and requests authenticate with
  `Authorization: Bearer <deviceId>.<secret>`.
- Workspace defaults to `D:\waves-one\workspace`, overridable via the
  `WORKSPACE_ROOT` environment variable. Every file/process/cwd touched by a
  job must resolve inside it.
- Poll interval is 2s; heartbeats go out every 10s and on idle/running changes.
  Server fetch failures retry with backoff (2s, 5s, 15s, 30s max) and a log line.
  A 401 response means the credential is invalid (revoked) — the agent exits
  instead of retrying, so re-pairing is always deliberate.
- Identity file permissions rely on the OS user profile (single-user
  workstation assumption). On shared machines, restrict
  `%APPDATA%\waves-one-agent` explicitly.

## Safety model

- `agent/src/policy.mjs` is a mirror of `src/lib/agent-protocol.ts`
  (capability risk table, job→capability map, readonly/denied command patterns,
  sandbox path resolution, secret redaction). A server-side parity test keeps
  them in sync.
- Every job is re-validated locally before execution, even though the server
  pre-validates: known kind (only the 17 listed below), policy allows the
  capability, `approvalId` present when risk isn't low or policy says `approval`,
  paths resolve inside the sandbox, and `term.exec` commands are re-classified
  (denied → refuse + audit event; gated → requires `approvalId`).
- All output/errors are passed through `redactSecrets` before logging or POSTing.
- Every refusal still POSTs `{ ok: false, error }` so the audit trail shows it.
- Stop/cancel: during execution the agent polls `/flags` every 2s; on `stop` or
  `cancelCurrent` it kills the child process tree (`taskkill /T /F`) and reports
  `{ ok: false, error }`. With `stop` set and no running job, it idles without
  picking up work.

## Job kinds (17)

| Kind | Notes |
| --- | --- |
| `fs.list`, `fs.read` | Low risk. Reads capped at 200KB with a truncation note. `before` = `{ size, mtimeMs, sha256? }` (sha256 only for files < 1MB). |
| `fs.write`, `fs.mkdir`, `fs.move` | Need `approvalId`. `before`/`after` file info included. |
| `fs.delete` | Needs `approvalId`. Refuses deletes of the workspace root and hidden/system paths. |
| `term.exec` | `powershell.exe -NoProfile -NonInteractive -Command`. Timeout default 120s, max 600s. Output cap 200KB, redacted. cwd must be in-sandbox. |
| `proc.list` | Low risk (`tasklist`). |
| `proc.start` | Needs `approvalId`. Allowlist: `code`, `notepad`, `node`, `npm`, `python`. Non-flag args must be sandbox paths. PIDs tracked in `%APPDATA%\waves-one-agent\procs.json`. |
| `proc.stop` | Needs `approvalId`. Only PIDs this agent started, otherwise refused. |
| `browser.open` | https URLs only, opened via `Start-Process` (no shell interpolation). |
| `git.status`, `git.log`, `git.diff` | Low risk. cwd must be in-sandbox and inside a repo. |
| `git.commit`, `git.push` | Need `approvalId`. Remote/branch/ref validated against a safe pattern. |
| `net.download` | Needs `approvalId`. https only (redirects off https refused), 50MB cap. Executable types (`.exe/.msi/.ps1/.bat/...`) additionally need `params.allowExecutable === true`. |

## What is NOT implemented

- `credentials.use` and any credential handling — denied server-side and refused
  by the agent (unknown/unsupported kinds are refused with an audit result).
- `browser.read` / `browser.control` beyond opening a URL (no DOM access,
  screenshots, or form control), `deployment.execute`, `external_communication`,
  `financial_actions`, `system_configuration`.
- File uploads (only downloads), filesystem watching, screenshots, interactive
  desktop control, concurrent jobs (one at a time), auto-update.
