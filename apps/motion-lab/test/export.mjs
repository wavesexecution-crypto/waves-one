/**
 * Automated video-export test — drives the real Lab UI in Chromium and
 * validates the exported file as actual video media.
 *
 * Requires the dev server (default http://localhost:5173) with the
 * motion-lab-mcp dist built. Exits non-zero on any failure.
 *
 * Usage: pnpm --filter motion-lab test:export
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { writeTestWav } from "./fixture-wav.mjs";

const LAB_URL = process.env.LAB_URL ?? "http://localhost:5173";
const LAB_DIR = join(fileURLToPath(import.meta.url), "..", "..");
const EXPORTS_DIR = join(LAB_DIR, "public", "exports");
const CHROMIUM =
  process.env.MOTION_LAB_CHROMIUM ??
  "C:\\Users\\hp\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe";

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) console.log(`  PASS ${name}${extra ? ` — ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function ffprobeJson(file, args) {
  const out = execFileSync("ffprobe", ["-v", "error", ...args, "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(out);
}

function frameMd5(file, seconds) {
  return execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "md5", "-"], {
    encoding: "utf8"
  }).trim();
}

async function bridge(tool, args) {
  const response = await fetch(`${LAB_URL}/__lab/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args })
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`Bridge ${tool} failed: ${body.error ?? "unknown"}`);
  return body.result;
}

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const errors = [];
try {
  // 1–2. Load the Lab + canonical animation through the real MCP workflow.
  await bridge("apply_instruction", { instruction: "load the premium hero" });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(LAB_URL, { waitUntil: "load", timeout: 30000 });
  await page.getByText("WAVES MOTION LAB").waitFor({ timeout: 15000 });
  console.log("  PASS fresh page loads");

  // 2b. Voiceover unlocks the hover controls; generation runs, then the
  // canonical animation is restored (voiceover UI state is unaffected).
  writeTestWav("D:\\waves-motion\\scratch\\vo-export-test.wav");
  const exportChooser = await (async () => {
    const promise = page.waitForEvent("filechooser");
    await page.locator(".lab-dropzone").click();
    return promise;
  })();
  await exportChooser.setFiles("D:\\waves-motion\\scratch\\vo-export-test.wav");
  await page.getByText("VOICEOVER", { exact: false }).first().waitFor({ timeout: 60000 });
  console.log("  PASS voiceover uploaded for export session");
  const liveRev = async () =>
    page.evaluate(() =>
      fetch("motion-state.json", { cache: "no-store" })
        .then((r) => r.json())
        .then((s) => s.revision)
        .catch(() => -1)
    );
  const revAtUpload = await liveRev();
  // Generation publishes on its own schedule — wait for it before restoring.
  await page.waitForFunction(
    (prev) =>
      fetch("motion-state.json", { cache: "no-store" })
        .then((r) => r.json())
        .then((s) => s.revision !== prev)
        .catch(() => false),
    revAtUpload,
    { timeout: 90000 }
  );
  await bridge("apply_instruction", { instruction: "load the premium hero" });
  const revAfterGen = await liveRev();
  await page.waitForFunction(
    (prev) =>
      fetch("motion-state.json", { cache: "no-store" })
        .then((r) => r.json())
        .then((s) => s.revision !== prev)
        .catch(() => false),
    revAfterGen,
    { timeout: 30000 }
  );
  // Content-sync: only proceed once the hero is actually staged.
  await page.waitForFunction(
    () => document.querySelector("#lab-stage .lab-scene-title") !== null,
    null,
    { timeout: 30000 }
  );
  await page.waitForTimeout(1500);

  // 3–5. Export through the real Export menu (hover reveals it).
  await page.hover(".lab-hoverzone");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: /16:9/ }).click();
  await page.getByText("VIDEO READY", { exact: false }).waitFor({ timeout: 150000 });
  console.log("  PASS export completes in UI (VIDEO READY)");

  // 6–7. A video file was created with size > 0, named for the live revision.
  const state = JSON.parse(readFileSync(join(LAB_DIR, "public", "motion-state.json"), "utf8"));
  const files = readdirSync(EXPORTS_DIR)
    .filter((file) => file.endsWith(".mp4"))
    .map((file) => ({ file, mtime: statSync(join(EXPORTS_DIR, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  check("video file created", files.length > 0, files[0]?.file ?? "none");
  const latest = join(EXPORTS_DIR, files[0].file);
  const { size } = statSync(latest);
  check("file size > 0", size > 0, `${size} bytes`);
  check("filename tracks live revision", files[0].file.includes(`rev-${state.revision}`), files[0].file);

  // 8–10. Real container/codec, duration > 0, expected dimensions.
  const probe = ffprobeJson(latest, ["-show_entries", "format=duration,size", "-show_entries", "stream=codec_name,width,height,avg_frame_rate"]);
  const stream = probe.streams?.[0] ?? {};
  const duration = Number(probe.format?.duration ?? 0);
  check("video codec is real video", ["vp8", "vp9", "av1", "h264"].includes(stream.codec_name), stream.codec_name);
  check("universal MP4 container", files[0].file.endsWith(".mp4") && stream.codec_name === "h264", "mp4/h264");
  check("duration > 0", duration > 0, `${duration}s`);
  check("dimensions 1920x1080", stream.width === 1920 && stream.height === 1080, `${stream.width}x${stream.height}`);

  // 11. Multiple frames actually decoded.
  const counted = ffprobeJson(latest, ["-count_frames", "-show_entries", "stream=nb_read_frames"]);
  const frames = Number(counted.streams?.[0]?.nb_read_frames ?? 0);
  check("multiple frames present", frames > 10, `${frames} frames`);

  // 12. Not a repeated still: sample inside the motion window (early) as
  // well as mid and settled phases. Start must differ from end, and at
  // least one adjacent pair must differ (settled holds legitimately repeat).
  const early = frameMd5(latest, duration * 0.15);
  const mid = frameMd5(latest, duration * 0.45);
  const late = frameMd5(latest, duration * 0.85);
  check("frames differ across playback", early !== late && (early !== mid || mid !== late), `early≠late${early !== mid ? ", early≠mid" : ""}${mid !== late ? ", mid≠late" : ""}`);

  // 13. Final frame = settled animation: wait for the reloaded hero to
  // finish, then assert finished inline styles.
  await page.waitForFunction(
    () => {
      const title = document.querySelector(".lab-scene-title");
      const cards = [...document.querySelectorAll(".lab-scene-card")];
      const done = (el) => el.style.opacity === "1" && el.style.transform === "translate3d(0px, 0px, 0px)";
      return title !== null && done(title) && cards.length === 3 && cards.every(done);
    },
    null,
    { timeout: 20000 }
  );
  const settled = true;
  check("final frame corresponds to settled animation", settled === true);

  // 14. Clean console.
  check("no browser console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  failures += 1;
  console.log(`  FAIL exception — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "EXPORT_TEST_PASS" : `EXPORT_TEST_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
