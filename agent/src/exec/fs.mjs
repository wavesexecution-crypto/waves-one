// Filesystem executor. list/read/hash/search/meta are low risk;
// write/mkdir/move/copy/rename/delete require an approved approvalId.
// All paths are confined to the configured sandbox roots.
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveAcrossRoots, redactSecrets } from '../policy.mjs';

const READ_CAP = 200 * 1024;
const SEARCH_OUTPUT_CAP = 200 * 1024;
const SEARCH_MAX_FILES = 2000;
const SEARCH_MAX_DEPTH = 6;
const SEARCH_CONTENT_CAP = 512 * 1024;
const SYSTEM_NAMES = new Set(['desktop.ini', 'thumbs.db']);

function needApproval(ctx, what) {
  if (!ctx.approvalId) return { ok: false, error: `${what} requires an approved approvalId` };
  return null;
}

function getRoots(ctx) {
  if (Array.isArray(ctx.roots) && ctx.roots.length) return ctx.roots;
  return [ctx.workspaceRoot];
}

function resolveParam(ctx, value, label, pinnedRoot) {
  if (typeof value !== 'string' || !value) return { error: `${label} is required` };
  const hit = resolveAcrossRoots(getRoots(ctx), value, pinnedRoot);
  if (!hit) return { error: `${label} escapes sandbox: ${value}` };
  return { resolved: hit.path, root: hit.root };
}

function pinnedOf(params) {
  return params?.root !== undefined ? params.root : undefined;
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
  // Alternate data streams are refused segment-wise here too, so this layer
  // stays sound even for callers that skip the lexical check.
  const segments = path.win32.normalize(abs).split(path.win32.sep);
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].includes(':')) {
      return `${label} refuses alternate data streams`;
    }
  }
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

function hashStream(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}

async function list(params, ctx) {
  const target = params.path ?? '.';
  const r = resolveParam(ctx, target, 'path', pinnedOf(params));
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
  const r = resolveParam(ctx, params.path, 'path', pinnedOf(params));
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
  const r = resolveParam(ctx, params.path, 'path', pinnedOf(params));
  if (r.error) return { ok: false, error: r.error };
  if (typeof params.content !== 'string') return { ok: false, error: 'fs.write requires a content string' };
  const linkRefusal = await refuseOutsideRoot(r.root, r.resolved, 'fs.write target');
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
  const r = resolveParam(ctx, params.path, 'path', pinnedOf(params));
  if (r.error) return { ok: false, error: r.error };
  const linkRefusal = await refuseOutsideRoot(r.root, r.resolved, 'fs.mkdir target');
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
  const src = resolveParam(ctx, params.src ?? params.from ?? params.path, 'src', pinnedOf(params));
  if (src.error) return { ok: false, error: src.error };
  const dest = resolveParam(ctx, params.dest ?? params.to, 'dest', pinnedOf(params));
  if (dest.error) return { ok: false, error: dest.error };
  const destRefusal = await refuseOutsideRoot(dest.root, dest.resolved, 'fs.move destination');
  if (destRefusal) return { ok: false, error: `Refused: ${destRefusal}` };
  const before = await fileInfo(src.resolved);
  try {
    await fs.mkdir(path.win32.dirname(dest.resolved), { recursive: true });
    await fs.rename(src.resolved, dest.resolved);
  } catch (err) {
    return { ok: false, error: `fs.move failed: ${err.message}` };
  }
  return { ok: true, output: `Moved to ${params.dest ?? params.to}`, before, after: await fileInfo(dest.resolved) };
}

