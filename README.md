# WAVES ONE

The operating headquarters of Waves. A mobile-first CEO command center built with Next.js, React, TypeScript, and the OBSIDIAN design language — with a REAL Computer Agent operating the authorized workstation under explicit permission gates, reachable remotely over authenticated outbound connections.

## Run (local)

```sh
npm install
npm run dev -- --port 3100
```

Open http://localhost:3100 and select **Enter WAVES ONE**. Entry is a demo flow, not authentication. Node.js 24 is recommended. The dev server binds to localhost only.

## Real Computer Agent (Phase 2)

WAVES ONE operates the authorized workstation through a privileged local agent. The browser NEVER gets filesystem, shell, or credential access — it only enqueues supervised jobs and reviews results.

```powershell
# 1. Pair this workstation (prints a single-use code)
node agent/pair.mjs --server http://localhost:3100

# 2. Enter the code in WAVES ONE → AI screen → CONNECTION

# 3. Run the agent (leave it running)
node agent/src/index.mjs --server http://localhost:3100
```

Remote (cloud) operation: the agent takes any HTTPS `--server` URL and only
ever dials out — no inbound workstation port. See `docs/deploy-cloud.md`
for hosting the control plane (persistent disk, TLS, `WAVES_OWNER_TOKEN`)
and connecting a phone over the internet.

Then: AI screen shows the live device with telemetry (CPU/memory/disk,
tools, browser session), Run inspection executes real listings, Request
test run creates an approval-gated job, STOP ALL halts everything
instantly. The Approvals screen hosts computer-agent decisions (with
expiry); Settings hosts the 28-capability server policy plus authorized
filesystem roots and browser domain policy; Files hosts uploaded agent
artifacts (screenshots, downloads, reports).

Job lifecycle: `queued → authorized → dispatched → running → verifying →
completed`, plus `failed / cancelled / denied / expired / stopped`. Jobs
survive restarts and reconnects (idempotency keys, attempt budgets, orphan
requeue without duplicate execution).

Safety model:

