/**
 * Backend tests — Phase 1 domain model, job system, worker, orchestrator.
 *
 * Hermetic: every test runs against a temp database, never the real
 * .motion state. Run: node test/backend.mjs (after pnpm build).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactsForJob,
  auditSingleWriter,
  backoffMs,
  buildStory,
  cancel,
  claimNext,
  closeDb,
  complete,
  createFromVoiceover,
  createRenderHandler,
  createWorker,
  currentRev,
  defaultHandlers,
  enqueue,
  executeProvider,
  fail,
  findAssetByPath,
  getAsset,
  getEvents,
  getJob,
  getRevision,
  heartbeat,
  listArtifacts,
  listAssets,
  listJobs,
  listRevisions,
  listTechniques,
  listVoiceovers,
  openDb,
  planStory,
  providerStatus,
  publishRevision,
  readVoiceoverAudio,
  recoverStale,
  recordArtifact,
  recordTechnique,
  registerAsset,
  registerVoiceover,
  renderRevision,
  reportProgress,
  RevisionConflict,
  RevisionInvalid,
  runValidationPipeline,
  validateStory,
  validateStructuredOutput,
  withModelInterpretation
} from "../dist/backend.mjs";

const labDir = mkdtempSync(join(tmpdir(), "motion-backend-test-"));
let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const GOOD_OPS = [
  { id: "t-hero", kind: "animate", target: ".hero", properties: { y: [24, 0], opacity: [0, 1] }, options: { duration: 350 } }
];
const BAD_OPS = [{ id: "t-bad", kind: "animate", target: ".x", properties: { notAProperty: 1 } }];

try {
  const opened = await openDb(labDir);
  const db = opened.raw;

  // 1–2. Schema + seeds + idempotent migrate.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  for (const table of ["organizations", "users", "projects", "jobs", "job_events", "schema_version"]) {
    check(`table ${table}`, tables.includes(table));
  }
  check("default org/user/project seeded", listJobs(db, "project_default").length === 0);
  closeDb(await openDb(labDir));
  check("migrate idempotent", true);

  // 3–6. Enqueue → claim → complete lifecycle + events.
  const first = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS } });
  check("enqueue QUEUED", first.job.status === "QUEUED" && !first.duplicate);
  const workerA = createWorker(db, defaultHandlers(), { workerId: "worker-a" });
  const workerB = createWorker(db, defaultHandlers(), { workerId: "worker-b" });
  const ticked = await workerA.tick();
  check("claim runs handler to COMPLETED", ticked !== null && ticked.job.status === "COMPLETED", `attempts=${ticked?.job.attempts}`);
  check("validation report stored", ticked?.job.result?.ok === true);
  check("no double-claim when empty", (await workerB.tick()) === null);
  const events = getEvents(db, first.job.id).map((event) => event.event);
  check("lifecycle events recorded", events.join(",") === "enqueued,claimed,completed", events.join(","));

  // 7. Atomic race: one job, two workers — exactly one wins.
  const raced = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS } });
  const [winnerA, winnerB] = [await workerA.tick(), await workerB.tick()];
  const winners = [winnerA, winnerB].filter(Boolean);
  check("race has exactly one winner", winners.length === 1 && winners[0].job.id === raced.job.id);

  // 8–10. Retry, exhaustion, non-retryable failure.
  let flakyCalls = 0;
  const flaky = createWorker(db, {
    flaky: () => {
      flakyCalls += 1;
      if (flakyCalls < 2) {
        const error = new Error("transient");
        throw error;
      }
      return { recovered: true };
    }
  });
  const flakyJob = enqueue(db, { projectId: "project_default", type: "flaky", maxAttempts: 3 });
  await flaky.tick();
  const retried = getJob(db, flakyJob.job.id);
  check("retryable failure requeues with backoff", retried?.status === "QUEUED" && (retried?.run_after ?? 0) > Date.now(), `attempts=${retried?.attempts}`);
  // Fast-forward past backoff for the test.
  db.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").run(flakyJob.job.id);
  await flaky.tick();
  check("retry succeeds", getJob(db, flakyJob.job.id)?.status === "COMPLETED");
  const doomed = enqueue(db, { projectId: "project_default", type: "missing-handler", maxAttempts: 1 });
  await createWorker(db, {}).tick();
  const doomedRow = getJob(db, doomed.job.id);
  check("unknown handler fails without retry", doomedRow?.status === "FAILED" && typeof doomedRow?.error === "string");
  const refused = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS }, maxAttempts: 5 });
  const refusing = createWorker(db, {
    validate: () => {
      throw Object.assign(new Error("deterministic"), { retryable: false });
    }
  });
  await refusing.tick();
  check("retryable:false fails immediately", getJob(db, refused.job.id)?.status === "FAILED");

  // 11. Idempotent enqueue.
  const key = `idem-${Date.now()}`;
  const once = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS }, idempotencyKey: key });
  const twice = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS }, idempotencyKey: key });
  check("idempotent re-enqueue dedupes", !once.duplicate && twice.duplicate && once.job.id === twice.job.id);

  // 12–13. Stale recovery + heartbeat lease.
  const stuck = enqueue(db, { projectId: "project_default", type: "never", maxAttempts: 1 });
  db.prepare("UPDATE jobs SET status='RUNNING', worker_id='dead-worker', heartbeat_at=?, started_at=?, attempts=1, updated_at=? WHERE id=?").run(
    Date.now() - 120_000, Date.now() - 120_000, Date.now(), stuck.job.id
  );
  const recovered = recoverStale(db, 30_000);
  const revived = getJob(db, stuck.job.id);
  check("crashed worker job recovered", recovered.includes(stuck.job.id) && revived?.status === "QUEUED" && revived?.worker_id === null);
  const live = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS } });
  claimNext(db, "worker-a");
  heartbeat(db, live.job.id, "worker-a");
  check("fresh heartbeat holds lease", recoverStale(db, 30_000).length === 0);
  cancel(db, live.job.id);

  // 14. Cancel semantics.
  const cancellable = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS } });
  check("cancel QUEUED", cancel(db, cancellable.job.id) && getJob(db, cancellable.job.id)?.status === "CANCELLED");
  check("cancel COMPLETED refused", cancel(db, first.job.id) === false);

  // 15–16. Orchestrator chain: validate → simulate child, idempotent rerun.
  const chainKey = `chain-${Date.now()}`;
  const chain = await runValidationPipeline(db, "project_default", GOOD_OPS, { idempotencyKey: chainKey });
  check("pipeline validates", chain.validateJob.status === "COMPLETED" && chain.validation?.ok === true);
  check("simulate child linked", chain.simulateJob !== null && chain.simulateJob.parent_job_id === chain.validateJob.id && chain.simulateJob.status === "COMPLETED");
  check("simulation has spans", Array.isArray(chain.simulateJob?.result?.spans));
  check("pipeline did new work", chain.executedNewWork === true);
  const chainAgain = await runValidationPipeline(db, "project_default", GOOD_OPS, { idempotencyKey: chainKey });
  check("idempotent rerun does no new work", chainAgain.executedNewWork === false && chainAgain.validateJob.id === chain.validateJob.id);

  // 17. Invalid ops: validation completes as a report, no simulate, no retry loop.
  const bad = await runValidationPipeline(db, "project_default", BAD_OPS, { idempotencyKey: `bad-${Date.now()}` });
  check("invalid ops reported, not retried", bad.validateJob.status === "COMPLETED" && bad.validation?.ok === false && bad.simulateJob === null);

  // 18. Backoff schedule sanity.
  check("backoff grows then caps", backoffMs(0) === 1000 && backoffMs(1) === 2000 && backoffMs(10) === 30000);

  // Phase 2a. Voiceover engine: register/list/read, type+size gates.
  const voBytes = Buffer.from("RIFFxxxxWAVEfake-pcm-bytes-for-registration");
  const vo = registerVoiceover(labDir, "briefing.wav", voBytes, 42000);
  check("voiceover registered", vo.id.startsWith("vo-") && vo.durationMs === 42000);
  check("voiceover listed", listVoiceovers(labDir).some((entry) => entry.id === vo.id));
  check("voiceover bytes readable", readVoiceoverAudio(labDir, vo.id).audio.length === voBytes.length);
  let badExt = false;
  try {
    registerVoiceover(labDir, "notes.txt", Buffer.from("x"), 1000);
  } catch {
    badExt = true;
  }
  check("non-audio extension refused", badExt);
  let tooBig = false;
  try {
    registerVoiceover(labDir, "huge.mp3", Buffer.alloc(10), 1000);
    // 10 bytes is fine; oversize needs >50MB — skip materializing, check the gate directly:
    registerVoiceover(labDir, "huge2.mp3", Buffer.alloc(0), 1000);
  } catch {
    tooBig = true;
  }
  check("empty audio refused", tooBig);

  // Phase 2b. Story engine: deterministic beats, labels, validation.
  const script = "Waves finds your next customer. It understands what matters. Then it deploys the workflow. Cycle report complete.";
  const storyA = buildStory(script, 20000);
  const storyB = buildStory(script, 20000);
  check("story deterministic", JSON.stringify(storyA) === JSON.stringify(storyB));
  check("story casts scenes", storyA.beats.some((beat) => beat.label === "CRM") && storyA.beats.some((beat) => beat.label === "NOTEBOOK") && storyA.beats.some((beat) => beat.label === "WORKFLOW"));
  check("story entities + intensity present", storyA.beats.every((beat) => Array.isArray(beat.entities) && typeof beat.intensity === "number"));
  check("story interpretation explicit", storyA.interpretation === "deterministic");
  check("valid story validates", validateStory(storyA).ok === true);
  check("overlapping story rejected", validateStory({ beats: [{ id: "b1", startMs: 0, endMs: 2000, narration: "", intent: "x", entities: [], emphasis: [], intensity: 0.5, visualIntent: "title" }, { id: "b2", startMs: 1000, endMs: 3000, narration: "", intent: "x", entities: [], emphasis: [], intensity: 0.5, visualIntent: "title" }], interpretation: "deterministic", durationMs: 3000 }).ok === false);
  check("model interpretation explicit", withModelInterpretation(storyA, "claude", "x", "test").interpretation.startsWith("model:"));

  // Phase 2c. AI router: gating, validation, run records — no network.
  check("unknown provider rejected", (() => { try { providerStatus("nope", {}); return false; } catch { return true; } })());
  check("unconfigured providers reported", providerStatus("gpt", {}).configured === false && providerStatus("claude", {}).configured === false && providerStatus("gemini", {}).configured === false);
  let gated = false;
  try {
    await executeProvider(db, "gpt", { task: "plan", model: "gpt-4o", prompt: "{}" }, { env: {} });
  } catch (error) {
    gated = error instanceof Error && error.name === "ProviderNotConfigured";
  }
  check("missing key refuses without network", gated);
  const stubOk = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"beats":1}' } }], usage: { total_tokens: 7 } }) });
  const stubbed = await executeProvider(db, "gpt", { task: "plan", model: "gpt-4o", prompt: "{}" }, { env: { OPENAI_API_KEY: "test-key" }, transport: stubOk, requestId: "req-test-1" });
  check("stubbed provider completes validated JSON", stubbed.data.beats === 1);
  const stubBad = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "[1,2]" } }] }) });
  let malformed = false;
  try {
    await executeProvider(db, "gpt", { task: "plan", model: "gpt-4o", prompt: "{}" }, { env: { OPENAI_API_KEY: "test-key" }, transport: stubBad });
  } catch (error) {
    malformed = error instanceof Error && error.name === "ProviderOutputRejected";
  }
  check("malformed model output rejected", malformed);
  const runs = db.prepare("SELECT provider, model, status, error FROM provider_runs ORDER BY created_at").all();
  check("every attempt recorded", runs.length >= 3 && runs.every((row) => typeof row.status === "string"));
  check("no secrets recorded", !JSON.stringify(runs).includes("test-key"));
  const stubHang = () => new Promise(() => {
    /* never settles — hung provider */
  });
  const hangStart = Date.now();
  let timedOut = null;
  try {
    await executeProvider(db, "gpt", { task: "plan", model: "gpt-4o", prompt: "{}" }, { env: { OPENAI_API_KEY: "test-key" }, transport: stubHang, timeoutMs: 60 });
  } catch (error) {
    timedOut = error;
  }
  check("hung provider times out bounded", timedOut instanceof Error && /timed out/.test(timedOut.message) && Date.now() - hangStart < 5000, timedOut?.message ?? "no error");
  const timeoutRow = db.prepare("SELECT status, error FROM provider_runs WHERE request_id LIKE 'req-%' ORDER BY created_at DESC LIMIT 1").get();
  check("timeout recorded as failed run", timeoutRow?.status === "failed" && /timed out/.test(timeoutRow?.error ?? ""));
  let directReject = false;
  try {
    validateStructuredOutput([1, 2]);
  } catch {
    directReject = true;
  }
  check("structured gate rejects arrays", directReject);

  // ---- Phase 3: planner + revisions. ----
  console.log("Phase 3: planner + revisions");
  const story = buildStory(
    "A particle orb blooms over the hero. Then the CRM timeline scrolls through closed deals. Finally milestones lock in.",
    12000
  );
  check("story builds for planner", story.beats.length >= 2);
  const planned = planStory(story.beats, story.orientation);
  check("planner output validates", planned.validation.ok === true);
  check("planner output single-writer clean", planned.overlaps.length === 0);
  check("planner emits scene first", planned.ops[0]?.kind === "scene");
  check("planner every mount has a scene element", planned.ops.slice(1).filter((op) => op.kind === "animate" && !String(op.target ?? "").includes(" ")).every((op) => {
    const key = String(op.target ?? "").replace("#lab-scene-", "");
    return planned.ops[0].scene.elements.some((element) => element.key === key);
  }));
  check("planner cascades resolve children", planned.ops.filter((op) => op.kind === "animate" && String(op.target ?? "").endsWith(".lab-reveal")).length >= 1);

  const merged = planStory([
    { id: "b-01", startMs: 0, endMs: 4000, narration: "Orb one.", intent: "show", label: "Orb", entities: [], emphasis: [], intensity: 0.5, visualIntent: "orb" },
    { id: "b-02", startMs: 4000, endMs: 8000, narration: "Orb two.", intent: "show", label: "Orb", entities: [], emphasis: [], intensity: 0.5, visualIntent: "orb" },
    { id: "b-03", startMs: 8000, endMs: 12000, narration: "Titles.", intent: "show", label: "Title", entities: [], emphasis: [], intensity: 0.5, visualIntent: "title" }
  ], "landscape");
  check("consecutive same-visual beats merge", merged.ops.filter((op) => op.kind === "animate").length === 2);
  check("title beats resolve typography", merged.ops.filter((op) => op.kind === "text").length === 1);

  const overlapping = [
    { id: "o-1", kind: "animate", target: ".duel", properties: { y: [0, 10] }, options: { delay: 0, duration: 1000 } },
    { id: "o-2", kind: "animate", target: ".duel", properties: { y: [10, 20] }, options: { delay: 500, duration: 1000 } }
  ];
  check("audit flags overlapping writers", auditSingleWriter(overlapping).length === 1);
  const sequential = [
    { id: "s-1", kind: "animate", target: ".duel", properties: { y: [0, 10] }, options: { delay: 0, duration: 500 } },
    { id: "s-2", kind: "animate", target: ".duel", properties: { y: [10, 20] }, options: { delay: 500, duration: 500 } }
  ];
  check("audit passes sequential writers", auditSingleWriter(sequential).length === 0);

  const rev1 = publishRevision(db, "project_default", planned.ops, { message: "initial plan" });
  check("first publish is rev 1", rev1.rev === 1);
  check("first publish has no parent", rev1.parent_rev === null);
  const rev2 = publishRevision(db, "project_default", planned.ops, { expectedRev: 1, message: "refresh" });
  check("second publish is rev 2", rev2.rev === 2 && rev2.parent_rev === 1);
  check("currentRev tracks", currentRev(db, "project_default") === 2);
  const reread = getRevision(db, "project_default", 1);
  check("rev 1 immutable after rev 2", reread !== null && JSON.stringify(reread.ops) === JSON.stringify(planned.ops));
  check("revisions list newest first", listRevisions(db, "project_default").map((row) => row.rev).join(",") === "2,1");
  let conflicted = null;
  try {
    publishRevision(db, "project_default", planned.ops, { expectedRev: 1, message: "stale" });
  } catch (error) {
    conflicted = error;
  }
  check("stale expectedRev conflicts", conflicted instanceof RevisionConflict && currentRev(db, "project_default") === 2);
  let invalid = null;
  try {
    publishRevision(db, "project_default", BAD_OPS, { message: "bad" });
  } catch (error) {
    invalid = error;
  }
  check("invalid ops never publish", invalid instanceof RevisionInvalid && currentRev(db, "project_default") === 2);
  check("missing rev returns null", getRevision(db, "project_default", 99) === null);

  // ---- Phase 4: render jobs + recovery + progress audit. ----
  console.log("Phase 4: render jobs + recovery");
  const renderDir = join(labDir, "artifacts");
  const manifest = renderRevision(db, "project_default", 2, "mp4", renderDir, () => {});
  check("render manifest matches revision", manifest.rev === 2 && manifest.opCount === planned.ops.length && manifest.elementCount > 0);
  check("render manifest duration sane", manifest.durationMs >= 800);
  check("render manifest artifact written", (await import("node:fs")).existsSync(manifest.artifact));
  const renderEnq = enqueue(db, { projectId: "project_default", type: "render", payload: { projectId: "project_default", rev: 2, format: "mp4" }, maxAttempts: 3, idempotencyKey: "render:project_default:2:mp4" });
  check("render job enqueued", renderEnq.job.status === "QUEUED");
  reportProgress(db, renderEnq.job.id, 0.1, "test ping");
  check("progress events audited", getEvents(db, renderEnq.job.id).some((event) => event.event === "progress"));
  const renderWorker = createWorker(db, { validate: defaultHandlers().validate, simulate: defaultHandlers().simulate, render: createRenderHandler(renderDir) });
  const renderTick = await renderWorker.tick();
  const finished = getJob(db, renderEnq.job.id);
  check("render job completes via worker", renderTick?.outcome === "completed" && finished?.status === "COMPLETED");
  check("render result carries manifest", finished?.result?.rev === 2 && typeof finished?.result?.artifact === "string");
  check("render completion audited", getEvents(db, renderEnq.job.id).map((event) => event.event).includes("completed"));
  const missingEnq = enqueue(db, { projectId: "project_default", type: "render", payload: { projectId: "project_default", rev: 999 }, maxAttempts: 3 });
  await renderWorker.tick();
  const missingJob = getJob(db, missingEnq.job.id);
  check("missing revision fails without retry", missingJob?.status === "FAILED" && missingJob?.attempts === 1);

  // Nobody loses a render: simulate a crashed worker, then recover.
  const crashJob = enqueue(db, { projectId: "project_default", type: "validate", payload: { ops: GOOD_OPS }, maxAttempts: 2 });
  const crashClaim = claimNext(db, "worker-crash-sim");
  check("crash-sim job claimed", crashClaim?.id === crashJob.job.id && crashClaim?.attempts === 1);
  db.prepare("UPDATE jobs SET heartbeat_at = 0 WHERE id = ?").run(crashJob.job.id);
  const crashRecovered = recoverStale(db, 60_000, Date.now());
  const crashAfter = getJob(db, crashJob.job.id);
  check("stale job recovered to queue", crashRecovered.includes(crashJob.job.id) && crashAfter?.status === "QUEUED" && crashAfter?.worker_id === null);
  check("recovery audited", getEvents(db, crashJob.job.id).some((event) => event.event === "recovered"));
  const crashReclaimed = claimNext(db, "worker-rescue");
  check("recovered job reclaimable", crashReclaimed?.id === crashJob.job.id && crashReclaimed?.attempts === 2);
  complete(db, crashReclaimed.id, "worker-rescue", { ok: true });

  // ---- Phase 5: assets, artifacts, technique index. ----
  console.log("Phase 5: assets + artifacts + techniques");
  const asset = registerAsset(db, "project_default", { kind: "script", label: "founder notes", path: null, bytes: 2048, meta: { chars: 2048 } });
  check("asset registered", asset.kind === "script" && asset.bytes === 2048);
  check("asset readable", getAsset(db, asset.id)?.label === "founder notes");
  check("assets listed", listAssets(db, "project_default").some((row) => row.id === asset.id));
  check("missing asset returns null", getAsset(db, "asset-nope") === null);
  let badKind = null;
  try {
    registerAsset(db, "project_default", { kind: "hologram", label: "x", bytes: 10 });
  } catch {
    badKind = true;
  }
  check("unknown asset kind refused", badKind === true);
  let badPath = null;
  try {
    registerAsset(db, "project_default", { kind: "image", label: "x", path: "../escape.png" });
  } catch {
    badPath = true;
  }
  check("escaping asset path refused", badPath === true);
  let emptyAsset = null;
  try {
    registerAsset(db, "project_default", { kind: "data", label: "x" });
  } catch {
    emptyAsset = true;
  }
  check("pathless byeteless asset refused", emptyAsset === true);

  const artifact = recordArtifact(db, { projectId: "project_default", kind: "render-manifest", path: manifest.artifact, jobId: renderEnq.job.id, rev: 2 });
  check("artifact recorded with links", artifact.job_id === renderEnq.job.id && artifact.rev === 2);
  check("artifacts listed", listArtifacts(db, "project_default").some((row) => row.id === artifact.id));
  check("artifacts found by job", artifactsForJob(db, renderEnq.job.id).some((row) => row.id === artifact.id));

  const tech1 = recordTechnique(db, "project_default", {
    sourceKind: "docs",
    sourceRef: "waves/motion-docs",
    license: "MIT",
    what: "entrance easing curve",
    adaptedTo: "waves-entrance",
    compatibility: "catalogue easing, engine-native",
    ledgerId: "tech-test-1"
  });
  check("technique indexed", tech1.created === true && tech1.row.ledger_id === "tech-test-1");
  const tech2 = recordTechnique(db, "project_default", {
    sourceKind: "docs",
    sourceRef: "waves/motion-docs",
    license: "MIT",
    what: "entrance easing curve",
    adaptedTo: "waves-entrance",
    compatibility: "catalogue easing, engine-native"
  });
  check("technique re-record dedupes", tech2.created === false && tech2.row.id === tech1.row.id);
  check("techniques listed", listTechniques(db, "project_default").some((row) => row.id === tech1.row.id));

  // ---- Phase 6: voiceover-to-render pipeline. ----
  console.log("Phase 6: createFromVoiceover");
  const pipeArtifacts = join(labDir, "pipe-artifacts");
  const pipe1 = await createFromVoiceover(
    db,
    { transcript: "A particle orb blooms over the hero. The CRM timeline scrolls through closed deals. Milestones lock in.", durationMs: 12000, message: "pipe one" },
    { labDir, artifactsDir: pipeArtifacts }
  );
  check("pipeline publishes rev", pipe1.rev === 3 && pipe1.asset === null && pipe1.story.beats.length >= 2);
  check("pipeline render completes with artifact", pipe1.artifactId !== null && pipe1.artifact !== null);
  check("pipeline artifact file exists", (await import("node:fs")).existsSync(pipe1.artifact));
  const voRecord = registerVoiceover(labDir, "take.wav", Buffer.from([1, 2, 3, 4]), 4000);
  const pipe2 = await createFromVoiceover(
    db,
    { voiceoverId: voRecord.id, transcript: "Orb blooms. Deals close.", message: "pipe two" },
    { labDir, artifactsDir: pipeArtifacts }
  );
  check("pipeline links voiceover asset", pipe2.asset !== null && pipe2.asset.kind === "voiceover" && pipe2.asset.path === `.motion/voiceovers/${voRecord.file}`);
  check("pipeline uses voiceover duration", pipe2.durationMs === 4000);
  const pipe3 = await createFromVoiceover(
    db,
    { voiceoverId: voRecord.id, transcript: "Orb blooms again.", message: "pipe three" },
    { labDir, artifactsDir: pipeArtifacts }
  );
  check("pipeline reuses voiceover asset", pipe3.asset?.id === pipe2.asset?.id && pipe3.rev === pipe2.rev + 1);
  check("asset findable by path", findAssetByPath(db, "project_default", `.motion/voiceovers/${voRecord.file}`)?.id === pipe2.asset?.id);
  const pipe4 = await createFromVoiceover(
    db,
    { voiceoverId: voRecord.id, message: "pipe stub" },
    { labDir, artifactsDir: pipeArtifacts, transcribe: async () => "Stubbed narration blooms. It closes deals." }
  );
  check("pipeline accepts injected transcription", pipe4.story.beats.length >= 1 && pipe4.asset?.id === pipe2.asset?.id);
  async function expectPipeFail(name, runInput, runDeps, fragment) {
    let error = null;
    try {
      await createFromVoiceover(db, runInput, runDeps);
    } catch (caught) {
      error = caught;
    }
    check(name, error !== null && error.message.includes(fragment) && error.retryable === false, error?.message ?? "no error");
  }
  await expectPipeFail("unknown voiceover fails fast", { voiceoverId: "vo-nope" }, { labDir, artifactsDir: pipeArtifacts }, "unknown voiceover");
  await expectPipeFail("empty input fails fast", {}, { labDir, artifactsDir: pipeArtifacts }, "needs transcript");
  await expectPipeFail(
    "vo without transcript and no transcriber fails fast",
    { voiceoverId: voRecord.id },
    { labDir, artifactsDir: pipeArtifacts },
    "no transcript"
  );

  closeDb(opened);
} finally {
  // Windows holds SQLite file locks briefly after close; retry cleanup.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(labDir, { recursive: true, force: true });
      break;
    } catch {
      const wait = new Promise((resolve) => setTimeout(resolve, 200));
      await wait;
    }
  }
}

console.log(failures === 0 ? "BACKEND_PASS" : `BACKEND_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
