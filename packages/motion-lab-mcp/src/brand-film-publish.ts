/**
 * Publishes the WAVES brand film to the Motion Spec track.
 *
 * Runs the real store path — `buildGsapScene` → `saveGsapSpec` →
 * `publishGsapLive` — so the spec is validated and the live mirror the Lab
 * polls is written by the same code the MCP tools use. No engine bypass.
 *
 *   pnpm brand-film:publish
 */

import { resolvePaths } from "./store.js";
import { buildGsapScene, publishGsapLive, saveGsapSpec, testGsapSpec } from "./gsap-specs.js";
import { BRAND_FILM_MS, BRAND_FILM_SCENES, buildWavesBrandFilm } from "@waves/motion";

const paths = resolvePaths(process.cwd());
// buildGsapScene assigns deterministic op ids and runs the validator; the
// engine authors the ops, so the shape is already GsapOp-compatible.
const spec = buildGsapScene({
  name: buildWavesBrandFilm().name,
  description: buildWavesBrandFilm().description,
  ops: buildWavesBrandFilm().ops as unknown as Array<Record<string, unknown>>
});

const record = saveGsapSpec(paths.labDir, spec);
const tested = testGsapSpec(record.spec);
const live = publishGsapLive(paths.labDir, record.name);

if (!tested.validation.ok) {
  console.error("brand film failed validation:", tested.validation.errors);
  process.exit(1);
}
if (tested.plan.totalMs !== BRAND_FILM_MS) {
  console.error(`brand film planned ${tested.plan.totalMs}ms, expected ${BRAND_FILM_MS}ms`);
  process.exit(1);
}

console.log(`saved    ${paths.labDir}/.motion/gsap/${record.name}.json`);
console.log(`published ${paths.labDir}/public/gsap-state.json`);
console.log(`name     ${record.name}`);
console.log(`ops      ${record.spec.ops.length}`);
console.log(`total    ${tested.plan.totalMs}ms (${(tested.plan.totalMs / 1000).toFixed(3)}s)`);
console.log(`scenes   ${BRAND_FILM_SCENES.map((scene) => `${scene.label}@${scene.at}s`).join("  ")}`);
console.log(`live     ${live.updatedAt}`);
