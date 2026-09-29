/**
 * Headless film export: boots its own Vite instance (so no manually running
 * dev server is needed), optionally loads a saved animation through the real
 * MCP workflow, exports via the same endpoint the Download Video button
 * uses, prints the result, and shuts down.
 *
 * Usage: node scripts/export-film.mjs [--port 5174] [--load <name>]
 *        [--orientation landscape|vertical] [--format mp4|webm] [--narration [id]]
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const labDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(labDir, "..");
const workspaceRoot = path.join(labDir, "..", "..");

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
}
function has(name) {
  return argv.includes(name);
}

const port = Number(flag("--port", "5174")) || 5174;
const orientation = flag("--orientation", "landscape") === "vertical" ? "vertical" : "landscape";
const format = flag("--format", "mp4") === "webm" ? "webm" : "mp4";
const loadName = flag("--load", null);
// --narration [id]: bare flag means latest sidecar, value pins an id.
let narration = null;
if (has("--narration")) {
  const at = argv.indexOf("--narration");
  narration = at + 1 < argv.length && !argv[at + 1].startsWith("--") ? argv[at + 1] : true;
}

const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
let child = null;
let origin = "";
let spawned = false;

async function healthy(url) {
  try {
    const response = await fetch(`${url}/__lab/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth() {
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/__lab/health`);
      if (response.ok) return origin;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("Dev server did not become healthy.");
    await sleep(1000);
  }
}

let exitCode = 0;
try {
  // Prefer an already-running dev server; boot an isolated one otherwise.
  if (await healthy(`http://localhost:${port}`)) {
    origin = `http://localhost:${port}`;
  } else {
    child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      windowsHide: true
    });
    spawned = true;
    child.unref();
    origin = await waitHealth();
  }
  if (loadName) {
    const loaded = await fetch(`${origin}/__lab/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "apply_instruction", args: { instruction: `load the ${loadName}` } })
    }).then((response) => response.json());
    if (!loaded.ok || !loaded.result?.ok) {
      throw new Error(`Load failed: ${loaded?.result?.reply ?? loaded?.error ?? "unknown"}`);
    }
    console.log(`LOADED ${loaded.result.animation} rev ${loaded.result.revision}`);
  }
  const body = { format, orientation };
  if (narration !== null) body.narration = narration;
  const exported = await fetch(`${origin}/__lab/export-video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then((response) => response.json());
  if (!exported.ok) throw new Error(`Export failed: ${exported.error ?? "unknown"}`);
  console.log(JSON.stringify({ file: exported.file, rev: exported.rev, fps: exported.fps, size: exported.size }));
} catch (error) {
  exitCode = 1;
  console.log(`EXPORT_DAEMON_FAIL — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // Only tear down servers this script booted, as a full process tree:
  // a plain kill() on Windows orphans grandchildren (esbuild service).
  if (spawned && child?.pid) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* already gone */
    }
  }
}
process.exit(exitCode);
