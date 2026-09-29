import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "playwright-core";
import { readState, resolvePaths } from "../../packages/motion-lab-mcp/src/store.js";
import { aiMotionBridge } from "./vite.ai-motion.js";
import { testOps } from "../../packages/motion-lab-mcp/src/validate.js";
import type { MotionOp } from "../../packages/motion-lab-mcp/src/ops.js";

/** Saved-animation names for export filenames — plain JSON plumbing, no engine logic. */
function savedNameForOps(labDir: string, ops: MotionOp[]): string {
  try {
    const dir = path.join(labDir, ".motion", "animations");
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { name?: unknown; ops?: Array<{ id?: unknown }> };
        const ids = Array.isArray(parsed.ops) ? parsed.ops.map((op) => op.id) : [];
        if (ids.length > 0 && ids.every((id) => ops.some((op) => op.id === id)) && typeof parsed.name === "string") {
          return parsed.name;
        }
      } catch {
        /* skip unreadable records */
      }
    }
  } catch {
    /* no library yet */
  }
  return "motion-lab";
}


const labRoot = path.dirname(fileURLToPath(import.meta.url));
const motionSrc = path.join(labRoot, "../../packages/motion/src");
const workspaceRoot = path.join(labRoot, "../..");
const mcpServerBin = path.join(workspaceRoot, "packages", "motion-lab-mcp", "dist", "server.mjs");

/**
 * Dumb stdio transport to the real MCP server (dev only).
 *
 * POST /__lab/mcp { tool, args } spawns the built server binary, performs
 * the MCP handshake plus one tools/call, and returns the tool payload.
 * No intelligence lives here — parsing, validation and state all stay in
 * the MCP server. Production builds exclude this middleware entirely.
 */
function callMcpServer(tool: string, args: Record<string, unknown>, timeoutMs = 25000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpServerBin], { cwd: workspaceRoot, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP server timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const answer = out
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } })
          .find((message) => message.id === 2);
        if (!answer) throw new Error("MCP server returned no answer.");
        if (answer.error) throw new Error(answer.error.message ?? "MCP call failed.");
        const content = (answer.result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
        resolve(content !== undefined ? (JSON.parse(content) as unknown) : null);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lab-bridge", version: "0" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    child.stdin.end();
  });
}

const EXPORT_WIDTH = 1920;
const EXPORT_HEIGHT = 1080;
const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;
const EXPORT_FPS = 25; // Playwright recordVideo rate — deterministic.
let exportRunning = false;

/** Locate a local Chromium without downloading anything. */
function findChromium(): string {
  const override = process.env.MOTION_LAB_CHROMIUM?.trim();
  if (override && existsSync(override)) return override;
  const cacheRoots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "AppData", "Local", "ms-playwright")].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const binaries = [path.join("chrome-win64", "chrome.exe"), path.join("chrome-linux", "chrome"), path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")];
  const candidates: Array<{ exe: string; mtime: number }> = [];
  for (const root of cacheRoots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("chromium-") || entry.includes("headless_shell")) continue;
      for (const binary of binaries) {
        const exe = path.join(root, entry, binary);
        if (existsSync(exe)) {
          let mtime = 0;
          try {
            mtime = statSync(exe).mtimeMs;
          } catch {
            /* ignore */
          }
          candidates.push({ exe, mtime });
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new Error("No local Chromium found. Install Playwright browsers or set MOTION_LAB_CHROMIUM to a Chrome executable.");
  }
  return candidates[0].exe;
}

/**
 * Record the currently published animation in a fresh headless Chromium:
 * fresh load (initial state) → real engine playback → settled hold → WebM.
 * Duration adapts to the ops via the engine's own deterministic simulation.
 */
/** Resolve a narration MP3 for the current animation (sidecar-gated). */
function findNarration(labDir: string, animation: string, request: unknown): string | null {
  if (request !== true && typeof request !== "string") return null;
  const dir = path.join(labDir, ".motion", "voiceovers");
  const pick = (id: string): string | null => {
    for (const ext of ["mp3", "wav", "m4a", "aac"]) {
      const audio = path.join(dir, `${id}.${ext}`);
      const meta = path.join(dir, `${id}.json`);
      if (existsSync(audio) && existsSync(meta)) return audio;
    }
    return null;
  };
  if (typeof request === "string" && request.length > 0) {
    const direct = pick(request.replace(/\.(mp3|wav|m4a|aac)$/, ""));
    if (!direct) throw new Error(`Narration "${request}" has no voiceover sidecar. Synthesize one first.`);
    return direct;
  }
  let best: { createdAt: string; audio: string } | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    try {
      const sidecar = JSON.parse(readFileSync(path.join(dir, entry), "utf8")) as {
        id?: unknown;
        animation?: unknown;
        createdAt?: unknown;
      };
      if (typeof sidecar.id !== "string") continue;
      if (sidecar.animation && sidecar.animation !== animation) continue;
      const audio = pick(sidecar.id);
      if (!audio) continue;
      const createdAt = typeof sidecar.createdAt === "string" ? sidecar.createdAt : "";
      if (!best || createdAt > best.createdAt) best = { createdAt, audio };
    } catch {
      /* skip unreadable sidecars */
    }
  }
  if (!best) throw new Error("No narration sidecar found for this animation. Synthesize one first.");
  return best.audio;
}

