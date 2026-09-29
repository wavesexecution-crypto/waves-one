/**
 * Natural-language flow test — the complete AI loop over real stdio.
 *
 * Spawns the built MCP server and drives it the way an MCP-compatible
 * agent would after hearing a human wish:
 *
 *   Scenario A: "Make the three cards enter one after another,
 *                 with a smooth spring, 150ms apart."
 *   Scenario B: "Make this hero feel more premium. Keep the movement
 *                 subtle and have the text and cards reveal sequentially."
 *
 * Loop per scenario: inspect target → design (intent) → apply → preview →
 * inspect result → adjust → validate. Any failure exits non-zero.
 */

import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const serverBin = join(root, "packages", "motion-lab-mcp", "dist", "server.mjs");

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const child = spawn("node", [serverBin], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 100;
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        /* protocol stream must stay clean — ignore */
      }
    }
    newline = buffer.indexOf("\n");
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function textOf(response) {
  const content = response.result?.content?.[0]?.text;
  if (typeof content !== "string") throw new Error("Tool returned no text content.");
  return JSON.parse(content);
}

async function call(name, args) {
  const response = await request("tools/call", { name, arguments: args });
  if (response.error) throw new Error(`tools/call ${name}: ${response.error.message}`);
  const payload = textOf(response);
  if (payload.ok === false) throw new Error(`Tool ${name} reported error: ${payload.error}`);
  return payload;
}
async function callRaw(name, args) {
  const response = await request("tools/call", { name, arguments: args });
  if (response.error) throw new Error(`tools/call ${name}: ${response.error.message}`);
  return textOf(response);
}

function resetState() {
  return call("inspect_animation", {}).then(async (state) => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const internal = join(root, "apps", "motion-lab", ".motion", "state.json");
    const pub = join(root, "apps", "motion-lab", "public", "motion-state.json");
    mkdirSync(join(root, "apps", "motion-lab", ".motion"), { recursive: true });
    const blank = JSON.stringify({ revision: 0, updatedAt: new Date(0).toISOString(), ops: [] }, null, 2);
    writeFileSync(internal, blank);
    writeFileSync(pub, JSON.stringify({ revision: 0, updatedAt: new Date(0).toISOString(), ops: [] }, null, 2));
    return state;
  });
}