async function copy(params, ctx) {
  const denied = needApproval(ctx, 'fs.copy');
  if (denied) return denied;
  const src = resolveParam(ctx, params.src ?? params.from ?? params.path, 'src', pinnedOf(params));
  if (src.error) return { ok: false, error: src.error };
  const dest = resolveParam(ctx, params.dest ?? params.to, 'dest', pinnedOf(params));
  if (dest.error) return { ok: false, error: dest.error };
  const destRefusal = await refuseOutsideRoot(dest.root, dest.resolved, 'fs.copy destination');
  if (destRefusal) return { ok: false, error: `Refused: ${destRefusal}` };
  const before = await fileInfo(src.resolved);
  if (!before) return { ok: false, error: 'fs.copy failed: no such file or directory' };
  try {
    const st = await fs.stat(src.resolved);
    await fs.mkdir(path.win32.dirname(dest.resolved), { recursive: true });
    if (st.isDirectory()) {
      await fs.cp(src.resolved, dest.resolved, { recursive: true });
    } else {
      await fs.copyFile(src.resolved, dest.resolved);
    }
  } catch (err) {
    return { ok: false, error: `fs.copy failed: ${err.message}` };
  }
  return { ok: true, output: `Copied to ${params.dest ?? params.to}`, before, after: await fileInfo(dest.resolved) };
}

async function rename(params, ctx) {
  const denied = needApproval(ctx, 'fs.rename');
  if (denied) return denied;
  const src = resolveParam(ctx, params.src ?? params.from ?? params.path, 'src', pinnedOf(params));
  if (src.error) return { ok: false, error: src.error };
  const dest = resolveParam(ctx, params.dest ?? params.to, 'dest', pinnedOf(params));
  if (dest.error) return { ok: false, error: dest.error };
  const srcDir = path.win32.dirname(path.win32.normalize(src.resolved)).toLowerCase();
  const destDir = path.win32.dirname(path.win32.normalize(dest.resolved)).toLowerCase();
  if (srcDir !== destDir) {
    return { ok: false, error: 'Refused: cross-directory rename; use fs.move instead' };
  }
  const destRefusal = await refuseOutsideRoot(dest.root, dest.resolved, 'fs.rename destination');
  if (destRefusal) return { ok: false, error: `Refused: ${destRefusal}` };
  const before = await fileInfo(src.resolved);
  try {
    await fs.rename(src.resolved, dest.resolved);
  } catch (err) {
    return { ok: false, error: `fs.rename failed: ${err.message}` };
  }
  return { ok: true, output: `Renamed to ${params.dest ?? params.to}`, before, after: await fileInfo(dest.resolved) };
}

async function hash(params, ctx) {
  const r = resolveParam(ctx, params.path, 'path', pinnedOf(params));
  if (r.error) return { ok: false, error: r.error };
  let st;
  try {
    st = await fs.stat(r.resolved);
  } catch {
    return { ok: false, error: 'fs.hash failed: no such file' };
  }
  if (st.isDirectory()) return { ok: false, error: 'fs.hash target is a directory' };
  try {
    const { sha256, size } = await hashStream(r.resolved);
    const after = { size, sha256 };
    return { ok: true, output: `${sha256}  ${params.path}`, after };
  } catch (err) {
    return { ok: false, error: `fs.hash failed: ${err.message}` };
  }
}

async function meta(params, ctx) {
  const r = resolveParam(ctx, params.path, 'path', pinnedOf(params));
  if (r.error) return { ok: false, error: r.error };
  let st;
  try {
    st = await fs.stat(r.resolved);
  } catch {
    return { ok: false, error: 'fs.meta failed: no such file or directory' };
  }
  let realpath;
  try {
    realpath = await fs.realpath(r.resolved);
    realpath = String(realpath).replace(/^\\\\\?\\/, '');
  } catch {
    realpath = r.resolved;
  }
  const info = { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory(), realpath };
  if (st.isFile() && st.size < 1024 * 1024) {
    try {
      info.sha256 = crypto.createHash('sha256').update(await fs.readFile(r.resolved)).digest('hex');
    } catch {
      // omit hash on read failure
    }
  }
  return { ok: true, output: redactSecrets(JSON.stringify(info, null, 2)), after: info };
}

