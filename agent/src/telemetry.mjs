// Agent telemetry for heartbeats: CPU/memory/disk load, process count,
// uptime, user, OS, tool versions, and optional browser session status.
// Zero npm dependencies. Every probe is guarded — telemetry never throws.
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const TOOLS = ['code', 'node', 'npm', 'pnpm', 'python', 'docker', 'git', 'gh'];
const TOOLS_TTL_MS = 60 * 60 * 1000;
const PROCS_TTL_MS = 30 * 1000;

let lastCpuSample = null;
let lastTools = null;
let lastToolsAt = 0;
let lastProcs = null;
let lastProcsAt = 0;

export function snapshotCpu() {
  let idle = 0;
  let total = 0;
  try {
    for (const cpu of os.cpus()) {
      const t = cpu.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
  } catch {
    return null;
  }
  return { idle, total, at: Date.now() };
}

export function getLastCpuSample() {
  return lastCpuSample;
}

function cpuPctFrom(prev, cur) {
  if (!prev || !cur) return 0;
  const dIdle = cur.idle - prev.idle;
  const dTotal = cur.total - prev.total;
  if (!Number.isFinite(dIdle) || !Number.isFinite(dTotal) || dTotal <= 0) return 0;
  const pct = 100 * (1 - dIdle / dTotal);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

function getDisk(roots) {
  const first = Array.isArray(roots) && roots.length ? roots[0] : null;
  if (typeof first !== 'string' || !first) return {};
  if (typeof fs.statfsSync !== 'function') return { diskPath: first };
  try {
    const st = fs.statfsSync(first);
    const blocks = Number(st.blocks);
    const free = Number(st.bfree ?? st.bavail);
    if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(free)) {
      return { diskPath: first };
    }
    const pct = Math.min(100, Math.max(0, Math.round(((blocks - free) / blocks) * 1000) / 10));
    return { diskPct: pct, diskPath: first };
  } catch {
    return { diskPath: first };
  }
}

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ output: '', error: String(err?.message ?? err) });
      return;
    }
    let output = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      resolve({ output, error: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (c) => { output += c.toString('utf8'); });
    child.stderr?.on('data', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output, error: String(err?.message ?? err) });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ output, error: null });
    });
  });
}

async function getProcsCount() {
  if (lastProcs !== null && Date.now() - lastProcsAt < PROCS_TTL_MS) return lastProcs;
  try {
    const r = await runCapture('tasklist', [], 5000);
    if (!r.output) return lastProcs ?? undefined;
    const count = r.output.split('\n').filter((l) => l.trim()).length;
    lastProcs = count;
    lastProcsAt = Date.now();
    return count;
  } catch {
    return lastProcs ?? undefined;
  }
}

async function detectTools() {
  if (lastTools && Date.now() - lastToolsAt < TOOLS_TTL_MS) return lastTools;
  const entries = await Promise.all(TOOLS.map(async (tool) => {
    try {
      const which = await runCapture('where.exe', [tool], 5000);
      if (!which.output.trim()) return [tool, null];
      const ver = await runCapture(tool, ['--version'], 5000);
      const first = ver.output.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
      return [tool, first ? first.slice(0, 120) : null];
    } catch {
      return [tool, null];
    }
  }));
  lastTools = Object.fromEntries(entries);
  lastToolsAt = Date.now();
  return lastTools;
}

async function getBrowserStatus() {
  // Primary workstream owns agent/src/browser/; import whichever layout exists.
  const candidates = ['../browser/session.mjs', './browser/session.mjs'];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (typeof mod.getSessionStatus === 'function') {
        const status = await mod.getSessionStatus();
        if (status && typeof status === 'object') return status;
        return undefined;
      }
      return undefined;
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined;
}

// Collect a heartbeat telemetry snapshot. `prev` is the previous CPU sample
// ({ idle, total }, see snapshotCpu()/getLastCpuSample()); when omitted the
// module-internal last sample is used so plain `collectTelemetry()` calls
// still produce a correct delta after the first sample.
export async function collectTelemetry(prev, roots) {
  const cur = snapshotCpu();
  const base = (prev && Number.isFinite(prev.idle) && Number.isFinite(prev.total)) ? prev : lastCpuSample;
  const cpuPct = cpuPctFrom(base, cur);
  if (cur) lastCpuSample = cur;

  let memPct;
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (Number.isFinite(total) && total > 0) {
      memPct = Math.min(100, Math.max(0, Math.round(((total - free) / total) * 1000) / 10));
    }
  } catch {
    // omit
  }

  const disk = getDisk(roots);
  const procs = await getProcsCount();
  let uptimeSec;
  try {
    uptimeSec = Math.floor(os.uptime());
  } catch {
    // omit
  }
  let user;
  try {
    const name = os.userInfo().username;
    if (typeof name === 'string' && name) user = name;
  } catch {
    // omit
  }
  let osStr;
  try {
    osStr = `${os.platform()} ${os.release()}`;
  } catch {
    // omit
  }
  let tools;
  try {
    tools = await detectTools();
  } catch {
    // omit
  }
  let browser;
  try {
    browser = await getBrowserStatus();
  } catch {
    browser = undefined;
  }

  const telemetry = {};
  if (typeof cpuPct === 'number') telemetry.cpuPct = cpuPct;
  if (typeof memPct === 'number') telemetry.memPct = memPct;
  if (typeof disk.diskPct === 'number') telemetry.diskPct = disk.diskPct;
  if (typeof disk.diskPath === 'string') telemetry.diskPath = disk.diskPath;
  if (typeof procs === 'number') telemetry.procs = procs;
  if (typeof uptimeSec === 'number') telemetry.uptimeSec = uptimeSec;
  if (typeof user === 'string') telemetry.user = user;
  if (typeof osStr === 'string') telemetry.os = osStr;
  if (tools && typeof tools === 'object') telemetry.tools = tools;
  if (browser !== undefined) telemetry.browser = browser;
  return telemetry;
}