async function exportVideo(origin: string, format: string, orientation: string, narration: unknown): Promise<Record<string, unknown>> {
  if (exportRunning) throw new Error("An export is already running — wait for it to finish.");
  exportRunning = true;
  let browser: Browser | null = null;
  try {
    const paths = resolvePaths(workspaceRoot);
    const state = readState(paths);
    if (state.ops.length === 0) throw new Error("Nothing to export — the Lab has no animation ops.");
    const animName = savedNameForOps(paths.labDir, state.ops);
    const vertical = orientation === "vertical";
    const width = vertical ? REEL_WIDTH : EXPORT_WIDTH;
    const height = vertical ? REEL_HEIGHT : EXPORT_HEIGHT;
    const baseSlug = animName.toLowerCase().replace(/[\s_]+/g, "-");
    const slug = vertical && !baseSlug.includes("-reel") ? `${baseSlug}-reel` : baseSlug;
    const plan = testOps(state.ops);
    const recordMs = 600 + Math.max(plan.totalDuration, 800) + 900;
    const webmName = `${slug}-rev-${state.revision}.webm`;
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "motion-lab-export-"));
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        recordVideo: { dir: tmpDir, size: { width, height } }
      });
      const page = await context.newPage();
      const tRecordStart = Date.now();
      await page.goto(`${origin}/?export=1`, { waitUntil: "load", timeout: 60000 });
      // Readiness, not wall time: the film clock starts when the stage
      // materializes, so cold dev transforms never shift or white-pad the film.
      await page.waitForSelector("#lab-stage > *", { timeout: 60000 });
      const readyOffsetSec = Math.max(0, (Date.now() - tRecordStart) / 1000);
      await page.waitForTimeout(recordMs);
      const recording = page.video();
      if (!recording) throw new Error("Video recording did not start.");
      const srcPath = await recording.path();
      await context.close();
      const outDir = path.join(paths.labDir, "public", "exports");
      mkdirSync(outDir, { recursive: true });
      const webmPath = path.join(outDir, webmName);
      copyFileSync(srcPath, webmPath);
      // MP4 is the universal deliverable (VLC / WMP / browsers): H.264,
      // 60fps container via frame duplication, exact film length when the
      // plan runs past 20s. All local, ffmpeg only — never uploaded.
      const wantMp4 = format !== "webm";
      let file = `/exports/${webmName}`;
      let filename = webmName;
      let codec = "vp8";
      let container: string = "webm";
      let fps = EXPORT_FPS;
      let narrationFile: string | null = null;
      if (wantMp4) {
        filename = `${slug}-rev-${state.revision}.mp4`;
        const mp4Path = path.join(outDir, filename);
        // Cut the loading lead so second 0 is the film's first frame; films
        // past 20s land on exactly 20.00s, shorter pieces keep total + tail.
        const keepLen = plan.totalDuration > 20000 ? 20 : Math.max(0.5, Math.round(((recordMs - readyOffsetSec * 1000) / 1000) * 100) / 100);
        const narrationAudio = findNarration(paths.labDir, animName, narration);
        if (narrationAudio) narrationFile = path.basename(narrationAudio);
        const audioArgs = narrationAudio
          ? ["-i", narrationAudio, "-af", "apad", "-c:a", "aac", "-b:a", "128k"]
          : ["-an"];
        execFileSync(
          "ffmpeg",
          ["-y", "-v", "error", "-ss", String(Math.round(readyOffsetSec * 100) / 100), "-i", webmPath, ...audioArgs, "-t", String(keepLen), "-vf", `fps=60,scale=${width}:${height}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast", "-movflags", "+faststart", mp4Path],
          { timeout: 180000 }
        );
        file = `/exports/${filename}`;
        codec = "h264";
        container = "mp4";
        fps = 60;
      }
      const { size } = statSync(path.join(outDir, filename));
      return {
        ok: true,
        file,
        filename,
        rev: state.revision,
        animation: animName,
        orientation: vertical ? "vertical" : "landscape",
        width,
        height,
        fps,
        codec,
        container,
        plannedMs: recordMs,
        size,
        ...(narrationFile ? { narration: narrationFile } : {})
      };
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  } finally {
    exportRunning = false;
    try {
      await browser?.close();
    } catch {
      /* ignore shutdown races */
    }
  }
}

function labBridge(): Plugin {
  return {
    name: "motion-lab-bridge",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__lab/health", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      // Reference ingestion: stores the original bytes plus a manifest that
      // documents license + consent before anything may reference the asset.
      // Dev-only transport; interpretation happens agent-side via MCP tools.
      server.middlewares.use("/__lab/reference", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "POST only." }));
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 12_000_000) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}") as { name?: unknown; dataUrl?: unknown; note?: unknown };
            if (typeof parsed.name !== "string" || typeof parsed.dataUrl !== "string") {
              throw new Error("Need { name, dataUrl }.");
            }
            const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(parsed.dataUrl);
            if (!match) throw new Error("dataUrl must be a data: URL.");
            const safe = parsed.name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "reference";
            const id = `ref-${Date.now().toString(36)}`;
            const dir = path.join(workspaceRoot, "apps", "motion-lab", ".motion", "references", id);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              path.join(dir, safe),
              Buffer.from(match[2], parsed.dataUrl.includes(";base64,") ? "base64" : "utf8")
            );
            const manifest = {
              id,
              kind: "upload",
              source: "user-provided local file",
              file: safe,
              mime: match[1] || "application/octet-stream",
              license: "unknown — confirm terms before adapting",
              consent: "provided directly by the operator for this session",
              note: typeof parsed.note === "string" ? parsed.note : "",
              createdAt: new Date().toISOString()
            };
            writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, id, file: safe }));
          } catch (error: unknown) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });
      // Voiceover upload: audio bytes plus a sidecar the MCP voice tools read.
      // Dev-only transport; transcription stays key-gated server-side.
      server.middlewares.use("/__lab/voiceover", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "POST only." }));
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 60_000_000) req.destroy();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}") as { name?: unknown; dataUrl?: unknown; durationMs?: unknown };
            if (typeof parsed.name !== "string" || typeof parsed.dataUrl !== "string") {
              throw new Error("Need { name, dataUrl }.");
            }
            const ext = parsed.name.split(".").pop()?.toLowerCase() ?? "";
            if (!["mp3", "wav", "m4a", "aac"].includes(ext)) {
              throw new Error("Voiceover must be MP3, WAV, M4A, or AAC.");
            }
            const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(parsed.dataUrl);
            if (!match) throw new Error("dataUrl must be a data: URL.");
            const audio = Buffer.from(match[2], parsed.dataUrl.includes(";base64,") ? "base64" : "utf8");
            if (audio.length === 0 || audio.length > 50_000_000) {
              throw new Error("Voiceover must be non-empty and under 50MB.");
            }
            const id = `vo-${Date.now().toString(36)}`;
            const dir = path.join(workspaceRoot, "apps", "motion-lab", ".motion", "voiceovers");
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, `${id}.${ext}`), audio);
            const durationMs = typeof parsed.durationMs === "number" && parsed.durationMs > 0 ? Math.round(parsed.durationMs) : 0;
            const sidecar = { id, file: `${id}.${ext}`, audio: `voiceovers/${id}.${ext}`, durationMs, mime: match[1] || "audio/mpeg", createdAt: new Date().toISOString() };
            writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(sidecar, null, 2));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, id, file: `${id}.${ext}`, durationMs }));
          } catch (error: unknown) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });
      // Same-origin voiceover playback for preview sync (dev only).
      server.middlewares.use("/__lab/voiceovers/", (req, res) => {
        try {
          const id = String(req.url ?? "").split("/").pop()?.split("?")[0] ?? "";
          if (!/^[A-Za-z0-9_-]+\.(mp3|wav|m4a|aac)$/.test(id)) throw new Error("Unknown voiceover.");
          const file = path.join(workspaceRoot, "apps", "motion-lab", ".motion", "voiceovers", id);
          const audio = readFileSync(file);
          const type = id.endsWith(".wav") ? "audio/wav" : id.endsWith(".m4a") ? "audio/mp4" : id.endsWith(".aac") ? "audio/aac" : "audio/mpeg";
          res.setHeader("Content-Type", type);
          res.end(audio);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
      server.middlewares.use("/__lab/export-video", (req, res) => {        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "POST only." }));
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 64_000) req.destroy();
        });
        req.on("end", () => {
          (async () => {
            let format = "mp4";
            let orientation = "landscape";
            let narration: unknown = null;
            try {
              const parsed = JSON.parse(body || "{}") as { format?: unknown; orientation?: unknown; narration?: unknown };
              if (typeof parsed.format === "string") format = parsed.format;
              if (parsed.orientation === "vertical") orientation = "vertical";
              if (parsed.narration !== undefined) narration = parsed.narration;
            } catch {
              /* defaults */
            }
            const origin = `http://${req.headers.host ?? "localhost:5173"}`;
            const meta = await exportVideo(origin, format, orientation, narration);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(meta));
          })().catch((error: unknown) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          });
        });
      });
      server.middlewares.use("/__lab/mcp", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "POST only." }));
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (body.length > 256_000) req.destroy();
        });
        req.on("end", () => {
          (async () => {
            const parsed = JSON.parse(body) as { tool?: unknown; args?: unknown };
            if (typeof parsed.tool !== "string" || parsed.tool.length === 0) throw new Error("Need { tool, args }.");
            const args = parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {};
            const result = await callMcpServer(parsed.tool, args);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, result }));
          })().catch((error: unknown) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          });
        });
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), labBridge(), aiMotionBridge(workspaceRoot)],
  resolve: {
    alias: {
      "@waves/motion/presets": path.join(motionSrc, "presets/index.ts"),
      "@waves/motion/scroll": path.join(motionSrc, "scroll/index.ts"),
      "@waves/motion/timeline": path.join(motionSrc, "timeline/index.ts"),
      "@waves/motion/tokens": path.join(motionSrc, "core/tokens.ts"),
      "@waves/motion/spring": path.join(motionSrc, "spring/index.ts"),
      "@waves/motion/types": path.join(motionSrc, "types/index.ts"),
      "@lab/ops": path.join(labRoot, "../../packages/motion-lab-mcp/src/ops.ts"),
      "@waves/motion": path.join(motionSrc, "index.ts")
    }
  },
  server: {
    port: 5173
  },
  preview: {
    port: 5176
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
