/**
 * Brand film video export — renders the live GSAP scene to an MP4.
 *
 * This is the same guarantee the engine already makes, turned into a file: the
 * page is the real Motion Lab, playing the real spec through the real GsapEngine
 * in a headless Chromium, recorded and encoded locally with ffmpeg. Nothing is
 * simulated and nothing is uploaded.
 *
 * Why a pre-rendered file rather than a button that renders on demand: the MCP
 * server and the render worker are dev-server middleware (`apply: "serve"`), so
 * `/__lab/export-video` does not exist on the static deployment. The film is
 * deterministic, so shipping the MP4 gives every visitor a real download.
 *
 *   node scripts/export-brand-film.mjs [--port 5177] [--scene <name>] [--fps 60]
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { planTimeline } from "../../../packages/motion/dist/index.mjs";

const labDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(labDir, "..");
const workspaceRoot = path.join(appDir, "..", "..");

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
};
const port = Number(argValue("--port", "5177")) || 5177;
const scene = argValue("--scene", "waves-brand-film-19s");

/** Authored artboards, keyed by scene. A scene's geometry belongs to its stage
 *  (GsapSceneSpec deliberately carries no width/height), so the exporter keeps
 *  the same table the artboard components use. */
const SCENES = {
  "waves-brand-film-19s": { width: 1920, height: 1080, fps: 25, artboard: ".bf-artboard" },
  "seai-launch-reel": { width: 1080, height: 1920, fps: 30, artboard: ".sr-artboard" }
};

const outputFps = Number(argValue("--fps", "60")) || 60;
const TAIL_SEC = 1.2;

function findChromium() {
  const override = process.env.MOTION_LAB_CHROMIUM?.trim();
  if (override && existsSync(override)) return override;
  const cacheRoots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "AppData", "Local", "ms-playwright")].filter(
    (value) => typeof value === "string" && value.length > 0
  );
  const candidates = [];
  for (const root of cacheRoots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium-") || entry.includes("headless_shell")) continue;
      for (const rel of ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const exe = path.join(root, entry, rel);
        if (existsSync(exe)) candidates.push({ exe, mtime: statSync(exe).mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new Error("No local Chromium found. Install Playwright browsers or set MOTION_LAB_CHROMIUM.");
  }
  return candidates[0].exe;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy() {
  try {
    return (await fetch(`http://localhost:${port}/__lab/health`)).ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await healthy()) return null;
  const viteBin = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
    cwd: appDir,
    stdio: "ignore",
    shell: false
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (await healthy()) return child;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("Vite did not become healthy in time.");
    }
    await sleep(300);
  }
}

/** Authoritative length: the spec's own plan, not a wall-clock guess. */
function filmDurationMs() {
  const live = JSON.parse(readFileSync(path.join(appDir, "public", "gsap-state.json"), "utf8"));
  if (live.name !== scene) throw new Error(`Live scene is "${live.name}", expected "${scene}". Publish it first.`);
  return planTimeline(live.spec).totalMs;
}

async function main() {
  const target = SCENES[scene];
  if (!target) throw new Error(`Unknown scene "${scene}". Known: ${Object.keys(SCENES).join(", ")}`);
  const { width: WIDTH, height: HEIGHT, artboard } = target;
  const durationMs = filmDurationMs();
  const recordSec = durationMs / 1000 + TAIL_SEC;
  console.log(`scene     ${scene}`);
  console.log(`duration  ${(durationMs / 1000).toFixed(3)}s (+${TAIL_SEC}s tail)`);
  console.log(`output    ${WIDTH}x${HEIGHT} @ ${outputFps}fps H.264`);

  const server = await ensureServer();
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), "brand-film-"));
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      recordVideo: { dir: tmp, size: { width: WIDTH, height: HEIGHT } }
    });
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`http://localhost:${port}/?capture=1`, { waitUntil: "load", timeout: 60_000 });
    // Readiness, not wall time: the film starts when the stage materializes.
    await page.waitForSelector(artboard, { timeout: 60_000 });
    const leadSec = Math.max(0, (Date.now() - started) / 1000);
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "PLAYING", null, { timeout: 30_000 });
    const title = await page.evaluate(() => document.querySelector(".gsap-head h1")?.textContent ?? null);
    if (title !== scene) throw new Error(`Page is playing "${title}", expected "${scene}".`);

    // Capture layout must fill the recording frame exactly. If the stage kept
    // its page padding or letterboxed, every frame would carry dead bars — so
    // fail here, before spending a minute on the encode.
    const fit = await page.evaluate((sel) => {
      const art = document.querySelector(sel);
      if (!art) return null;
      const r = art.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight };
    }, artboard);
    if (!fit) throw new Error(`Capture mode did not render ${artboard}.`);
    if (Math.abs(fit.w - fit.vw) > 2 || Math.abs(fit.h - fit.vh) > 2) {
      throw new Error(`Capture is ${fit.w}x${fit.h} inside a ${fit.vw}x${fit.vh} frame — expected a full-bleed stage.`);
    }
    console.log(`capture   ${fit.w}x${fit.h} full bleed`);
    await page.waitForTimeout(Math.ceil(recordSec * 1000));
    const recording = page.video();
    if (!recording) throw new Error("Video recording did not start.");
    const src = await recording.path();
    await context.close();

    const outDir = path.join(appDir, "public", "exports");
    mkdirSync(outDir, { recursive: true });
    const webmPath = path.join(tmp, "raw.webm");
    copyFileSync(src, webmPath);
    const mp4Name = `${scene}.mp4`;
    const mp4Path = path.join(outDir, mp4Name);
    execFileSync(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-ss", leadSec.toFixed(2),
        "-i", webmPath,
        "-t", (durationMs / 1000).toFixed(3),
        "-vf", `fps=${outputFps},scale=${WIDTH}:${HEIGHT}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
        "-movflags", "+faststart", "-an",
        mp4Path
      ],
      { timeout: 300_000 }
    );
    writeFileSync(
      path.join(outDir, `${scene}.json`),
      `${JSON.stringify(
        {
          ok: true,
          scene,
          file: `/exports/${mp4Name}`,
          filename: mp4Name,
          width: WIDTH,
          height: HEIGHT,
          fps: outputFps,
          codec: "h264",
          container: "mp4",
          durationMs,
          size: statSync(mp4Path).size,
          renderedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`
    );
    console.log(`saved     ${mp4Path} (${(statSync(mp4Path).size / 1_000_000).toFixed(2)} MB)`);
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (server) server.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