async function main() {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "flow-test", version: "0" } });
  check("handshake", init.result?.serverInfo?.name === "waves-motion-lab", init.result?.serverInfo?.name ?? "");
  notify("notifications/initialized");

  const listed = await request("tools/list", {});
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  for (const expected of ["inspect_animation", "inspect_target", "create_animation", "modify_animation", "create_timeline", "apply_preset", "add_stagger", "add_spring", "add_scroll_motion", "add_text_motion", "preview_animation", "test_animation", "validate_animation"]) {
    check(`tool ${expected}`, names.includes(expected));
  }

  await resetState();

  console.log("Scenario A: three cards, one after another, smooth spring, 150ms apart");
  const target = await call("inspect_target", { projectRoot: join(root, "apps", "motion-lab") });
  check("inspect target scans files", target.filesScanned > 0, `${target.filesScanned} files`);

  const created = await call("create_animation", {
    target: ".lab-scene-card",
    behavior: "sequential entrance",
    stagger: 150,
    feel: "smooth spring",
    scene: { elements: [{ key: "cards", kind: "cards", count: 3 }] }
  });
  check("create sequential entrance", created.ok === true && created.op.kind === "animate", `op ${created.op.id} (${created.op.kind})`);
  check("preset expanded with origin", created.op.options?.origin === "rise", `origin=${created.op.options?.origin}`);
  check("stagger carried through", created.op.options?.stagger === 150, `stagger=${created.op.options?.stagger}`);
  check("spring physics carried", created.op.options?.spring?.stiffness === 120, `k=${created.op.options?.spring?.stiffness}`);
  check("code generated", typeof created.code === "string" && created.code.includes("engine.animate"), "engine.animate snippet");
  console.log(`    intent: ${created.intent.behavior} / ${created.intent.feel}`);

  const validated = await call("validate_animation", {});
  check("validate clean", validated.ok === true, `${validated.errors.length} errors, ${validated.warnings.length} warnings`);

  const tested = await call("test_animation", {});
  check("test simulates", tested.totalDuration >= 0, `total=${tested.totalDuration}ms`);

  const adjusted = await call("modify_animation", { id: created.op.id, patch: { stagger: 200 } });
  check("adjust stagger 150→200", adjusted.op.options?.stagger === 200);
  const adjustedBack = await call("modify_animation", { id: created.op.id, patch: { stagger: 150 } });
  check("adjust stagger 200→150", adjustedBack.op.options?.stagger === 150);

  const preview = await call("preview_animation", {});
  check("preview published", preview.url === "http://localhost:5173/" && preview.revision >= 1, `rev ${preview.revision}`);

  console.log("Scenario B: premium hero, subtle, sequential text + cards");
  const before = await call("inspect_animation", {});
  check("inspect result shows ops", before.ops.length >= 2, `${before.ops.length} ops`);

  const hero = await call("create_timeline", {
    label: "premium-hero",
    items: [
      { target: "#lab-scene-hero-title", behavior: "rise", duration: 350 },
      { target: "#lab-scene-hero-sub", behavior: "fade", duration: 300 },
      { target: ".lab-scene-card", behavior: "sequential entrance", stagger: 120 }
    ],
    scene: { elements: [{ key: "hero", kind: "hero", count: 3, text: "Motion, engineered." }] }
  });
  check("create premium timeline", hero.ok === true && hero.op.kind === "timeline", `${hero.op.nodes.length} nodes`);
  check("layout computed", hero.layout.total ?? hero.layout.duration >= 0, `${JSON.stringify(hero.layout.end ?? hero.layout.total ?? hero.layout.duration)}`);
  console.log("    website code:");
  for (const line of hero.code.split("\n").slice(0, 4)) console.log(`    ${line}`);

  const heroValid = await call("validate_animation", { id: hero.op.id });
  check("timeline validates", heroValid.ok === true);
  const heroTest = await call("test_animation", { id: hero.op.id });
  check("timeline simulates", heroTest.spans.length === 1 && heroTest.totalDuration > 0, `total=${heroTest.totalDuration}ms`);

  const springed = await call("add_spring", { id: created.op.id, preset: "snappy" });
  check("add spring to cards", springed.op.options?.spring?.stiffness === 420, `k=${springed.op.options?.spring?.stiffness}`);
  const final = await call("validate_animation", {});
  check("final state validates", final.ok === true, `${final.errors.length} errors`);

  const bad = await call("apply_preset", { preset: "does-not-exist", target: ".x" }).catch((error) => ({ caught: String(error) }));
  check("unknown preset fails loudly", bad.ok === false || bad.caught !== undefined);

  console.log("Scenario C: apply_instruction (Lab surface entry point)");
  await resetState();
  const inspected = await call("inspect_animation", {});
  check("inspect lists saved library", Array.isArray(inspected.savedAnimations) && inspected.savedAnimations.some((entry) => entry.name === "premium-hero"));
  const seeded = await call("create_animation", {
    target: ".lab-scene-card",
    behavior: "sequential entrance",
    stagger: 150,
    feel: "smooth spring",
    scene: { elements: [{ key: "cards", kind: "cards", count: 3 }] }
  });
  check("seed cards animation", seeded.ok === true, `op ${seeded.op.id}`);
  const instructed = await call("apply_instruction", { instruction: "make the cards stagger 200ms and make the spring softer" });
  check("instruction understood", instructed.understood === true && instructed.action === "modified", instructed.summary);
  const after = await call("inspect_animation", {});
  const cardsOp = after.ops.find((op) => op.id === seeded.op.id);
  check("instruction changed stagger", cardsOp?.options?.stagger === 200, `stagger=${cardsOp?.options?.stagger}`);
  check("instruction softened spring", cardsOp?.options?.spring?.stiffness === 120, `k=${cardsOp?.options?.spring?.stiffness}`);
  const loaded = await call("apply_instruction", { instruction: "load the premium hero" });
  check("load canonical animation", loaded.action === "loaded" && loaded.animation === "premium-hero", loaded.summary);
  const canonical = await call("inspect_animation", {});
  check("canonical ops live", canonical.ops.map((op) => op.id).join(",") === "scene-mu7fdhpj-1,op-mu7fdhpj-2,op-mu7fdhps-3");
  const vague = await callRaw("apply_instruction", { instruction: "make it sparkle" });
  check("vague instruction answered honestly", vague.ok === false && vague.understood === false && typeof vague.reply === "string");

  console.log("Scenario G: restore_state + plan provider fields");
  const listed5 = await request("tools/list", {});
  check("restore_state discovered", (listed5.result?.tools ?? []).some((tool) => tool.name === "restore_state"));
  const prior = await call("inspect_animation", {});
  const snapshot = JSON.parse(JSON.stringify(prior.ops));
  const mutated = await call("modify_animation", { id: prior.ops.find((op) => op.kind === "animate").id, patch: { delay: 999 } });
  check("mutation applied", mutated.op.options?.delay === 999);
  const restored = await call("restore_state", { ops: snapshot, reason: "flow undo check" });
  check("restore_state republishes snapshot", restored.ok === true);
  const afterRestore = await call("inspect_animation", {});
  check("restored ops match snapshot", JSON.stringify(afterRestore.ops) === JSON.stringify(snapshot));
  const badRestore = await callRaw("restore_state", { ops: [{ id: "x", kind: "animate", target: "", properties: {} }] });
  check("invalid restore rejected", badRestore.ok === false);
  const plannedProv = await call("plan_animation", { brief: "fade in", provider: "gpt", model: "session-default" });
  check("plan records provider", plannedProv.provider === "gpt" && plannedProv.model === "session-default");
  const listed4 = await request("tools/list", {});
  check("voiceover tool discovered", (listed4.result?.tools ?? []).some((tool) => tool.name === "synthesize_voiceover"));
  const gated = await callRaw("synthesize_voiceover", { text: "Waves finds your next customer." });
  check("ungated request refused cleanly", gated.ok === false && gated.gated === true && typeof gated.hint === "string");
  const empty = await callRaw("synthesize_voiceover", { text: "" }).catch((error) => ({ caught: String(error) }));
  check("empty script rejected", empty.caught !== undefined || empty.ok === false);

  console.log("Scenario E: record_technique (provenance ledger)");
  const listed3 = await request("tools/list", {});
  check("record_technique discovered", (listed3.result?.tools ?? []).some((tool) => tool.name === "record_technique"));
  const recorded = await call("record_technique", {
    sourceKind: "repo",
    sourceRef: "mrdoob/three.js",
    license: "MIT",
    what: "Seeded dispersal timing",
    adaptedTo: "orb disperse behavior",
    compatibility: "Timing idea only; execution stays in engine stagger binding"
  });
  check("technique recorded", recorded.ok === true && typeof recorded.technique.id === "string", recorded.technique.id);
  const gpl = await callRaw("record_technique", { sourceKind: "repo", sourceRef: "x/y", license: "GPL-3.0", what: "q", adaptedTo: "q", compatibility: "q" });
  check("copyleft refused", gpl.ok === false);
  const missing = await callRaw("record_technique", { sourceKind: "docs", sourceRef: "u", license: "MIT", what: "q", adaptedTo: "q", compatibility: "q", reference: "nope" });
  check("missing manifest refused", missing.ok === false);
  const withTech = await call("inspect_animation", {});
  check("inspect surfaces ledger", Array.isArray(withTech.techniques) && withTech.techniques.length >= 1);

  console.log("Scenario D: plan_animation + publish_plan (brief pipeline)");
  const listed2 = await request("tools/list", {});
  const toolNames = (listed2.result?.tools ?? []).map((tool) => tool.name);
  check("plan tools discovered", toolNames.includes("plan_animation") && toolNames.includes("publish_plan"));
  const planned = await call("plan_animation", { brief: "orb disperses, then three cards emerge from the center", orientation: "vertical", durationMs: 8000 });
  check("plan proposes beats+ops", planned.beats.length >= 2 && planned.beats.every((b) => b.op && b.op.id), `${planned.beats.length} beats`);
  check("plan pre-validated", planned.validation.ok === true);
  check("plan not yet live", (await call("inspect_animation", {})).ops.length === 3);
  const published = await call("publish_plan", { id: planned.id });
  check("publish ships plan", published.ok === true && published.revision > 0, `rev ${published.revision}`);
  const liveAfter = await call("inspect_animation", {});
  check("planned ops live", liveAfter.ops.some((op) => String(op.id).startsWith("plan-")));
  const restored2 = await call("apply_instruction", { instruction: "load the premium hero" });
  check("restore canonical after plan", restored2.action === "loaded");

  console.log("Scenario H: transcribe_voiceover gate + detect_beats on WAV");
  const listedV = await request("tools/list", {});
  const toolNamesV = (listedV.result?.tools ?? []).map((tool) => tool.name);
  check("voice tools discovered", toolNamesV.includes("transcribe_voiceover") && toolNamesV.includes("detect_beats"));
  // Deterministic WAV fixture: 4s tone-silence-tone-silence (pure PCM, no deps).
  const rate = 16000;
  const totalSamples = rate * 4;
  const pcm = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / rate;
    const on = (t >= 0.2 && t < 1.2) || (t >= 2.0 && t < 3.0);
    pcm[i] = on ? Math.floor(Math.sin(t * 440 * Math.PI * 2) * 12000) : 0;
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length * 2, 40);
  await writeFile("D:\\waves-motion\\apps\\motion-lab\\.motion\\voiceovers\\vo-flow-fixture.wav", Buffer.concat([header, Buffer.from(pcm.buffer)]));
  await writeFile(
    "D:\\waves-motion\\apps\\motion-lab\\.motion\\voiceovers\\vo-flow-fixture.json",
    JSON.stringify({ id: "vo-flow-fixture", audio: "voiceovers/vo-flow-fixture.wav", durationMs: 4000, createdAt: new Date(0).toISOString() })
  );
  const gatedVo = await callRaw("transcribe_voiceover", { id: "vo-flow-fixture" });
  check("transcribe gated without key", gatedVo.ok === false && gatedVo.gated === true);
  const beats = await call("detect_beats", { id: "vo-flow-fixture", beats: 3 });
  check("beats detected from energy", beats.ok === true && beats.segments.length >= 2 && beats.durationMs === 4000, `${beats.segments.length} segments`);
  check("beats ordered and covering", beats.segments[0].startMs === 0 && beats.segments[beats.segments.length - 1].endMs === 4000);
  const unknownVo = await callRaw("detect_beats", { id: "vo-does-not-exist" });
  check("unknown voiceover fails loudly", unknownVo.ok === false);
  await rm("D:\\waves-motion\\apps\\motion-lab\\.motion\\voiceovers\\vo-flow-fixture.wav").catch(() => {});
  await rm("D:\\waves-motion\\apps\\motion-lab\\.motion\\voiceovers\\vo-flow-fixture.json").catch(() => {});

  console.log("Scenario I: build_story + voiceover tools");
  const story = await call("build_story", { transcript: "Waves finds your next customer. It understands what matters. Then it deploys the workflow.", durationMs: 20000 });
  check("story built with labeled beats", story.ok === true && story.story.beats.map((b) => b.label).join(",") === "CRM,NOTEBOOK,WORKFLOW");
  check("story beats carry timing", story.story.beats.every((b, i, all) => b.endMs > b.startMs && (i === 0 || b.startMs >= all[i - 1].startMs)));
  const voList = await call("voiceover_list", {});
  check("voiceover_list works", voList.ok === true && Array.isArray(voList.voiceovers));
  const voMissing = await callRaw("voiceover_get", { id: "vo-nope" }).catch((e) => ({ caught: String(e) }));
  check("unknown voiceover fails loudly", voMissing.caught !== undefined || voMissing.ok === false);

  console.log("Scenario J: plan_story + publish_revision");
  const plan = await call("plan_story", { beats: story.story.beats, orientation: "landscape" });
  check("plan_story produces valid audited ops", plan.ok === true && plan.overlaps.length === 0 && plan.ops[0]?.kind === "scene");
  const pub1 = await call("publish_revision", { ops: plan.ops, message: "flow plan" });
  check("publish_revision ships rev", pub1.ok === true && pub1.rev >= 1);
  const pub2 = await call("publish_revision", { ops: plan.ops, expectedRevision: pub1.rev, message: "flow refresh" });
  check("publish_revision with fresh expectedRev ships", pub2.ok === true && pub2.rev === pub1.rev + 1);
  const stale = await callRaw("publish_revision", { ops: plan.ops, expectedRevision: pub1.rev, message: "flow stale" });
  check("publish_revision with stale expectedRev conflicts", stale.ok === false && /conflict/i.test(stale.error ?? ""));
  const badOps = [{ id: "flow-bad", kind: "animate", target: ".x", properties: { notAProperty: 1 } }];
  const badPub = await callRaw("publish_revision", { ops: badOps, message: "flow bad" });
  check("publish_revision rejects invalid ops", badPub.ok === false);

  console.log("Scenario K: render jobs + recovery + audit");
  const renderEnq = await call("enqueue_render", { rev: pub2.rev, format: "mp4" });
  check("enqueue_render queues durable job", renderEnq.ok === true && renderEnq.duplicate === false && typeof renderEnq.jobId === "string");
  const renderDup = await call("enqueue_render", { rev: pub2.rev, format: "mp4" });
  check("enqueue_render idempotent per rev+format", renderDup.ok === true && renderDup.duplicate === true && renderDup.jobId === renderEnq.jobId);
  const noRev = await callRaw("enqueue_render", { rev: 99999 });
  check("enqueue_render fails loudly on unknown rev", noRev.ok === false);
  const ranJobs = await call("run_jobs_once", { types: ["render"], maxTicks: 5 });
  check("run_jobs_once executes render", ranJobs.ok === true && ranJobs.outcomes.some((entry) => entry.jobId === renderEnq.jobId && entry.outcome === "completed"));
  const renderStatus = await call("job_status", { jobId: renderEnq.jobId });
  const eventNames = renderStatus.events.map((entry) => entry.event);
  check("job_status shows completed render", renderStatus.ok === true && renderStatus.job.status === "COMPLETED" && renderStatus.job.result?.rev === pub2.rev);
  check("job audit has progress trail", eventNames.includes("progress") && eventNames.includes("completed"));
  const completedJobs = await call("job_list", { status: "COMPLETED", limit: 10 });
  check("job_list finds the render", completedJobs.ok === true && completedJobs.jobs.some((entry) => entry.id === renderEnq.jobId));
  const cancelDone = await callRaw("job_cancel", { jobId: renderEnq.jobId });
  check("terminal jobs cannot cancel", cancelDone.ok === false);

  console.log("Scenario L: assets + artifacts + technique index");
  const ingested = await call("ingest_asset", { kind: "data", label: "flow state fixture", path: ".motion/state.json" });
  check("ingest_asset registers existing file", ingested.ok === true && ingested.asset.meta?.size > 0 && ingested.asset.path === ".motion/state.json");
  const inlined = await call("ingest_asset", { kind: "script", label: "flow notes", text: "beat one: orb" });
  check("ingest_asset saves inline text", inlined.ok === true && String(inlined.asset.path).startsWith(".motion/assets/"));
  const noFile = await callRaw("ingest_asset", { kind: "image", label: "ghost", path: "does/not-exist.png" });
  check("ingest_asset refuses missing file", noFile.ok === false);
  const escapeAsset = await callRaw("ingest_asset", { kind: "image", label: "esc", path: "../escape.png" });
  check("ingest_asset refuses escape path", escapeAsset.ok === false);
  const bothSupplied = await callRaw("ingest_asset", { kind: "script", label: "both", path: ".motion/state.json", text: "x" });
  check("ingest_asset refuses path+text together", bothSupplied.ok === false);
  const assetRows = await call("asset_list", {});
  check("asset_list finds both", assetRows.ok === true && assetRows.assets.some((entry) => entry.id === ingested.asset.id) && assetRows.assets.some((entry) => entry.id === inlined.asset.id));
  const techRows = await call("technique_list", {});
  check("technique_list indexes the ledger", techRows.ok === true && techRows.techniques.some((entry) => entry.source_ref === "mrdoob/three.js"));
  const jobArts = await call("artifact_list", { jobId: renderEnq.jobId });
  check("artifact_list finds render output", jobArts.ok === true && jobArts.artifacts.length >= 1 && jobArts.artifacts[0].rev === pub2.rev);
  const revArts = await call("artifact_list", { rev: pub2.rev });
  check("artifact_list filters by rev", revArts.ok === true && revArts.artifacts.some((entry) => entry.job_id === renderEnq.jobId));

  console.log("Scenario M: create_from_voiceover end to end");
  const e2e = await call("create_from_voiceover", {
    transcript: "Waves finds your next customer. It understands what matters. Then it deploys the workflow.",
    durationMs: 15000,
    format: "mp4",
    message: "flow e2e"
  });
  check("e2e publishes and renders", e2e.ok === true && e2e.rev >= 1 && e2e.beats.length >= 2 && e2e.artifactId !== null);
  const e2eStatus = await call("job_status", { jobId: e2e.jobId });
  check("e2e render job completed", e2eStatus.ok === true && e2eStatus.job.status === "COMPLETED");
  const e2eArts = await call("artifact_list", { rev: e2e.rev });
  check("e2e artifact linked to rev", e2eArts.ok === true && e2eArts.artifacts.some((entry) => entry.id === e2e.artifactId));
  const e2eEmpty = await callRaw("create_from_voiceover", {});
  check("e2e refuses empty input", e2eEmpty.ok === false);
  const e2eUnknownVo = await callRaw("create_from_voiceover", { voiceoverId: "vo-nope" });
  check("e2e refuses unknown voiceover", e2eUnknownVo.ok === false);

  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));
  console.log(failures === 0 ? "FLOW PASS" : `FLOW FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.log(`FLOW FAIL — ${error instanceof Error ? error.message : String(error)}`);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  process.exit(1);
});
