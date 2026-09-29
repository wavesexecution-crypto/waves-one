# AI Motion — NVIDIA Cosmos3-Nano inside Motion Lab

Dedicated workspace (`/?ai-motion=1`, or the AI MOTION tab) that generates
AI video assets with NVIDIA Cosmos3-Nano and plays them back in-app.

Pipeline (single implementation, two front doors):

```
Motion Lab UI ──→ dev-server routes (/__lab/ai-motion/*) ──┐
MCP agent ──→ generate_ai_motion / get_ai_motion_result ───┤
                                                           ▼
                                              ai-motion.ts service
                                              (jobs, storage, artifacts)
                                                           ▼
                                              MotionProvider → NvidiaCosmosProvider
                                                           ▼
                                              Cosmos3-Nano hosted API
                                                           ▼
                                              MP4 decoded server-side → public/ai-motion/*.mp4
                                                           ▼
                                              Motion Lab video player + history
```

Base64 video never crosses the browser boundary. `NVIDIA_API_KEY` never
leaves the server process (headers only, never logged/persisted/returned).

## 1. Configure

```bash
# preferred: dedicated Cosmos video key (server-side only — never
# NEXT_PUBLIC_, never client code). Obtain at build.nvidia.com (Get API
# Key); keys start with nvapi-; needs the Public API Endpoints role and
# available credits — see §10.
NVIDIA_COSMOS_API_KEY=

# shared fallback, also used by prompt enhancement.
NVIDIA_API_KEY=

# optional
MOTION_PROVIDER=cosmos        # cosmos (default) | mock
NVIDIA_COSMOS_ENDPOINT=https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano
NVIDIA_COSMOS_TIMEOUT_MS=600000   # default 10 min; trial generations take minutes
```

`GET /__lab/ai-motion/status` and `inspect_ai_motion_generation` expose a
`cosmosConfig` COSMOS_STATUS diagnostic: configured endpoint + host, auth
mode (`cosmos-key` | `shared-key` | `missing`), readiness, and the
actionable next step for the current state. Key *presence* only — never
values.

Copy `.env.example` at the repo root. Start the dev server **with the
variables set** (Vite routes + MCP bridge both read `process.env`):

```bash
pnpm dev:lab
# open http://localhost:5173/?ai-motion=1
```

Without any key, the model selector shows
`○ NVIDIA Cosmos3-Nano — No Cosmos API key (set NVIDIA_COSMOS_API_KEY)`
and generations fail fast with setup guidance. For UI work without
spending generations:

```bash
MOTION_PROVIDER=mock pnpm dev:lab
```

The mock synthesizes a genuinely playable MP4 locally (ffmpeg `zoompan`
from your source, `testsrc2` for text-to-video), labeled `mock` everywhere.

## 2. Cosmos3-Nano hosted contract (implemented verbatim)

Source: the model card's documented hosted API. The provider transmits
exactly these fields — nothing added, nothing renamed:

```
POST https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano
Authorization: Bearer $NVIDIA_API_KEY

text2video:  { model_mode: "text2video",
               prompt, resolution, num_frames,
               num_inference_steps, fps, seed }
image2video: { model_mode: "image2video", input_reference, prompt, ... }
video2video: { model_mode: "video2video", input_reference, prompt, ... }
```

| field | notes |
|---|---|
| `model_mode` | `text2video` \| `image2video` \| `video2video` |
| `prompt` | max 20000 chars; required |
| `input_reference` | data URI / base64 of the source image (image2video) or MP4 (video2video) |
| `resolution` | e.g. `480_16_9`; tier keys `256`/`480`/`720` × `_16_9`/`_1_1`/`_9_16`/`_4_3`/`_3_4` |
| `num_frames` | default 25 |
| `num_inference_steps` | default 35 |
| `fps` | default 24 |
| `seed` | int ≥ 0; default random per request |

