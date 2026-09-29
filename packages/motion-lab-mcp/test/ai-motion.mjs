/**
 * AI motion service tests — temp lab dir + real SQLite, stubbed providers.
 *
 * Hermetic: no network, no NVIDIA key, no ffmpeg required (the mock-provider
 * ffmpeg path is gated and asserted only when ffmpeg exists).
 * Run: pnpm --filter motion-lab-mcp test (after pnpm build).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CosmosError,
  closeDb,
  createGeneration,
  deleteGeneration,
  generateAndWait,
  getGeneration,
  importCompletedRender,
  isMp4Bytes,
  listGenerations,
  markSelected,
  motionProviderStatus,
  openDb,
  runGeneration,
  saveGenerationToLab,
  saveSourceImage,
  saveSourceMedia,
  sniffImage
} from "../dist/backend.mjs";

const labDir = (() => {
  const dir = join(tmpdir(), `aimo-test-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
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

function cannedMp4(size = 2048) {
  const bytes = Buffer.alloc(size, 0x11);
  bytes.writeUInt32BE(16, 0);
  bytes.write("ftyp", 4);
  bytes.write("isom", 8);
  return bytes;
}

function stubProvider(outcome = {}) {
  return {
    id: "stub",
    models: ["stub-model"],
    status: () => ({
      provider: "stub",
      model: "stub-model",
      displayName: "Stub",
      configured: true,
      detail: "Ready",
      endpointHost: "test",
      modes: ["text2video", "image2video"]
    }),
    generate: async () => {
      if (outcome.error) throw new CosmosError("server_error", outcome.error, "stub detail");
      const videoBytes = outcome.bytes ?? cannedMp4();
      return {
        provider: "stub",
        model: "stub-model",
        videoBytes,
        contentType: "video/mp4",
        byteLength: videoBytes.length,
        seed: 123,
        upsampledPrompt: null,
        width: 1280,
        height: 720,
        fps: 24,
        frames: 189,
        durationMs: 7875
      };
    }
  };
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const pngUrl = `data:image/png;base64,${TINY_PNG.toString("base64")}`;

try {
  const opened = await openDb(labDir);
  const db = opened.raw;

  // 1. Image sniffing.
  const sniffed = sniffImage(TINY_PNG);
  check("sniff PNG 1x1", sniffed.mime === "image/png" && sniffed.width === 1 && sniffed.height === 1);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  check("sniff JPEG", sniffImage(jpeg).mime === "image/jpeg");
  let rejected = false;
  try {
    sniffImage(Buffer.from("definitely not an image"));
  } catch {
    rejected = true;
  }
  check("reject non-image", rejected);

  // 2. Source upload.
  const source = saveSourceImage(db, labDir, "project_default", { name: "hero.png", dataUrl: pngUrl, label: "Hero" });
  const sourceFile = source.url.replace("/ai-motion/", "ai-motion/");
  check("source stored + asset", source.mime === "image/png" && existsSync(join(labDir, "public", sourceFile)), source.url);
  let badUpload = false;
  try {
    saveSourceImage(db, labDir, "project_default", { name: "x.txt", dataUrl: "data:text/plain;base64,aGk=" });
  } catch {
    badUpload = true;
  }
  check("reject non-media upload", badUpload);
  const mp4Source = saveSourceMedia(db, labDir, "project_default", {
    name: "clip.mp4",
    dataUrl: `data:video/mp4;base64,${cannedMp4(4096).toString("base64")}`
  });
  check("video source stored", mp4Source.mime === "video/mp4" && existsSync(join(labDir, "public", mp4Source.url.replace("/ai-motion/", "ai-motion/"))));

  // 3. text2video end-to-end with stub.
  const first = await generateAndWait(labDir, { mode: "text2video", prompt: "A robot walks forward.", settings: { seed: 7 } }, { db, provider: stubProvider({}) });
  check("text2video COMPLETED", first.status === "COMPLETED", first.generationId);
  check("video URL shape", first.videoUrl === `/ai-motion/${first.generationId}.mp4`);
  const stored = readFileSync(join(labDir, "public", "ai-motion", `${first.generationId}.mp4`));
  check("stored bytes are MP4 container", isMp4Bytes(stored), `${stored.length} bytes`);
  const row = getGeneration(db, first.generationId);
  check("artifact recorded", Boolean(row?.artifactId), row?.artifactId ?? "");
  check("seed echoed", row?.seed === 123);

  // 4. image2video from uploaded source.
  const second = await generateAndWait(
    labDir,
    { mode: "image2video", prompt: "Push in slowly.", sourceId: source.sourceId, settings: { seed: 3 } },
    { db, provider: stubProvider({}) }
  );
  check("image2video COMPLETED", second.status === "COMPLETED");
  check("source linked", getGeneration(db, second.generationId)?.sourceAssetId === source.sourceId);

  // 5. Provider failure -> FAILED row, safe message.
  const failed = await generateAndWait(labDir, { mode: "text2video", prompt: "Something." }, { db, provider: stubProvider({ error: "Upstream exploded." }) });
  check("failure recorded", failed.status === "FAILED" && (failed.error ?? "").includes("Upstream exploded."));
  check("no video URL on failure", failed.videoUrl === null);

  // 4b. video2video from an uploaded MP4 (stub provider).
  const v2v = await generateAndWait(
    labDir,
    { mode: "video2video", prompt: "Continue smoothly.", sourceId: mp4Source.sourceId, settings: { seed: 9 } },
    { db, provider: stubProvider({}) }
  );
  check("video2video COMPLETED", v2v.status === "COMPLETED");

  // 6. Validation before queueing.
  for (const [name, input, match] of [
    ["empty prompt", { mode: "text2video", prompt: "   ", providerId: "stub" }, /prompt/],
    ["missing source", { mode: "image2video", prompt: "x", providerId: "stub" }, /source image/],
    ["missing video", { mode: "video2video", prompt: "x", providerId: "stub" }, /source video/],
    ["bad mode", { mode: "audio2video", prompt: "x", providerId: "stub" }, /Unsupported mode/],
    ["tier frame cap", { mode: "text2video", prompt: "x", providerId: "stub", settings: { resolution: "720_16_9", numFrames: 300 } }, /197/]
  ]) {
    let threw = false;
    try {
      createGeneration(db, input);
    } catch (error) {
      threw = match.test(error instanceof Error ? error.message : String(error));
    }
    check(`reject ${name}`, threw);
  }

  // 7. Missing key -> configuration message, never a stack/secret.
  const keyJob = createGeneration(db, { mode: "text2video", prompt: "Hello.", providerId: "nvidia" });
  const keyResult = await runGeneration(db, labDir, keyJob.id, { env: {} });
  check("missing key FAILED", keyResult.status === "FAILED" && keyResult.errorCode === "missing_api_key");
  check("config guidance", (keyResult.error ?? "").includes("NVIDIA_API_KEY"));

  // 8. History: newest-first, select, save, delete.
  const listed = listGenerations(db);
  check("newest first", listed.length >= 3 && listed[0].createdAt >= listed[listed.length - 1].createdAt, `${listed.length} rows`);
  const selected = markSelected(db, first.generationId);
  check("mark selected", selected.selected === true);
  check("single selection", getGeneration(db, second.generationId)?.selected === false);
  const saved = saveGenerationToLab(db, labDir, first.generationId);
  check("save to lab", Boolean(saved.artifactId) && existsSync(join(labDir, "public", "exports", `${first.generationId}.mp4`)));
  check("delete generation", deleteGeneration(db, labDir, second.generationId) === true);
  check("row gone", getGeneration(db, second.generationId) === null);
  // Regression: Windows join() yields backslashes — containment must compare
  // normalized separators or the output file silently survives deletion.
  check("file gone", !existsSync(join(labDir, "public", "ai-motion", `${second.generationId}.mp4`)));
  {
    const re = await generateAndWait(labDir, { mode: "text2video", prompt: "Temp." }, { db, provider: stubProvider({}) });
    const p = join(labDir, "public", "ai-motion", `${re.generationId}.mp4`);
    check("output exists pre-delete", existsSync(p));
    deleteGeneration(db, labDir, re.generationId);
    check("output removed on delete", !existsSync(p));
  }
  const pending = createGeneration(db, { mode: "text2video", prompt: "Pending.", providerId: "stub" });
  let selectThrew = false;
  try {
    markSelected(db, pending.id);
  } catch {
    selectThrew = true;
  }
  check("refuse select incomplete", selectThrew);

  // 9. Status never leaks values.
  const missing = motionProviderStatus({ MOTION_PROVIDER: "cosmos" });
  const cosmosMissing = missing.providers.find((entry) => entry.provider === "nvidia");
  check("unconfigured detail", cosmosMissing?.configured === false && (cosmosMissing?.detail ?? "").includes("NVIDIA_COSMOS_API_KEY"));
  check("no leak when missing", !JSON.stringify(missing).includes("sk-"));
  const ready = motionProviderStatus({ MOTION_PROVIDER: "cosmos", NVIDIA_API_KEY: "sk-test-secret" });
  check("configured ready", ready.providers.find((entry) => entry.provider === "nvidia")?.configured === true);
  check("no leak when ready", !JSON.stringify(ready).includes("sk-test-secret"));

  // 9a. Legitimate-endpoint consumption: the REAL NvidiaCosmosProvider
  // against a local contract stub (documented schema). Proves the provider
  // needs zero architectural changes once a legitimate endpoint exists.
  {
    const { createServer } = await import("node:http");
    const seen = { method: "", url: "", auth: "", body: null };
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.auth = req.headers.authorization || "";
        try {
          seen.body = JSON.parse(raw);
        } catch {
          seen.body = null;
        }
        if (req.url === "/missing") {
          res.writeHead(404, { "Content-Type": "text/plain" }).end("404 page not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ b64_video: cannedMp4(4096).toString("base64"), seed: 42 }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const env = { MOTION_PROVIDER: "cosmos", NVIDIA_COSMOS_API_KEY: "stub-cosmos-key", NVIDIA_COSMOS_ENDPOINT: `${base}/v1/cosmos/nvidia/cosmos3-nano` };
      const done = await generateAndWait(
        labDir,
        { mode: "text2video", prompt: "Contract stub proof.", settings: { resolution: "256_16_9", numFrames: 25, numInferenceSteps: 5, seed: 42 } },
        { db, env }
      );
      check("real provider COMPLETED via override endpoint", done.status === "COMPLETED", done.generationId);
      check("documented method+path", seen.method === "POST" && seen.url === "/v1/cosmos/nvidia/cosmos3-nano", `${seen.method} ${seen.url}`);
      check("server-side key auth", seen.auth === "Bearer stub-cosmos-key");
      check(
        "documented body shape",
        seen.body?.model_mode === "text2video" && seen.body?.num_frames === 25 && seen.body?.num_inference_steps === 5 && seen.body?.seed === 42 && typeof seen.body?.negative_prompt === "string"
      );
      check("stub video stored as MP4", isMp4Bytes(readFileSync(join(labDir, "public", "ai-motion", `${done.generationId}.mp4`))));
      check("stub seed echoed", done.seed === 42);
      const badEnv = { ...env, NVIDIA_COSMOS_ENDPOINT: `${base}/missing` };
      const failed = await generateAndWait(labDir, { mode: "text2video", prompt: "Nowhere." }, { db, env: badEnv });
      check("unroutable endpoint maps to endpoint_not_found", failed.status === "FAILED" && failed.errorCode === "endpoint_not_found");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // 9b. Engine-render import (COMPLETED row + artifact, honest provider).
  {
    const { writeFileSync } = await import("node:fs");
    const fakeMp4 = join(labDir, "render.mp4");
    writeFileSync(fakeMp4, cannedMp4(4096));
    const imported = importCompletedRender(db, labDir, { filePath: fakeMp4, prompt: "WAVES letters burst.", mode: "text2video", label: "letters" });
    check("import COMPLETED", imported.status === "COMPLETED" && imported.provider === "motion-lab");
    check("import stored", existsSync(join(labDir, "public", "ai-motion", `${imported.id}.mp4`)));
    check("import artifact", Boolean(imported.artifactId));
    let badImport = false;
    try {
      const bad = join(labDir, "note.txt");
      writeFileSync(bad, "not a video");
      importCompletedRender(db, labDir, { filePath: bad, prompt: "Nope." });
    } catch {
      badImport = true;
    }
    check("reject non-mp4 import", badImport);
  }

  // 9c. Self-managed DB path (no caller db — the MCP/CLI route).
  // Regression: the connection must stay open until the run settles.
  {
    const soloDir = join(tmpdir(), `aimo-solo-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(soloDir, "public"), { recursive: true });
    try {
      const solo = await generateAndWait(soloDir, { mode: "text2video", prompt: "Solo run." }, { provider: stubProvider({}) });
      check("self-managed db COMPLETED", solo.status === "COMPLETED", solo.generationId);
      check("self-managed file stored", existsSync(join(soloDir, "public", "ai-motion", `${solo.generationId}.mp4`)));
      check("no premature-close failure", solo.errorCode !== "server_error" || !(solo.error ?? "").includes("not open"));
    } finally {
      try {
        rmSync(soloDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }

  // 10. Mock provider (ffmpeg-gated).
  let hasFfmpeg = true;
  try {
    execFileSync("ffmpeg", ["-version"], { timeout: 10_000 });
  } catch {
    hasFfmpeg = false;
  }
  if (!hasFfmpeg) {
    const mockJob = createGeneration(db, { mode: "text2video", prompt: "Hi.", providerId: "mock" });
    const mockResult = await runGeneration(db, labDir, mockJob.id, { env: { MOTION_PROVIDER: "mock" } });
    check("mock fails with ffmpeg guidance", mockResult.status === "FAILED" && (mockResult.error ?? "").includes("ffmpeg"));
  } else {
    const mockResult = await generateAndWait(
      labDir,
      { mode: "text2video", prompt: "Hi.", settings: { resolution: "256_16_9" } },
      { db, env: { MOTION_PROVIDER: "mock" } }
    );
    check("mock COMPLETED", mockResult.status === "COMPLETED" && mockResult.mock === true, mockResult.error ?? "");
    const mockBytes = readFileSync(join(labDir, "public", "ai-motion", `${mockResult.generationId}.mp4`));
    check("mock bytes are MP4", isMp4Bytes(mockBytes), `${mockBytes.length} bytes`);
  }

  closeDb(opened);
} finally {
  try {
    rmSync(labDir, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort */
  }
}

if (failures > 0) {
  console.log(`\nAI-MOTION ${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log("\nAI-MOTION all checks passed.");
}
