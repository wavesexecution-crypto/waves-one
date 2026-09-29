/**
 * LIVE Cosmos3-Nano provider integration test — manual only, never in CI.
 *
 * Calls the documented hosted endpoint directly with the documented request
 * schema and verifies b64_video decodes to an MP4. Requires NVIDIA_API_KEY
 * and spends real generations: run explicitly, one mode at a time.
 *
 *   node test/cosmos-live.mjs text    # text2video (exact documented body)
 *   node test/cosmos-live.mjs image   # image2video (input_reference)
 *   node test/cosmos-live.mjs video   # video2video (input_reference, video)
 *
 * Prints the exact HTTP status + response shape (b64 truncated to length).
 * Exits non-zero unless b64_video is present and decodes to an MP4.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENDPOINT = process.env.NVIDIA_COSMOS_ENDPOINT?.trim() || "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano";
const API_KEY = (process.env.NVIDIA_API_KEY ?? "").trim();
if (!API_KEY) {
  console.log("LIVE SKIP: NVIDIA_API_KEY not set.");
  process.exit(2);
}

const mode = process.argv[2] || "text";
const outDir = join(tmpdir(), "cosmos-live");
mkdirSync(outDir, { recursive: true });

function bodyFor() {
  if (mode === "image") {
    const png = readFileSync(join(outDir, "..", "cosmos-live-src.png"));
    return {
      model_mode: "image2video",
      input_reference: `data:image/png;base64,${png.toString("base64")}`,
      prompt: "Slow cinematic camera push toward the subject, subtle parallax, realistic reflections, premium technology commercial aesthetic.",
      resolution: "480_16_9",
      num_frames: 25,
      num_inference_steps: 35,
      fps: 24,
      seed: 42
    };
  }
  if (mode === "video") {
    const mp4 = readFileSync(join(outDir, "..", "cosmos-live-src.mp4"));
    return {
      model_mode: "video2video",
      input_reference: `data:video/mp4;base64,${mp4.toString("base64")}`,
      prompt: "Continue the motion smoothly, preserve geometry, cinematic restraint.",
      resolution: "480_16_9",
      num_frames: 25,
      num_inference_steps: 35,
      fps: 24,
      seed: 42
    };
  }
  return {
    model_mode: "text2video",
    prompt: "A premium black and silver futuristic technology object floating in a dark studio, slow cinematic camera movement, realistic reflections, subtle atmospheric particles",
    resolution: "480_16_9",
    num_frames: 25,
    num_inference_steps: 35,
    fps: 24,
    seed: 42
  };
}

const started = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 600_000);
let response;
try {
  response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(bodyFor()),
    signal: controller.signal
  });
} finally {
  clearTimeout(timer);
}
console.log("ENDPOINT:", ENDPOINT);
console.log("HTTP:", response.status, response.statusText);
const text = await response.text();
console.log("BODY_BYTES:", text.length);
let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  console.log("NON_JSON_BODY:", text.slice(0, 1000));
  process.exit(1);
}
const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
console.log("KEYS:", JSON.stringify(keys));
if (typeof payload?.error === "string") console.log("ERROR_FIELD:", payload.error.slice(0, 500));
const b64 = payload?.b64_video;
if (typeof b64 !== "string" || b64.length === 0) {
  console.log("NO_B64_VIDEO. FULL_BODY:", text.slice(0, 2000));
  process.exit(1);
}
console.log("B64_LEN:", b64.length);
const bytes = Buffer.from(b64, "base64");
console.log("DECODED_BYTES:", bytes.length);
const isMp4 = bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
console.log("MP4_FTYP:", isMp4);
if (!isMp4) {
  console.log("HEAD_HEX:", bytes.subarray(0, 32).toString("hex"));
  process.exit(1);
}
const out = join(outDir, `cosmos3-${mode}-${Date.now().toString(36)}.mp4`);
writeFileSync(out, bytes);
console.log("SAVED:", out, `(${Math.round((Date.now() - started) / 1000)}s)`);
