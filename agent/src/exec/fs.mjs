// Filesystem executor. list/read are low risk; write/mkdir/move/delete require
// an approved approvalId. All paths are confined to the sandbox workspace.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSandboxPath, redactSecrets } from '../policy.mjs';

const READ_CAP = 200 * 1024;
const SYSTEM_NAMES = new Set(['desktop.ini', 'thumbs.db']);

function needApproval(ctx, what) {
  if (!ctx.approvalId) return { ok: false, error: `${what} requires an approved approvalId` };
  return null;
}

function resolveParam(root, value, label) {
  if (typeof value !== 'string' || !value) return { error: `${label} is required` };
  const resolved = resolveSandboxPath(root, value);
  if (!resolved) return { error: `${label} escapes sandbox: ${value}` };
  return { resolved };
}

function normalizedRoot(root) {
  return path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
}

export function insideRoot(root, abs) {
  const base = normalizedRoot(root);
  const lowered = path.win32.normalize(abs).replace(/[\\/]+$/, '').toLowerCase();
  return lowered === base || lowered.startsWith(base + '\\');
}

// Resolve symlinks AND junctions (fs.realpath follows reparse points) for
// the nearest existing ancestor, then verify containment. Lexical checks
// alone cannot see links planted inside the sandbox.
export async function resolveReal(root, abs) {
  let current = path.win32.normalize(abs);
  const tail = [];
  for (;;) {
    try {
      await fs.lstat(current);
      break;
    } catch {
      const parent = path.win32.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.win32.basename(current));
      current = parent;
    }
  }
  let real;
  try {
    real = await fs.realpath(current);
  } catch {
    return null;
  }
  real = real.replace(/^\\\\\?\\/, '');
  return path.win32.join(real, ...tail);
}

// Refuse when the real location of a write target escapes the sandbox.
export async function refuseOutsideRoot(root, abs, label) {
  const real = await resolveReal(root, abs);
  if (!real || !insideRoot(root, real)) {
    return `${label} escapes the sandbox via a link or junction`;
  }
  return null;
}

async function fileInfo(abs) {
  try {
    const st = await fs.stat(abs);
    const info = { size: st.size, mtimeMs: st.mtimeMs };
    if (st.isFile() && st.size < 1024 * 1024) {
      info.sha256 = crypto.createHash('sha256').update(await fs.readFile(abs)).digest('hex');
    }
    return info;
  } catch {
    return undefined;
  }
}

function isHiddenOrSystem(abs, root) {
  const rel = path.win32.relative(root, abs);
  if (!rel || rel.startsWith('..')) return true;
  return rel.split(path.win32.sep).some(
    (seg) => seg.startsWith('.') || seg.startsWith('$') || SYSTEM_NAMES.has(seg.toLowerCase()),
  );
}

async function list(params, ctx) {
  const target = params.path ?? '.';
  const r = resolveParam(ctx.workspaceRoot, target, 'path');
  if (r.error) return { ok: false, error: r.error };
  let entries;
  try {
    entries = await fs.readdir(r.resolved, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `fs.list failed: ${err.message}` };
  }
  const output = JSON.stringify(
    entries.map((e) => ({ name: e.name, directory: e.isDirectory() })),
    null,
    2,
  );
  return { ok: true, output: redactSecrets(output) };
}

async function read(params, ctx) {
  const r = resolveParam(ctx.workspaceRoot, params.path, 'path');
  if (r.error) return { ok: false, error: r.error };
  const before = await fileInfo(r.resolved);
  let st;
  try {
    st = await fs.stat(r.resolved);
  } catch {
    return { ok: false, error: `fs.read failed: no such file` };
  }
  if (st.isDirectory()) return { ok: false, error: 'fs.read target is a directory; use fs.list' };
  let buf;
  try {
    buf = await fs.readFile(r.resolved);
  } catch (err) {
    return { ok: false, error: `fs.read failed: ${err.message}` };
  }
  let output = buf.slice(0, READ_CAP).toString('utf8');
  if (buf.length > READ_CAP) output += `\n...[truncated: file is ${buf.length} bytes, showing first ${READ_CAP}]`;
  return { ok: true, output: redactSecrets(output), before };
}