- **Authorized roots:** every file, process cwd, and transfer target must resolve inside an owner-configured root (default `workspace/`). Symlink/junction escapes (realpath), traversal, and alternate-data-stream abuse are refused on both server and agent.
- **Commands:** a narrow read-only allowlist runs freely; everything else needs an approved approval; destructive patterns are hard-denied before execution; privilege escalation needs `terminal.admin` (denied by default, unimplemented).
- **Approvals bind to exactly one job** (kind + params, 24h expiry) and are single-use. Replays are refused.
- **High-risk capabilities can never be set to allowed** — the UI hides the option and the server rejects it.
- **Secrets:** per-device 256-bit credentials live in `%APPDATA%/waves-one-agent` and as hashes in `.waves/` (gitignored); rotation invalidates instantly. Pairing codes are single-use, 10-minute TTL. Nothing secret reaches the browser. Typed browser secrets travel TLS to the paired agent only and are scrubbed from storage on completion. Command output is redacted before audit.
- **Control:** emergency STOP kills running process trees and holds new work; per-job cancel; pause/resume; revocation kills the credential (agent exits instead of retrying).
- **Audit:** every queue, dispatch, decision, execution, refusal, rotation, and stop is appended to `.waves/audit.jsonl` with actor, authorization, permission, approval, and before/after state.
- **Browser:** isolated Chromium profile (never the owner's browser), domain allow/block enforcement per navigation, action logging without content, no CAPTCHA defeat.

Trust boundaries: local API binds localhost; cloud deployments add TLS plus the owner token (`WAVES_OWNER_TOKEN`) on all control endpoints and per-device bearer credentials on agent endpoints. Rate limits guard registration, pairing, mutations, and polling. This phase assumes a single-user workstation and terminal access for pairing. Credential use, deployments, financial actions, and external messaging remain denied and unimplemented.

## Explore the CEO loop

1. **Set direction:** choose New goal, describe an outcome, and review the generated template plan.
2. **Delegate:** save a draft or delegate the plan to simulated workers. All tasks link back to the goal.
3. **Supervise:** inspect running work, dependencies, blockers, people, and artifacts.
4. **Intervene:** open a blocked task and record how access was resolved. Never enter actual credentials.
5. **Decide:** Review an approval’s what, why, impact, risk, cost, and evidence. Approve, reject, or request changes. Rejections/changes require a reason.
6. **Execute and verify:** after approving, open Approvals → History and choose Simulate approved execution. Task sheets also support dependency-gated simulated verification.
7. **Audit:** Activity shows each local action and decision; filters and JSON export are available.

Use **Ctrl+K / ⌘K** or the terminal button to open WAVES AI. Supported commands include blocked work, team summaries, incident review, approvals, goal planning, and the computer-agent simulator. This is deterministic routing and template planning, not a live language model.

## Other spaces

- **Goals / Work:** linked execution plans, task status, priority, deadlines, dependencies, outputs.
- **People:** employees, contractors, AI agents, automated workers, and unfilled departments.
- **Systems:** simulated incidents, recovery, and a data-driven connector registry.
- **Files:** readable local artifacts, goal provenance, creator, timestamp, downloads.
- **AI:** supervised inspection simulation, pause/resume, permission checks, visible audit.
- **Settings:** granular simulated permissions, notification preview, and reset with confirmation.

## Boundaries

- Demo organization data (goals, people, simulated workers) is still browser-local simulation for supervision UX. Computer-agent jobs are REAL workstation execution — treat approvals accordingly.
- No live integrations, actual AI calls, production changes, credential use, deployments, or external messaging yet.
- No real user authentication. Entry is a demo flow. Do not use this build to store sensitive business information.
- Demo permissions gate the **local simulation only**. Computer-agent enforcement is server-side (`.waves/policy.json`) plus agent-side re-validation.
- Demo data persists under `waves-one-prototype-v1` in localStorage on the same origin. If browser storage is unavailable, a warning explains session-only behavior.
- Seed activity is illustrative. New local actions update the feed immediately; no real-time service is connected.
- Entry state is stored separately under `waves-one-entered`.
- Reset only affects the demo workspace. It never alters external files or services.

## Architecture

- `src/lib/model.ts`: typed entities, realistic seed data, pure action reducer, dependency/permission gates, goal templates, persistence validation.
- `src/lib/model.test.ts`: domain state-machine regression tests.
- `src/components/store.tsx`: React context, hydration-safe local persistence, status messages.
- `src/components/headquarters.tsx`: app shell, mobile navigation, entry, global commands.
- `src/components/overview.tsx`: attention queue, current work, goals, brief and activity.
- `src/components/flows.tsx`: review/decision sheets, goal creation, task/worker/incident/file detail, command interface.
- `src/components/workspace.tsx`: supervision spaces and settings.
- `src/lib/agent-protocol.ts`: 18 computer-agent capabilities, risk table, job kinds, policy validation, command allowlist/denylist, sandbox resolver, secret redaction.
- `src/lib/control-plane.ts`: device pairing/auth, job queue, approval binding, execution policy, emergency stop, append-only audit (`.waves/`).
- `src/app/api/agent/*`, `src/app/api/control/*`: agent polling/result API (bearer devices) and UI control API.
- `agent/`: zero-dependency Windows agent service (pairing, poll loop, sandboxed executors). See `agent/README.md`.
- `src/components/agent-live.tsx` + `src/lib/agent-client.ts`: live device panel, jobs, agent audit, server policy UI.
- `src/components/ui.tsx`: shared accessible native dialogs and presentation primitives.
- `src/app/globals.css`: OBSIDIAN tokens and responsive layouts.

The connector registry is data-driven so future server-side adapters can replace the simulation without changing the product’s navigation. A production system still needs authenticated server-side authorization, durable jobs, approval binding to immutable action payloads, secure credential storage, and tamper-resistant audit logs before any real authority is granted.

## Verification commands

```sh
npm test
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright runs desktop and mobile Chromium projects. Test artifacts are under `test-results/`.
