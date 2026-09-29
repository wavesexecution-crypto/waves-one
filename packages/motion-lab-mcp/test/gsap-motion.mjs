/**
 * GSAP track tests — spec CRUD, motion-path/parallax appends, publish,
 * test/validate, codegen. Hermetic temp lab dir; validation is the engine's
 * own pure function via dist/backend.mjs. Run: node test/gsap-motion.mjs.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGsapScene,
  codeForGsapSpec,
  getGsapSpec,
  listGsapSpecs,
  modifyGsapSpec,
  publishGsapLive,
  readGsapLive,
  saveGsapSpec,
  testGsapSpec
} from "../dist/backend.mjs";

const labDir = (() => {
  const dir = join(tmpdir(), `gsap-test-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, "public"), { recursive: true });
  return dir;
})();

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const TWEEN = { id: "t1", type: "tween", target: ".hero", to: { opacity: 1 }, duration: 0.8 };

try {
  // 1. Create + persist.
  const spec = buildGsapScene({ name: "ObsIDIAN Hero", description: "Editorial hero.", ops: [TWEEN] });
  check("name normalized", spec.name === "obsidian-hero");
  const saved = saveGsapSpec(labDir, spec);
  check("saved", saved.updatedAt.length > 0);
  check("listed", listGsapSpecs(labDir).some((e) => e.name === "obsidian-hero" && e.opCount === 1));
  check("fetched", getGsapSpec(labDir, "obsidian-hero")?.spec.ops.length === 1);

  // 2. Invalid specs never persist.
  let rejected = false;
  try {
    buildGsapScene({ name: "bad", ops: [{ id: "x", type: "tween", target: "", to: { opacity: 1 } }] });
  } catch {
    rejected = true;
  }
  check("invalid rejected", rejected);
  check("no phantom file", getGsapSpec(labDir, "bad") === null);

  // 3. Modify: patch + append.
  const patched = modifyGsapSpec(labDir, "obsidian-hero", { opId: "t1", fields: { duration: 1.2 } });
  check("patched", patched.spec.ops[0].duration === 1.2);
  const appended = modifyGsapSpec(labDir, "obsidian-hero", {
    append: [{ type: "motion-path", target: ".dot", path: "M0,0 L50,50", duration: 1 }, { type: "parallax", target: ".bg", speed: 0.4 }]
  });
  check("appended", appended.spec.ops.length === 3);
  let badPatch = false;
  try {
    modifyGsapSpec(labDir, "obsidian-hero", { opId: "t1", fields: { duration: -5 } });
  } catch {
    badPatch = true;
  }
  check("bad patch rejected", badPatch);
  check("state intact after bad patch", getGsapSpec(labDir, "obsidian-hero")?.spec.ops.length === 3);
  let unknownOp = false;
  try {
    modifyGsapSpec(labDir, "obsidian-hero", { opId: "nope", fields: { duration: 1 } });
  } catch {
    unknownOp = true;
  }
  check("unknown op rejected", unknownOp);
  let unknownScene = false;
  try {
    modifyGsapSpec(labDir, "ghost", { opId: "t1", fields: {} });
  } catch {
    unknownScene = true;
  }
  check("unknown scene rejected", unknownScene);

  // 4. Motion-path / parallax field validation.
  let badPath = false;
  try {
    modifyGsapSpec(labDir, "obsidian-hero", { append: [{ type: "motion-path", target: ".d", path: "zzz" }] });
  } catch {
    badPath = true;
  }
  check("bad path rejected", badPath);
  let badSpeed = false;
  try {
    modifyGsapSpec(labDir, "obsidian-hero", { append: [{ type: "parallax", target: ".b", speed: Infinity }] });
  } catch {
    badSpeed = true;
  }
  check("bad speed rejected", badSpeed);

  // 5. Publish + live mirror.
  const live = publishGsapLive(labDir, "obsidian-hero");
  check("published", live.name === "obsidian-hero");
  const mirror = readGsapLive(labDir);
  check("mirror readable", mirror?.spec.ops.length === 3);
  let missingPublish = false;
  try {
    publishGsapLive(labDir, "ghost");
  } catch {
    missingPublish = true;
  }
  check("missing publish rejected", missingPublish);

  // 6. Test + codegen.
  const record = getGsapSpec(labDir, "obsidian-hero");
  const tested = testGsapSpec(record.spec);
  check("test ok", tested.validation.ok === true);
  check("plan totals", tested.plan.totalMs > 0 && tested.plan.tweenCount === 2 && tested.plan.scrubbedCount === 1);
  const code = codeForGsapSpec(record.spec);
  check("codegen mentions gsap + motionPath + scrollTrigger", code.includes("gsap.timeline") && code.includes("motionPath") && code.includes("yPercent"));
} finally {
  try {
    rmSync(labDir, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort */
  }
}

if (failures > 0) {
  console.log(`\nGSAP-MOTION ${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log("\nGSAP-MOTION all checks passed.");
}