Response: `{ "b64_video": "<base64 mp4>" }`, decoded and ftyp-verified
server-side, stored under `public/ai-motion/`, returned to the browser as
an asset URL. `negative_prompt` is accepted by the UI and kept in history
but NOT transmitted (absent from the documented hosted field list).

## 3. Playground capture — the working request (2026-09-29, automated browser)

The working Playground request was captured via DevTools network capture
(secrets redacted — captcha token and cookies never persisted):

```
POST https://buildapi.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/cosmos3-nano
→ HTTP 200, application/json, ~5.4s
Request : Content-Type application/json, Accept application/json+zip,
          Origin/Referer build.nvidia.com, nv-captcha-token <REDACTED>,
          session cookies <REDACTED>. NO Authorization header, NO API key.
Body    : {"resolution":"720","num_frames":1,"model_mode":"text2image",
           "prompt":"...","negative_prompt":""}
Response: {"b64_image":"<192884 chars → 144661-byte JPEG, magic ffd8>"}
```

Byte comparison vs `NvidiaCosmosProvider`: the body schema MATCHES
(model_mode, prompt, negative_prompt, resolution, num_frames; optional
seed/guidance_scale/num_inference_steps/fps/flow_shift per the registry
OpenAPI at `api.ngc.nvidia.com/v2/endpoints/qc69jvmznzxy/cosmos3-nano/spec`,
function `d09cd49d-…`, inference path `/v1/infer`). The provider was
aligned to this exact schema (tier caps 256→397/480→297/720→197, any
integer, bare tiers valid, seed/null, guidance 1–7, flow_shift).

Model-card API quickstart (captured verbatim from the live card 2026-09-29):

```
curl --fail-with-body -sS -D headers.txt \
    "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -d '{ "model_mode": "text2video",
          "prompt": "A robotic arm picks up a component on a workbench",
          "resolution": "480_16_9", "num_frames": 25,
          "num_inference_steps": 35, "fps": 24, "seed": 42 }'
```

A byte-identical replay (card's exact prompt + `Accept` header + official
`nvapi-` key) was executed server-side:

```
→ HTTP 404 Not Found, 19-byte plain-text "404 page not found", instant.
  No nv-request-id, no JSON problem detail — an edge/gateway default page,
  not an API router. Auth was never evaluated (a bad key would 401).
```

Card URL vs actually-routed URLs:

| Invocation | Result |
|---|---|
| Card: `POST ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano` + Bearer key (exact replay) | 404 gateway page (GET too — no route) |
| Playground: `POST buildapi.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/cosmos3-nano` + captcha JWT | 200 + media |
| Predict route + Bearer API key | 401 (wrong credential type) |
| NVCF direct + key | 404 not-entitled |

Status: **COSMOS_ENDPOINT_MISMATCH** — the documented key URL has no
deployed route behind it; the only live route is session-authenticated.
The provider default stays on the documented URL (the sole key-auth URL
NVIDIA documents); `NVIDIA_COSMOS_ENDPOINT` consumes a legitimate route
the moment one exists, with zero other changes.

Re-test 2026-09-30 with the current environment (shared `nvapi-` key, no
override, exact documented text2video body via the unmodified
`NvidiaCosmosProvider`): identical instant `404 / 19-byte gateway page`.
`OPTIONS` on the URL → 404 as well. No new credential material is present
(no `NVIDIA_COSMOS_API_KEY`, no `.env`, no endpoint override), so there is
nothing new for the provider to consume; image2video/video2video were not
re-attempted because routing is path-identical (GET 404s prove the gateway
never reads the body). The failed probe row was removed; history holds
only the shipped letters piece.

Re-test 2026-09-30 with a fresh dedicated `nvapi-` key supplied directly
(consumed as `NVIDIA_COSMOS_API_KEY`, verified `authMode: cosmos-key`,
session-only, never persisted): identical instant `404 / 19-byte gateway
page`. Not 401 (key never evaluated), not 403 (no entitlement check ran).
The documented URL has no deployed route for any key tested. The key was
cleared from the session immediately after the run; it appears in no file,
log, row, or response.

