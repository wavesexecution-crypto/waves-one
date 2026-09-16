// Artifact upload executor (NOT wired into exec/index.mjs — the primary
// workstream wires the router at integration). Reads a roots-contained file
// (≤15MB), sha256-hashes it, and POSTs it to /api/agent/artifacts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveAcrossRoots, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';

const MAX_BYTES = 15 * 1024 * 1024;

function getRoots(ctx) {
  if (Array.isArray(ctx?.roots) && ctx.roots.length) return ctx.roots;
  return [ctx.workspaceRoot];
}

export async function execUpload(params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  if (!ctx.approvalId) return { ok: false, error: 'upload.artifact requires an approved approvalId' };
  if (typeof p.path !== 'string' || !p.path) return { ok: false, error: 'upload.artifact requires a path' };
  if (typeof ctx.serverUrl !== 'string' || !ctx.serverUrl) {
    return { ok: false, error: 'upload.artifact requires ctx.serverUrl' };
  }
  if (typeof ctx.authHeader !== 'function') {
    return { ok: false, error: 'upload.artifact requires ctx.authHeader' };
  }
  const hit = resolveAcrossRoots(getRoots(ctx), p.path, p.root);
  if (!hit) return { ok: false, error: 'path escapes sandbox' };
  const linkRefusal = await refuseOutsideRoot(hit.root, hit.path, 'upload source');
  if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };

  let st;
  try {
    st = await fs.stat(hit.path);
  } catch {
    return { ok: false, error: 'upload.artifact failed: no such file' };
  }
  if (st.isDirectory()) return { ok: false, error: 'upload.artifact target is a directory' };
  if (st.size > MAX_BYTES) return { ok: false, error: 'Refused: file exceeds 15MB cap' };

  let buf;
  try {
    buf = await fs.readFile(hit.path);
  } catch (err) {
    return { ok: false, error: `upload.artifact failed: ${err.message}` };
  }
  if (buf.length > MAX_BYTES) return { ok: false, error: 'Refused: file exceeds 15MB cap' };
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const name = typeof p.name === 'string' && p.name ? p.name : path.win32.basename(hit.path);
  const kind = typeof p.kind === 'string' && p.kind ? p.kind : 'file';
  const mime = typeof p.mime === 'string' && p.mime ? p.mime : 'application/octet-stream';

  let res;
  try {
    res = await fetch(`${ctx.serverUrl.replace(/\/+$/, '')}/api/agent/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: ctx.authHeader() },
      body: JSON.stringify({
        jobId: ctx.jobId,
        name,
        kind,
        mime,
        dataBase64: buf.toString('base64'),
      }),
    });
  } catch (err) {
    return { ok: false, error: `Upload failed: ${err.message}` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // handled below
  }
  if (!res.ok) {
    return { ok: false, error: `Upload failed (HTTP ${res.status}): ${body?.error ?? res.statusText}` };
  }
  const artifactId = body?.artifactId ?? body?.id ?? null;
  const after = { size: buf.length, sha256, ...(artifactId ? { artifactId } : {}) };
  return { ok: true, output: `Uploaded ${redactSecrets(name)} (${buf.length} bytes, sha256 ${sha256.slice(0, 12)}…)`, after };
}
