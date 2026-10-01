/**
 * Publishes the Motion Lab Demo reel to the Motion Spec track.
 *
 * Runs the real store path — `buildGsapScene` → `saveGsapSpec` →
 * `publishGsapLive` — so the spec is validated and the live mirror the Lab
 * polls is written by the same code the MCP tools use. No engine bypass.
 *
 *   pnpm motion-lab-demo:publish
 */

import { resolvePaths } from "./store.js";
import { buildGsapScene, publishGsapLive, saveGsapSpec, testGsapSpec } from "./gsap-specs.js";
import { MOTION_LAB_DEMO_MS, MOTION_LAB_DEMO_SCENES, buildMotionLabDemo } from "@waves/motion";

/** Keep in sync with MOTION_LAB_DEMO_STAGE_VERSION in apps/motion-lab/src/MotionLabDemoReel.tsx. */
const MOTION_LAB_DEMO_STAGE_VERSION = 1;

const paths = resolvePaths(process.cwd());
const built = buildMotionLabDemo();
const spec = buildGsapScene({
  name: built.name,
  description: built.description,
  ops: built.ops as unknown as Array<Record<string, unknown>>
});

const record = saveGsapSpec(paths.labDir, spec);
const tested = testGsapSpec(record.spec);
const live = publishGsapLive(paths.labDir, record.name, MOTION_LAB_DEMO_STAGE_VERSION);

if (!tested.validation.ok) {
  console.error("motion-lab-demo failed validation:", tested.validation.errors);
  process.exit(1);
}
if (tested.plan.totalMs !== MOTION_LAB_DEMO_MS) {
  console.error(`motion-lab-demo planned ${tested.plan.totalMs}ms, expected ${MOTION_LAB_DEMO_MS}ms`);
  process.exit(1);
}

console.log(`saved     ${paths.labDir}/.motion/gsap/${record.name}.json`);
console.log(`published ${paths.labDir}/public/gsap-state.json`);
console.log(`name      ${record.name}`);
console.log(`ops       ${record.spec.ops.length}`);
console.log(`total     ${tested.plan.totalMs}ms (${(tested.plan.totalMs / 1000).toFixed(3)}s)`);
console.log(`scenes    ${MOTION_LAB_DEMO_SCENES.map((scene) => `${scene.label}@${scene.at}s`).join("  ")}`);
console.log(`stage     v${MOTION_LAB_DEMO_STAGE_VERSION}`);
console.log(`live      ${live.updatedAt}`);