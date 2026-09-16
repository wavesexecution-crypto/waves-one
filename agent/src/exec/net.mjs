// Network executor: https-only downloads into sandbox paths, 50MB cap,
// approval required. Executable types need explicit allowExecutable + approval.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSandboxPath, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';

const MAX_BYTES = 50 * 1024 * 1024;
const EXEC_EXTS = new Set(['.exe', '.msi', '.ps1', '.bat', '.cmd', '.com', '.scr', '.dll', '.reg']);

export async function execNet(params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  if (!ctx.approvalId) return { ok: false, error: 'net.download requires an approved approvalId' };
  let parsed;
  try {
    parsed = new URL(p.url);
  } catch {
    return { ok: false, error: 'net.download requires a valid url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Refused: only https URLs are allowed' };
  if (typeof p.dest !== 'string' || !p.dest) return { ok: false, error: 'net.download requires a dest path' };
  const dest = resolveSandboxPath(ctx.workspaceRoot, p.dest);
  if (!dest) return { ok: false, error: 'dest escapes sandbox' };
  const destRefusal = await refuseOutsideRoot(ctx.workspaceRoot, dest, 'download destination');
  if (destRefusal) return { ok: false, error: `Refused: ${destRefusal}` };
  const ext = path.win32.extname(dest).toLowerCase();
  if (EXEC_EXTS.has(ext) && !(p.allowExecutable === true && ctx.approvalId)) {
    return { ok: false, error: `Refused: executable type '${ext}' requires allowExecutable=true and an approved approvalId` };
  }

  let res;
  try {
    res = await fetch(p.url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, error: `Download failed: ${err.message}` };
  }
  if (!res.ok) return { ok: false, error: `Download failed: HTTP ${res.status}` };
  try {
    if (new URL(res.url).protocol !== 'https:') return { ok: false, error: 'Refused: redirect left https' };
  } catch {
    return { ok: false, error: 'Refused: could not verify final URL' };
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return { ok: false, error: 'Refused: file exceeds 50MB cap' };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      return { ok: false, error: 'Refused: file exceeds 50MB cap' };
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  try {
    await fs.mkdir(path.win32.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
  } catch (err) {
    return { ok: false, error: `Download failed: ${err.message}` };
  }
  const st = await fs.stat(dest);
  const after = { size: st.size, mtimeMs: st.mtimeMs };
  if (st.size < 1024 * 1024) after.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { ok: true, output: `Downloaded ${total} bytes to ${redactSecrets(p.dest)}`, after };
}
