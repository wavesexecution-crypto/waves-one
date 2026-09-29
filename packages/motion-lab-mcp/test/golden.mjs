/**
 * Golden visual tests — narration-specific storyboards, pinned.
 *
 * For fixed narrations the planners must produce fixed visual sequences:
 * the same words always cast the same scenes, different stories never
 * collapse to one universal sequence. Op ids carry timestamps, so goldens
 * compare id-normalized output. Run: node test/golden.mjs (after build).
 */
import {
  auditSingleWriter,
  buildStory,
  crmRowsFor,
  morphSpan,
  notebookSignalFor,
  planStory,
  validateAll,
  workflowItemsFor
} from "../dist/backend.mjs";

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/** Strip volatile op ids so golden output is deterministic text. */
function normalize(ops) {
  return ops.map((op, index) => ({ ...op, id: `<op-${index}>` }));
}
function visualsOf(story) {
  return story.beats.map((beat) => beat.visualIntent).join(",");
}
function sceneKindsOf(planned) {
  return planned.ops
    .filter((op) => op.kind === "scene")
    .flatMap((op) => op.scene.elements.map((element) => element.kind))
    .join(",");
}

// ---- Morph pair goldens: ORB into each data visual. ----
const PAIRS = [
  ["Orb blooms. The CRM holds every lead.", "orb,crm"],
  ["Orb blooms. The notebook explains the context.", "orb,notebook"],
  ["Orb blooms. The workflow runs outreach.", "orb,workflow"],
  ["Orb blooms. The network finds prospects.", "orb,network"],
  ["Orb blooms. The milestones lock in.", "orb,milestones"],
  ["Orb blooms. WAVES finale.", "orb,title"]
];
for (const [transcript, expected] of PAIRS) {
  const story = buildStory(transcript, 12000);
  check(`pair casts ${expected}`, visualsOf(story) === expected, visualsOf(story));
  const planned = planStory(story.beats, "landscape");
  check(`pair ${expected} validates + audit clean`, planned.validation.ok === true && planned.overlaps.length === 0);
}

// ---- Benchmark storyboards: materially different sequences. ----
const BENCHMARKS = [
  "Your leads are everywhere. Your CRM knows some. Your inbox knows others. WAVES brings them together.",
  "Your team spends hours searching, copying, updating, and following up. WAVES turns that entire workflow into one system.",
  "One system understands the context. It finds the opportunity. It moves the work forward."
];
const sequences = BENCHMARKS.map((transcript) => {
  const story = buildStory(transcript, 20000);
  const planned = planStory(story.beats, "vertical");
  return { story, planned, visuals: visualsOf(story) };
});
for (const [index, entry] of sequences.entries()) {
  check(`benchmark ${index + 1} validates + audit clean`, entry.planned.validation.ok === true && entry.planned.overlaps.length === 0, entry.visuals);
  check(`benchmark ${index + 1} reel-composed`, entry.planned.ops[0].scene.elements.every((element) => element.layout === "reel"));
}
check(
  "benchmarks are materially different stories",
  new Set(sequences.map((entry) => entry.visuals)).size === sequences.length,
  sequences.map((entry) => entry.visuals).join(" / ")
);

// ---- Determinism: same words, same film (ids aside). ----
const rerun = planStory(buildStory(BENCHMARKS[0], 20000).beats, "vertical");
check(
  "planning is deterministic",
  JSON.stringify(normalize(rerun.ops)) === JSON.stringify(normalize(sequences[0].planned.ops))
);

// ---- Procedural scene data from narration entities. ----
const rows = crmRowsFor(["Acme", "Globex"]);
check("crm rows carry narration entities", rows[0][0] === "Acme" && rows[1][0] === "Globex" && rows[0].length === 4);
check("crm rows fall back to house defaults", crmRowsFor([])[0][0] === "Acme Corp");
check("workflow items need real entities", workflowItemsFor(["Acme"]) === null && (workflowItemsFor(["Acme", "Globex"]) ?? []).join(",") === "ACME,GLOBEX");
check("notebook signal from entities", notebookSignalFor(["Acme"]) === "Acme" && notebookSignalFor([]) === null);

// ---- Intensity pacing: stronger beats land faster. ----
const calm = morphSpan(3000, 600, 0.1);
const urgent = morphSpan(3000, 600, 0.9);
check("emphasis lands faster", urgent.enter < calm.enter, `calm=${calm.enter} urgent=${urgent.enter}`);
check("morph windows bounded", calm.duration === 3600 && urgent.duration === 3600);
check("exits wait for the next landing", morphSpan(3000, 900, 0.5, 500).exitStart > morphSpan(3000, 900, 0.5).exitStart);

// ---- Typography: title beats resolve glyphs. ----
const titled = planStory(buildStory("WAVES finale. Thank you.", 8000).beats, "landscape");
check("title beats emit text ops", titled.ops.some((op) => op.kind === "text"));
check("title film validates + audit clean", titled.validation.ok === true && titled.overlaps.length === 0);

// ---- Scene inventory of a benchmark film (consecutive repeats merge). ----
check("benchmark 1 mounts orb + crm + network", sceneKindsOf(sequences[0].planned).split(",").sort().join(",") === "crm,network,orb");

console.log(failures === 0 ? "GOLDEN_PASS" : `GOLDEN_FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