async function write(params, ctx) {
  const denied = needApproval(ctx, 'fs.write');
  if (denied) return denied;
  const r = resolveParam(ctx.workspaceRoot, params.path, 'path');
  if (r.error) return { ok: false, error: r.error };
  if (typeof params.content !== 'string') return { ok: false, error: 'fs.write requires a content string' };
  const linkRefusal = await refuseOutsideRoot(ctx.workspaceRoot, r.resolved, 'fs.write target');
  if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
  const before = await fileInfo(r.resolved);
  try {
    await fs.mkdir(path.win32.dirname(r.resolved), { recursive: true });
    await fs.writeFile(r.resolved, params.content, 'utf8');
  } catch (err) {
    return { ok: false, error: `fs.write failed: ${err.message}` };
  }
  return { ok: true, output: `Wrote ${params.content.length} chars to ${params.path}`, before, after: await fileInfo(r.resolved) };
}

async function mkdir(params, ctx) {
  const denied = needApproval(ctx, 'fs.mkdir');
  if (denied) return denied;
  const r = resolveParam(ctx.workspaceRoot, params.path, 'path');
  if (r.error) return { ok: false, error: r.error };
  const linkRefusal = await refuseOutsideRoot(ctx.workspaceRoot, r.resolved, 'fs.mkdir target');
  if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
  try {
    await fs.mkdir(r.resolved, { recursive: true });
  } catch (err) {
    return { ok: false, error: `fs.mkdir failed: ${err.message}` };
  }
  return { ok: true, output: `Created ${params.path}`, after: await fileInfo(r.resolved) };
}

async function move(params, ctx) {
  const denied = needApproval(ctx, 'fs.move');
  if (denied) return denied;
  const src = resolveParam(ctx.workspaceRoot, params.src ?? params.path, 'src');
  if (src.error) return { ok: false, error: src.error };
  const dest = resolveParam(ctx.workspaceRoot, params.dest, 'dest');
  if (dest.error) return { ok: false, error: dest.error };
  const destRefusal = await refuseOutsideRoot(ctx.workspaceRoot, dest.resolved, 'fs.move destination');
  if (destRefusal) return { ok: false, error: `Refused: ${destRefusal}` };
  const before = await fileInfo(src.resolved);
  try {
    await fs.mkdir(path.win32.dirname(dest.resolved), { recursive: true });
    await fs.rename(src.resolved, dest.resolved);
  } catch (err) {
    return { ok: false, error: `fs.move failed: ${err.message}` };
  }
  return { ok: true, output: `Moved to ${params.dest}`, before, after: await fileInfo(dest.resolved) };
}

async function remove(params, ctx) {
  const denied = needApproval(ctx, 'fs.delete');
  if (denied) return denied;
  const r = resolveParam(ctx.workspaceRoot, params.path, 'path');
  if (r.error) return { ok: false, error: r.error };
  if (r.resolved.toLowerCase() === normalizedRoot(ctx.workspaceRoot)) {
    return { ok: false, error: 'Refused: recursive delete wider than one sandbox directory' };
  }
  if (isHiddenOrSystem(r.resolved, ctx.workspaceRoot)) {
    return { ok: false, error: 'Refused: hidden/system paths cannot be deleted' };
  }
  const linkRefusal = await refuseOutsideRoot(ctx.workspaceRoot, r.resolved, 'fs.delete target');
  if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
  const before = await fileInfo(r.resolved);
  if (!before) return { ok: false, error: 'fs.delete failed: no such file or directory' };
  try {
    await fs.rm(r.resolved, { recursive: !!params.recursive, force: false });
  } catch (err) {
    return { ok: false, error: `fs.delete failed: ${err.message}` };
  }
  return { ok: true, output: `Deleted ${params.path}`, before };
}

export async function execFs(kind, params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  switch (kind) {
    case 'fs.list': return list(p, ctx);
    case 'fs.read': return read(p, ctx);
    case 'fs.write': return write(p, ctx);
    case 'fs.mkdir': return mkdir(p, ctx);
    case 'fs.move': return move(p, ctx);
    case 'fs.delete': return remove(p, ctx);
    default: return { ok: false, error: `Unknown fs kind: ${kind}` };
  }
}
