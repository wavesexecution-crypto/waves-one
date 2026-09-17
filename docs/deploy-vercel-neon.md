# WAVES ONE Production — Vercel + Neon PostgreSQL (Phase 3)

Architecture:

```
WAVES ONE (browser / phone, owner token in localStorage only)
    ↓ https, same-origin /api only
Vercel (Next.js App Router, Node runtime, force-dynamic API routes)
    ↓ pooled DATABASE_URL (PgBouncer, server-only — never NEXT_PUBLIC_*)
Neon PostgreSQL (source of truth: devices, jobs, approvals, audit, …)
    ↑ migrations via DIRECT url (drizzle-kit, never pooled)
Computer Agent (workstation: outbound HTTPS polling only, no inbound ports)
```

No Upstash/Redis in this path. Redis remains a separate future decision;
nothing in the codebase depends on it.

## 1. Neon setup (one project, three databases/branches)

| Vercel env  | Neon branch | Purpose                    |
|-------------|-------------|----------------------------|
| Development | `dev`       | local `neon env pull`, integration tests |
| Preview     | `preview`   | PR deployments             |
| Production  | `main`      | `https://one.wavesco.in`   |

Apply migrations to each branch with the DIRECT connection:

```sh
DATABASE_URL_UNPOOLED="<direct-url-for-branch>" npx drizzle-kit migrate
```

Migrations are versioned in `drizzle/` (`0000_*` control-plane core,
`0001_*` extended domain, `0002_*` artifact blobs). Never edit an applied
migration — add a new one via `npx drizzle-kit generate`.

## 2. Vercel environment variables (per environment)

| Variable               | Value                          | Environments              |
|------------------------|--------------------------------|---------------------------|
| `DATABASE_URL`         | pooled Neon URL (`-pooler`)    | Development/Preview/Production (per-branch values) |
| `DATABASE_URL_UNPOOLED`| direct Neon URL                | same (migrations/debugging; server-only) |
| `WAVES_OWNER_TOKEN`    | 64+ random hex chars           | Preview + Production (required); Development optional |
| `WAVES_STORE`          | unset (auto: `db` on Vercel)   | —                         |

Rules:

- `DATABASE_URL` is server-only. There is no `NEXT_PUBLIC_DATABASE_URL`
  and there must never be one (`phase3-qa-integration.test.ts` enforces).
- The app selects Neon automatically on Vercel (`storeKind()`: `VERCEL=1`
  → `db`). `WAVES_STORE=file` must never be set on Vercel (ephemeral disk).
- `VERCEL_OIDC_TOKEN` / `NEON_*` are injected by the integrations; do not
  copy them anywhere.

## 3. Deploy

```sh
vercel --prod        # production → https://one.wavesco.in (after §4)
vercel               # preview deployment per push
```

Health gates after deploy:

- `GET /api/health` → `200 {status:"ok"}` (no DB dependency)
- `GET /api/readiness` → `200 {status:"ready", store:"db"}` (503 = DB unreachable)
- `node scripts/smoke-prod.mjs` with `ONE_WAVES_OWNER_TOKEN` set (13 checks)

## 4. Domain — `https://one.wavesco.in`

1. Vercel Dashboard → Project → Settings → Domains → Add `one.wavesco.in`.
2. At the DNS provider for `wavesco.in`, add the record Vercel shows
   (`CNAME one → cname.vercel-dns.com`, or the A record if apex-style).
3. Wait for DNS + automatic TLS issuance, then run the smoke script
   against `https://one.wavesco.in`.

## 5. Connect the workstation agent (production)

```powershell
node agent/pair.mjs --server https://one.wavesco.in
# enter the printed code in the phone UI (AI → CONNECTION)
node agent/src/index.mjs --server https://one.wavesco.in
```

## 6. What changed vs `deploy-cloud.md` (Phase 2A)

That doc targets Fly.io/VPS with file-backed `.waves/` and explicitly
forbids ephemeral serverless runtimes. It remains valid for VPS-style
hosts. For Vercel, this document supersedes it: durability comes from
Neon, not disk; stop/resume, rate limits, idempotency, and audit are all
shared across instances via PostgreSQL transactions and constraints.
