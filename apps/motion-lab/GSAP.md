# GSAP Motion Track — deterministic browser animation in Motion Lab

GSAP 3.15.0 is a first-class animation engine in `@waves/motion`
(`packages/motion/src/gsap/`). The house engine, the Cosmos provider, and
all existing tools are untouched. Cosmos remains the generative
media provider; GSAP owns deterministic DOM/SVG motion:

```
WEB MOTION:       spec → GsapEngine → GSAP timeline → DOM/SVG
GENERATIVE MEDIA: prompt → NvidiaCosmosProvider → MP4 → viewer/history
Motion Lab orchestrates both (LAB / AI MOTION / GSAP views).
```

## 1. Motion specification (the AI authors this, never raw JS)

`GsapSceneSpec` — `{ version: 1, name, description?, ops[], defaults? }`.
Op types: `tween` · `stagger` · `text` (chars/words split) · `scroll`
(ScrollTrigger scrub) · `spring` (house physics as GSAP function-eases:
gentle/snappy/deliberate/signature/house or {stiffness,damping,mass}) ·
`motion-path` (SVG data or [{x,y}]) · `parallax` (speed ±1 typical) ·
`set` (initial state). Positions: seconds, `<`, `>`, `+=`, labels.

Example:

```json
{ "target": ".hero-title", "type": "text-reveal",
  "from": { "opacity": 0, "y": 40 }, "to": { "opacity": 1, "y": 0 },
  "duration": 0.8, "ease": "power3.out", "delay": 0.1 }
```

Deterministic, inspectable (`test_gsap_animation` plan), editable
(`modify_gsap_animation`), serializable (`.motion/gsap/<name>.json`).

## 2. Engine (`GsapEngine`)

- `build(spec)` → `{ playback, report }`; transport `play/pause/restart/
  reverse/kill`, `time/progress`, state `IDLE/PLAYING/PAUSED/COMPLETED`.
- Everything runs inside `gsap.context()` scoped to the mount; `dispose()`
  kills timelines + ScrollTriggers, restores split DOM, reverts context.
  A discarded-but-playing timeline can never flip state afterwards
  (regression caught by the manual OBSIDIAN run, covered by tests).
- `setInitialState`, per-op builders (`addTween/addStagger/addTextMotion/
  addScrollMotion/addSpring/addMotionPath/addParallax`) shared by UI/tests.
- Reduced motion (`auto` reads the media query): ambient + scroll ops are
  skipped and the timeline lands at its final state; usability preserved.
- Perf: validator warns on layout properties (transforms/opacity
  preferred); no rAF loops — GSAP owns timing; ScrollTriggers are
  context-owned and killed on dispose; no duplicate triggers.
- Plugin gaps degrade loudly, never crash: missing ScrollTrigger/
  MotionPath in an environment records `skipped` and continues.

## 3. MCP tools (GSAP track; MotionOp tools unchanged)

| Existing (MotionOps) | GSAP track |
|---|---|
| create_animation (+behavior/feel) | `create_gsap_animation` (spec ops, publishes, returns plan + GSAP code) |
| modify_animation | `modify_gsap_animation` (patch by op id / append) |
| create_timeline, add_stagger/spring/scroll/text | expressed as spec ops inside `create_gsap_animation` (no per-verb dupes) |
| — | `add_motion_path`, `add_parallax` (new capabilities; append or create) |
| preview/test/validate_animation | `preview/test/validate_gsap_animation` (live mirror, dry-run plan, schema checks) |

Validation (engine-pure, dependency-free): shape, unique ids, known types,
target syntax (+existence when the Lab passes its scope), finite ≥0
durations, GSAP core-ease grammar incl. params, stagger/spring/path/
parallax/scrub fields, label references, plan ordering. The MCP server and
the browser validate with the same function.

## 4. OBSIDIAN HERO (shipped, live)

Created *through* `create_gsap_animation` + `preview_gsap_animation`
(dogfooding the track). Spec: eyebrow fade → title rise 0.9s power3.out →
sub 0.6s → visual scale 0.94→1 + fade → meta stagger → 7s ambient orb
drift → restrained bg parallax + scroll frame. Verified in a real browser:
PLAYING/PAUSED/REVERSE states, capped clock, zero console errors.

Open: `pnpm dev:lab` → `http://localhost:5173/?view=gsap` (GSAP tab).

## 5. Tests

- `packages/motion/test/gsap-validate.test.ts` — schema, timing, easings,
  layout warnings, per-op fields, label refs.
- `packages/motion/test/gsap-engine.test.ts` — plan determinism, full
  transport cycle, text split/restore, spring ease shape, invalid-spec
  refusal, 10× mount/unmount leak check, reduced-motion final state.
- `packages/motion-lab-mcp/test/gsap-motion.mjs` — spec CRUD, patch
  atomicity, motion-path/parallax validation, publish mirror, plan,
  codegen. Wired into `pnpm --filter motion-lab-mcp test`.