async function search(params, ctx) {
  const query = params.query ?? params.text;
  if (typeof query !== 'string' || !query) return { ok: false, error: 'fs.search requires a query string' };
  const base = resolveParam(ctx, params.path ?? '.', 'path', pinnedOf(params));
  if (base.error) return { ok: false, error: base.error };
  const needle = query.toLowerCase();
  const matches = [];
  let filesSeen = 0;
  let outputLen = 0;
  let truncated = false;

  async function visit(abs, rel, depth) {
    if (filesSeen >= SEARCH_MAX_FILES || truncated) return;
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (depth > SEARCH_MAX_DEPTH) return;
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (filesSeen >= SEARCH_MAX_FILES || truncated) break;
        const childAbs = path.win32.join(abs, entry.name);
        const childRel = rel ? `${rel}\\${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(childAbs, childRel, depth + 1);
        } else {
          filesSeen += 1;
          const nameHit = entry.name.toLowerCase().includes(needle);
          let snippet = null;
          if (!nameHit) {
            try {
              const fst = await fs.stat(childAbs);
              if (fst.isFile() && fst.size <= 5 * 1024 * 1024) {
                const handle = await fs.open(childAbs, 'r');
                try {
                  const len = Math.min(fst.size, SEARCH_CONTENT_CAP);
                  const buf = Buffer.alloc(len);
                  await handle.read(buf, 0, len, 0);
                  if (!buf.includes(0)) {
                    const text = buf.toString('utf8').toLowerCase();
                    const idx = text.indexOf(needle);
                    if (idx >= 0) {
                      const raw = buf.toString('utf8');
                      const start = Math.max(0, idx - 60);
                      snippet = raw.slice(start, idx + query.length + 60).replace(/\s+/g, ' ').slice(0, 240);
                    }
                  }
                } finally {
                  await handle.close();
                }
              }
            } catch {
              // unreadable files are skipped
            }
          }
          if (nameHit || snippet !== null) {
            const entryOut = { file: childRel, match: nameHit ? 'filename' : 'content', ...(snippet ? { snippet } : {}) };
            const line = JSON.stringify(entryOut);
            if (outputLen + line.length > SEARCH_OUTPUT_CAP) {
              truncated = true;
              break;
            }
            matches.push(entryOut);
            outputLen += line.length;
          }
        }
      }
      return;
    }
    // Base is a file: check it directly.
    filesSeen += 1;
    const name = path.win32.basename(abs);
    if (name.toLowerCase().includes(needle)) {
      matches.push({ file: rel || name, match: 'filename' });
    } else if (st.isFile() && st.size <= 5 * 1024 * 1024) {
      try {
        const buf = await fs.readFile(abs);
        if (!buf.includes(0)) {
          const text = buf.slice(0, SEARCH_CONTENT_CAP).toString('utf8').toLowerCase();
          if (text.includes(needle)) matches.push({ file: rel || name, match: 'content' });
        }
      } catch {
        // skip
      }
    }
  }

  await visit(base.resolved, typeof params.path === 'string' ? params.path : '.', 0);
  let output = JSON.stringify({ query, matches, filesSeen, truncated }, null, 2);
  if (output.length > SEARCH_OUTPUT_CAP) {
    output = output.slice(0, SEARCH_OUTPUT_CAP) + '\n...[truncated]';
  }
  return { ok: true, output: redactSecrets(output) };
}

async function remove(params, ctx) {
  const denied = needApproval(ctx, 'fs.delete');
  if (denied) return denied;
  const r = resolveParam(ctx, params.path, 'path', pinnedOf(params));
  if (r.error) return { ok: false, error: r.error };
  if (r.resolved.toLowerCase() === normalizedRoot(r.root)) {
    return { ok: false, error: 'Refused: recursive delete wider than one sandbox directory' };
  }
  if (isHiddenOrSystem(r.resolved, r.root)) {
    return { ok: false, error: 'Refused: hidden/system paths cannot be deleted' };
  }
  const linkRefusal = await refuseOutsideRoot(r.root, r.resolved, 'fs.delete target');
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
    case 'fs.copy': return copy(p, ctx);
    case 'fs.rename': return rename(p, ctx);
    case 'fs.hash': return hash(p, ctx);
    case 'fs.search': return search(p, ctx);
    case 'fs.meta': return meta(p, ctx);
    case 'fs.delete': return remove(p, ctx);
    default: return { ok: false, error: `Unknown fs kind: ${kind}` };
  }
}
