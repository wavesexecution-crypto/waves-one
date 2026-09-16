# Computer Agent Phase 1 — Implementation Plan (SHIPPED e041c19)

Phase 2A+2B+2C below extends this foundation without rewriting it.

**Goal:** Real local Computer Agent executing supervised jobs on the authorized Windows workstation behind the existing CEO loop. No simulation for paired devices.

**Architecture:** Next.js control plane (job queue, policy, approvals, audit) + Node agent service polling over localhost. Outbound-polling protocol mirrors the future remote design.

**Safety (non-negotiable):** Sandbox-only FS (`workspace/`). Read-only command allowlist; everything else approval-gated; destructive patterns hard-denied. High-risk capabilities can never be `allowed`. Secrets never reach the browser. Single-use pairing codes. Emergency STOP kills running work. Append-only audit.

## Task 1: Protocol (done first, single source of truth)
- `src/lib/agent-protocol.ts`: 18 capabilities, risk table, job kinds, policy validation, command allowlist/denylist + classifier, sandbox path resolver, secret redaction, pairing-code/secret generators.
- `src/lib/agent-protocol.test.ts`: risk integrity, policy validation, classifier cases, traversal rejection, redaction.

## Task 2: Control plane + API (primary agent)
- `src/lib/control-plane.ts`: file-backed stores in `.waves/` (devices, jobs, agent-approvals, policy, audit.jsonl, stop flag). Atomic writes.
- Agent API: `register`, `next`, `result`, `events`, `heartbeat` (Bearer `deviceId.secret`, hash compare).
- Control API: `devices`, `pair`, `jobs` (enqueue), `approvals` + `decide`, `policy` GET/PUT, `audit`, `stop`, `resume`, `cancel`, `revoke`, `status`.
- `next dev -H localhost`.

## Task 3: Agent service (subagent)
- `agent/src/`: `pair.mjs`, `index.mjs` (poll/heartbeat/dispatch), `secret.mjs`, `exec/*.mjs` (fs/term/proc/browser/git/net), mirrored policy constants with parity test.
- Defense in depth: re-validates policy, approval, sandbox, command class before executing. Kills child on stop/cancel. Redacts logs.

## Task 4: UI integration (subagent)
- `src/lib/agent-client.ts`, `src/components/agent-live.tsx` (device panel: status, pairing, live inspection, approval-gated test run, STOP, revoke, event stream; labeled demo fallback when unpaired).
- Approvals screen: computer-agent section. Settings: 18-capability server policy. Existing demo behavior and tests unchanged.

## Task 5: Verification (primary agent)
- `tests/agent.spec.ts`: spawn real agent, pair, live inspection, approval-gated test run, audit contents, STOP behavior.
- Gates: unit, lint, typecheck, build, full e2e. Commit.

## Deferred (explicitly not Phase 1)
Phone-over-internet backend, DOM-level browser control, credential store/use, deployment execution, external messaging/sending, autonomous goal→job decomposition.
