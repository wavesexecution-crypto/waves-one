// Process executor: list via tasklist (low risk); start is allowlisted and
// needs approval; stop only allows PIDs this agent started (tracked on disk).
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveSandboxPath, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';
import { agentDir } from '../secret.mjs';

const ALLOWLIST = new Set(['code', 'notepad', 'node', 'npm', 'python']);
const OUTPUT_CAP = 200 * 1024;

function procsPath() {
  return path.join(agentDir(), 'procs.json');
}

async function loadProcs() {
  try {
    const raw = await fs.readFile(procsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveProcs(list) {
  await fs.mkdir(agentDir(), { recursive: true });
  await fs.writeFile(procsPath(), JSON.stringify(list, null, 2));
}

function runCapture(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: null, output: '', startError: err.message });
      return;
    }
    let output = '';
    const append = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_CAP) output = output.slice(0, OUTPUT_CAP);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => resolve({ code: null, output, startError: err.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

function taskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => resolve());
    killer.on('close', () => resolve());
  });
}

async function list() {
  const r = await runCapture('tasklist', []);
  if (r.startError && !r.output) return { ok: false, error: `tasklist failed: ${r.startError}` };
  return { ok: true, output: redactSecrets(r.output) };
}

async function start(params, ctx) {
  if (!ctx.approvalId) return { ok: false, error: 'proc.start requires an approved approvalId' };
  const binary = params?.binary;
  if (typeof binary !== 'string' || !binary) return { ok: false, error: 'proc.start requires a binary name' };
  // Bare names only: a path-qualified binary would bypass the allowlist.
  if (/[\\/]/.test(binary)) {
    return { ok: false, error: 'Refused: binary must be a bare name, not a path' };
  }
  const base = binary.toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop();
  if (!ALLOWLIST.has(base)) {
    return { ok: false, error: `Refused: '${base}' is not an allowed binary (code, notepad, node, npm, python)` };
  }
  const args = params.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return { ok: false, error: 'proc.start args must be an array of strings' };
  }
  // Inline-eval and preload flags would hide arbitrary code behind an
  // otherwise innocent-looking approved command.
  const EVAL_FLAGS = new Set(['-e', '--eval', '-c', '-r', '--require', '--import']);
  for (const arg of args) {
    const flag = arg.split('=')[0];
    if (EVAL_FLAGS.has(flag)) {
      return { ok: false, error: `Refused: eval-style flag '${flag}' is not allowed in proc.start` };
    }
  }
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (resolveSandboxPath(ctx.workspaceRoot, arg) === null) {
      return { ok: false, error: `Refused: arg escapes sandbox: ${arg}` };
    }
  }
  let cwd = ctx.workspaceRoot;
  if (params.cwd !== undefined) {
    const resolved = typeof params.cwd === 'string' ? resolveSandboxPath(ctx.workspaceRoot, params.cwd) : null;
    if (!resolved) return { ok: false, error: 'cwd escapes sandbox' };
    const linkRefusal = await refuseOutsideRoot(ctx.workspaceRoot, resolved, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
    cwd = resolved;
  }
  let child;
  try {
    child = spawn(binary, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (err) {
    return { ok: false, error: `proc.start failed: ${err.message}` };
  }
  const tracked = await loadProcs();
  tracked.push({ pid: child.pid, binary: base, args, cwd, startedAt: new Date().toISOString(), jobId: ctx.jobId });
  await saveProcs(tracked);
  return { ok: true, output: `Started ${base} (pid ${child.pid})` };
}

async function stop(params, ctx) {
  if (!ctx.approvalId) return { ok: false, error: 'proc.stop requires an approved approvalId' };
  const pid = Number(params?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: 'proc.stop requires a numeric pid' };
  const tracked = await loadProcs();
  const index = tracked.findIndex((p) => p.pid === pid);
  if (index === -1) return { ok: false, error: `Refused: pid ${pid} was not started by this agent` };
  await taskkill(pid);
  tracked.splice(index, 1);
  await saveProcs(tracked);
  return { ok: true, output: `Stopped pid ${pid}` };
}

export async function execProc(kind, params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  switch (kind) {
    case 'proc.list': return list();
    case 'proc.start': return start(p, ctx);
    case 'proc.stop': return stop(p, ctx);
    default: return { ok: false, error: `Unknown proc kind: ${kind}` };
  }
}