The ONLY delta is auth: the Playground authenticates with a short-lived
hcaptcha passenger JWT + bot-manager cookies (anonymous trial). Key-based
attempts against the predict route fail:

```
POST …/v2/predict/models/qc69jvmznzxy/cosmos3-nano + Bearer <API key>
→ HTTP 401, "Jwt is not in the form of Header.Payload.Signature…"
```

And the documented key route answers nothing anywhere:

```
POST https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano (all 3 modes)
→ HTTP 404, body (19 bytes, plain text): "404 page not found"
GET same URL → identical 404 (no route, not a method/body issue).
Same bodies on integrate.api.nvidia.com (/v1/cosmos/…, /v1/genai/…) → same 404s.
NVCF direct (api.nvcf.nvidia.com) → 404 "Not found in account" (no entitlement).
```

Exact limitation (per instruction, stated plainly): the working route
requires browser-session authentication (captcha JWT + cookies) that
cannot safely be reproduced server-side — those credentials are
short-lived, single-session, and copying them into the app is forbidden.
An API key is the wrong credential type for it (401), the documented key
endpoint has no route (404), and this account has no NVCF entitlement for
the function (404). Unblock paths: (a) an API key entitled for the
cosmos3-nano NVCF function or its hosted route, (b) a self-hosted Cosmos3
NIM via `NVIDIA_COSMOS_ENDPOINT` (identical schema), (c) NVIDIA publishing
a key-authenticated route. The provider needs zero other changes when any
of these lands — set the endpoint, generate.

`test/cosmos-live.mjs` (manual, key-gated, never CI) replays the
documented bodies per mode and verifies `b64_video` → MP4.

## 4. Separation of capabilities

- **Video generation** → NVIDIA Cosmos3-Nano (§2–§3). Nothing else.
- **Prompt enhancement** → `meta/llama-3.2-11b-vision-instruct`, live on
  this key (§7). Prompt intelligence only — never produces video.

## 5. Storage

- Sources: `public/ai-motion/sources/*` + `assets` row (kind `image`).
- Outputs: `public/ai-motion/<generationId>.mp4` + `artifacts` row
  (kind `ai-motion-video`, linked via `meta.generationId`).
- Jobs/history: `motion_generations` table (schema ensured idempotently
  by the service; no migration bump needed).
- "Save to Motion Lab": copies to `public/exports/<id>.mp4` + `ai-motion-saved`
  artifact. "Use This": single-selection flag.
- Generated media is gitignored (`public/ai-motion/`, `.motion/ai-motion/`).

## 6. MCP tools (same backend as the UI)

- `generate_ai_motion({ mode, prompt, settings, sourceAssetId?, provider?, model? })`
- `inspect_ai_motion_generation()` — provider status, contract, enhancement status, no secrets
- `get_ai_motion_result({ generationId | list, action?, uploadSource?, importRender? })` —
  read / delete / use / save / upload-source / list / **import** (ingest a
  rendered MP4 as a COMPLETED generation: `{ filePath, prompt, mode?, label? }`)
- `enhance_motion_prompt({ prompt, mode?, sourceAssetId? })` — live NVIDIA
  vision enhancement; returns text, never overwrites

Engine renders (e.g. Motion Lab exports) enter AI Motion history via
`importCompletedRender` — provider recorded honestly as `motion-lab` /
`@waves/motion`, never as NVIDIA output.

## 7. Prompt enhancement (live NVIDIA, verified 2026-09-29)

The ✦ Enhance Prompt button (and `enhance_motion_prompt`) calls
`meta/llama-3.2-11b-vision-instruct` server-side with your draft prompt —
plus the source image when one is attached, which the model actually sees.
The suggestion appears in an Apply/Dismiss box; your prompt is never
overwritten without the explicit Apply click. Two real calls verified
end-to-end (HTTP route + MCP stdio), ~175–205 completion tokens each.

