# WAVES ONE Cloud Control Plane (Phase 2A)

The control plane is already remote-capable: the agent only ever makes
authenticated **outbound** HTTPS requests (`--server https://...`), so the
workstation needs no inbound port. Going remote means hosting this Next.js
app where your phone can reach it over TLS.

## What you need

- A host with a persistent disk (the `.waves/` stores are file-backed and
  crash-safe via atomic writes; they do not survive ephemeral serverless
  filesystems — do NOT deploy to Vercel/Netlify-style ephemeral runtimes).
- TLS termination (platform-provided HTTPS).
- One strong owner token.

Suitable: Fly.io app with a volume, a small VPS (Caddy provides automatic
TLS), or any Node host with a disk. Not suitable: serverless functions,
edge runtimes, multi-instance fleets (rate limiting and stores are
single-process in this phase).

## Deploy

```sh
# Build once
npm ci
npm run build

# Run with durable state + owner gate
set WAVES_STATE_DIR=D:\waves-data\.waves
set WAVES_OWNER_TOKEN=<64+ random hex chars>
set PORT=3100
npm run start -- --port 3100
```

Minimal Dockerfile:

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
VOLUME ["/data"]
ENV WAVES_STATE_DIR=/data/.waves PORT=3100
EXPOSE 3100
CMD ["npm", "run", "start", "--", "--port", "3100", "-H", "0.0.0.0"]
```

Put TLS in front (Caddy, Fly proxy, or your load balancer). The app itself
never adds `Access-Control-Allow-Origin`, so browsers still enforce
same-origin against the API.

## Connect the workstation agent

On the Windows machine (outbound HTTPS only, no firewall changes):

```powershell
node agent/pair.mjs --server https://waves.example.com
# enter the printed code in the phone UI (AI → CONNECTION)
node agent/src/index.mjs --server https://waves.example.com
```

Pairing still requires physical terminal access to the workstation: knowing
the cloud URL is not enough to enroll a device.

## Phone access

Open `https://waves.example.com` on the phone, enter WAVES ONE, and set the
owner token once in Settings → Owner token (stored in that browser only).
Every control request carries it; without it the server answers 401 and the
UI says so. Device secrets are never involved in phone auth.

## Rotation and revocation

- Rotate a device credential from the workstation:
  `node agent/src/rotate.mjs --server https://waves.example.com`
  The old credential dies on first use of the new one — more precisely,
  immediately at rotation time.
- Revoke from the phone (device card → Revoke). The agent process exits on
  its next poll with a re-pair instruction instead of retrying forever.
- Rotate `WAVES_OWNER_TOKEN` by restarting the server with a new value and
  updating the phone's stored token.

## Limits of this phase (honest)

- Single-process stores: back up `.waves/` (it holds jobs, approvals,
  policy, audit). A Postgres migration path is planned; the store functions
  are already isolated in `src/lib/control-plane.ts` for that move.
- Rate limiting is in-memory per instance.
- Server file writes assume one writer. Do not run two control planes on
  the same `WAVES_STATE_DIR`.
