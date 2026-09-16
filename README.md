# WAVES ONE

The operating headquarters of Waves. A mobile-first, interactive local prototype built with Next.js, React, TypeScript, and the OBSIDIAN design language.

## Run

```sh
npm install
npm run dev -- --port 3100
```

Open http://localhost:3100 and select **Enter WAVES ONE**. Entry is a demo flow, not authentication. Node.js 24 is recommended.

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

- No backend, live integrations, actual AI calls, real agents, terminal execution, or production changes.
- No real authentication, authorization enforcement, credentials, or secrets. Do not use this build to store sensitive business information.
- Permissions gate the **local simulation only**. Browser state and audit records are user-editable and are not tamper-proof.
- Data persists under `waves-one-prototype-v1` in localStorage on the same origin. If browser storage is unavailable, a warning explains session-only behavior.
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
