/**
 * Publishes the SEAI launch reel to the Motion Spec track.
 *
 * Same real store path as the brand film — `buildGsapScene` → `saveGsapSpec` →
 * `publishGsapLive` — so the spec is validated and the live mirror the Lab polls
 * is written by the same code the MCP tools use. No engine bypass.
 *
 *   pnpm seai-reel:publish
 */

import { resolvePaths } from "./store.js";
import { buildGsapScene, publishGsapLive, saveGsapSpec, testGsapSpec } from "./gsap-specs.js";
import { SEAI_REEL_MS, SEAI_REEL_SCENES, buildSeaiLaunchReel } from "@waves/motion";

/** Keep in sync with SEAI_REEL_STAGE_VERSION in apps/motion-lab/src/SeaiLaunchReel.tsx. */
const SEAI_REEL_STAGE_VERSION = 1;

const paths = resolvePaths(process.cwd());
const built = buildSeaiLaunchReel();
// buildGsapScene assigns deterministic op ids and runs the validator; the
// engine authors the ops, so the shape is already GsapOp-compatible.
const spec = buildGsapScene({
  name: built.name,
  description: built.description,
  ops: built.ops as unknown as Array<Record<string, unknown>>
});

const record = saveGsapSpec(paths.labDir, spec);
const tested = testGsapSpec(record.spec);
const live = publishGsapLive(paths.labDir, record.name, SEAI_REEL_STAGE_VERSION);

if (!tested.validation.ok) {
  console.error("seai reel failed validation:", tested.validation.errors);
  process.exit(1);
}
if (tested.plan.totalMs !== SEAI_REEL_MS) {
  console.error(`seai reel planned ${tested.plan.totalMs}ms, expected ${SEAI_REEL_MS}ms`);
  process.exit(1);
}

console.log(`saved     ${paths.labDir}/.motion/gsap/${record.name}.json`);
console.log(`published ${paths.labDir}/public/gsap-state.json`);
console.log(`name      ${record.name}`);
console.log(`ops       ${record.spec.ops.length}`);
console.log(`total     ${tested.plan.totalMs}ms (${(tested.plan.totalMs / 1000).toFixed(3)}s)`);
console.log(`scenes    ${SEAI_REEL_SCENES.map((scene) => `${scene.label}@${scene.at}s`).join("  ")}`);
console.log(`stage     v${SEAI_REEL_STAGE_VERSION}`);
console.log(`live      ${live.updatedAt}`);