## 8. Letters video (shipped 2026-09-29)

`WAVES` float-up (stagger) → full 360° rotation (center-out) → outward
burst + fade, 1920×1080 60fps H.264 (~4.7s), rendered by the Motion Lab
engine and exported through the existing headless-Chromium pipeline
(rev 10), ingested as an AI Motion generation
(`public/ai-motion/aimo-mumawk69-1efd70e5.mp4`, marked selected).
Open `/?ai-motion=1` → GENERATION HISTORY → Reopen to watch it.

## 9. Tests

- `packages/motion-lab-mcp/src/cosmos.test.ts` (vitest, stubbed
  transport): contract validation, body shape, response parsing, HTTP→code
  mapping, timeout incl. the NaN-default regression, key-leak guards.
- `packages/motion-lab-mcp/src/nvidia-live.test.ts` (vitest, stubbed):
  enhancement payload shape (system direction + vision data URI), HTTP
  mapping, empty-output rejection, no-leak assertions.
- `packages/motion-lab-mcp/test/ai-motion.mjs` (node): service lifecycle
  with stub providers, missing-key/malformed paths, history ops, mock
  render (ffmpeg-gated), engine-render import, delete-removes-file
  regression, **legitimate-endpoint proof** (real `NvidiaCosmosProvider`
  against a local contract stub: documented method+path+body+key auth →
  COMPLETED MP4; unroutable endpoint → `endpoint_not_found`),
  no-leak assertions.
- Full suites still green: `pnpm test` (vitest), `pnpm --filter
  motion-lab-mcp test` (flow/backend/golden/ai-motion), `pnpm build`.
- E2E verified against the dev server: upload → generate → MP4 fetch
  (`video/mp4`, `ftyp` magic) → history → use/save/delete → error paths,
  plus MCP stdio round-trips. Live Cosmos attempts documented in §3.

## 10. Legitimate production-access paths (researched 2026-09-30)

- **API catalog trial**: signup grants 1000 credits (+4000 with business
  email / 90-day AI Enterprise license). Keys from build.nvidia.com start
  with `nvapi-`. Credits exhausted → HTTP 402 (not our case).
- **Entitlement/granting**: the NGC org owner assigns the **Public API
  Endpoints** role; the personal key must include the service. Extra
  credits via profile → Request More. Granting requires org-owner or
  profile actions — it cannot be done from this codebase.
- **Self-host (works with zero code changes via `NVIDIA_COSMOS_ENDPOINT`)**:
  Cosmos3-Nano Generator is 16B, BF16-tested, Linux-only, NVIDIA
  Ampere/Hopper/Blackwell. Official routes: Generator NIM
  (`nvcr.io/nim/nvidia/cosmos3-generator`, single-GPU capable, needs
  NGC_API_KEY + `docker login nvcr.io`), vLLM-Omni
  (`vllm serve nvidia/Cosmos3-Nano --omni`, needs gated HF repos +
  Cosmos-1.0-Guardrail), or TensorRT-LLM cookbooks. NIM support matrix:
  combined VRAM >100GB, minimum single-GPU 48GB; tens of GiB disk.
  This Windows dev machine has no qualifying GPU — self-host here is not
  viable; use a Linux GPU host (L40S/A100/H100 class) or cloud GPU rental.
  The NIM serves `POST /v1/infer` with the same schema family, so pointing
  the endpoint at it lights up real generation unmodified.
- **Playground route is intentionally browser-session-only**: anonymous
  trial authenticates via short-lived hcaptcha passenger JWT + bot-manager
  cookies; API keys are rejected (401) and the function is unentitled for
  this account (404). No bypass was or will be attempted — this is an
  external NVIDIA limitation, documented in §3 with the full capture.
