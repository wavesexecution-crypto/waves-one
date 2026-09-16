// Security: runs inside the isolated automation profile from session.mjs
// (never the owner's browser: no owner cookies/passwords). No CAPTCHA
// defeat: this module contains no solver, no obfuscation, and no
// anti-detection switches; automation uses stock headless Chromium. Secrets
// are never logged: events carry selectors and text lengths only, never
// typed text or page content. Domain policy is enforced locally before every
// navigation via isUrlAllowed (defense in depth; the server pre-checks too)
// and refusals are audit-visible errors.
//
// Implements the 13 v2 browser job kinds. Every result is
// { ok, output?, error?, after? } where output is a short human summary
// (counts/URLs, capped extracts) and after is the session status.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as policyMirror from '../policy.mjs';
import { redactSecrets } from '../policy.mjs';
import {
  ensureSession,
  runExclusive,
  getSessionStatus,
  closeSession,
  touchSession,
  noteAction,
  noteDownload,
  noteScreenshot,
  setCurrentUrl,
  getDownloadsDir,
  closePage,
} from './session.mjs';

export const READ_KINDS = new Set([
  'browser.open',
  'browser.inspect',
  'browser.extract',
  'browser.screenshot',
]);

export const CONTROL_KINDS = new Set([
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.scroll',
  'browser.download',
  'browser.upload',
  'browser.wait',
  'browser.close',
]);

export const BROWSER_KINDS = new Set([...READ_KINDS, ...CONTROL_KINDS]);

const DEFAULT_TIMEOUT_MS = 30000;
const INSPECT_CAP = 10 * 1024;
const EXTRACT_CAP = 50 * 1024;

// Per-kind default timeout; params.timeoutMs clamped to 1s..120s.
export function clampTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(120000, Math.max(1000, Math.floor(n)));
}

function cancelled(ctx) {
  try {
    return ctx?.isCancelled?.() === true;
  } catch {
    return false;
  }
}

function cancelError(ctx) {
  let reason = null;
  try {
    reason = ctx?.cancelReason?.();
  } catch {
    // ignore
  }
  return `Cancelled${reason ? `: ${reason}` : ''}`;
}

function domainsOf(ctx) {
  const d = ctx?.policy?.domains;
  if (d && Array.isArray(d.allowed) && Array.isArray(d.blocked)) return d;
  // Default-deny for http(s) when no domain policy is attached; data:/about:
  // navigations still pass per protocol semantics.
  return { allowed: [], blocked: [] };
}

function hostMatches(host, pattern) {
  const clean = String(pattern).toLowerCase().replace(/\.$/, '');
  if (clean.startsWith('*.')) {
    const base = clean.slice(2);
    return host !== base && host.endsWith(`.${base}`);
  }
  return host === clean || host.endsWith(`.${clean}`);
}

// Local fallback mirroring src/lib/agent-protocol.ts v2 isUrlAllowed
// (blocked wins; dot-boundary subdomain match; data:/about:blank pass;
// non-http(s) refused). Used only when the policy mirror does not export it.
function localIsUrlAllowed(rawUrl, domains) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'data:' || String(rawUrl).toLowerCase().startsWith('about:blank')) return true;
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const blocked = Array.isArray(domains?.blocked) ? domains.blocked : [];
  const allowed = Array.isArray(domains?.allowed) ? domains.allowed : [];
  if (blocked.some((pattern) => hostMatches(host, pattern))) return false;
  return allowed.some((pattern) => hostMatches(host, pattern));
}

function urlAllowed(rawUrl, domains) {
  try {
    if (typeof policyMirror.isUrlAllowed === 'function') {
      return policyMirror.isUrlAllowed(rawUrl, domains) === true;
    }
  } catch {
    return false;
  }
  return localIsUrlAllowed(rawUrl, domains);
}

// Audit-visible refusal reason, or null when navigation may proceed.
export function checkBrowserUrl(rawUrl, ctx) {
  if (typeof rawUrl !== 'string' || !rawUrl) return 'browser.open requires a valid url';
  if (/[\r\n]/.test(rawUrl)) return 'Refused: invalid URL';
  if (!urlAllowed(rawUrl, domainsOf(ctx))) {
    return `Refused: URL not allowed by domain policy: ${redactSecrets(rawUrl).slice(0, 200)}`;
  }
  return null;
}

function rootsOf(ctx) {
  if (Array.isArray(ctx?.roots) && ctx.roots.length > 0) return ctx.roots;
  if (typeof ctx?.workspaceRoot === 'string' && ctx.workspaceRoot) return [ctx.workspaceRoot];
  return [];
}

// Local fallback mirroring protocol v2 resolveAcrossRoots/resolveSandboxPath
// (win32 confinement + alternate-data-stream segment refusal).
function localResolveAcrossRoots(roots, target, pinnedRoot) {
  if (!Array.isArray(roots) || roots.length === 0) return null;
  let base = roots[0];
  if (pinnedRoot !== undefined) {
    const match = roots.find((r) => String(r).toLowerCase() === String(pinnedRoot).toLowerCase());
    if (!match) return null;
    base = match;
  }
  const normalizedRoot = path.win32.normalize(base).replace(/[\\/]+$/, '').toLowerCase();
  const resolved = path.win32.isAbsolute(target)
    ? path.win32.normalize(target)
    : path.win32.normalize(path.win32.join(base, target));
  const lowered = resolved.toLowerCase();
  if (lowered !== normalizedRoot && !lowered.startsWith(`${normalizedRoot}\\`)) return null;
  const relative = lowered === normalizedRoot ? '' : lowered.slice(normalizedRoot.length + 1);
  for (const segment of relative.split('\\')) {
    if (segment.includes(':')) return null;
  }
  return { path: resolved, root: base };
}

function resolveUploadFile(roots, target, pinnedRoot) {
  try {
    if (typeof policyMirror.resolveAcrossRoots === 'function') {
      return policyMirror.resolveAcrossRoots(roots, target, pinnedRoot);
    }
  } catch {
    return null;
  }
  return localResolveAcrossRoots(roots, target, pinnedRoot);
}

function requireString(p, field) {
  const value = p[field];
  if (typeof value !== 'string' || !value) return { error: `${field} is required` };
  return { value };
}

function shortSelector(selector) {
  return String(selector).slice(0, 120);
}

function statusAfter() {
  try {
    return getSessionStatus();
  } catch {
    return undefined;
  }
}

function emit(ctx, level, message) {
  try {
    ctx?.onEvent?.(level, message);
  } catch {
    // events are best effort
  }
}

async function openOrNavigate(kind, p, ctx) {
  const refusal = checkBrowserUrl(p.url, ctx);
  if (refusal) return { ok: false, error: refusal };
  if (kind === 'browser.navigate' && !getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  emit(ctx, 'info', `${kind} ${redactSecrets(p.url).slice(0, 200)}`);
  await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout });
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  setCurrentUrl(page.url());
  noteAction();
  touchSession(ctx?.jobId);
  return {
    ok: true,
    output: `Opened ${redactSecrets(page.url()).slice(0, 200)}`,
    after: statusAfter(),
  };
}

async function inspect(p, ctx) {
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  const selector = typeof p.selector === 'string' && p.selector ? p.selector : null;
  emit(ctx, 'info', `browser.inspect ${selector ? shortSelector(selector) : '(page)'} on ${getSessionStatus().page ?? 'unknown page'}`);
  const summary = await Promise.race([
    page.evaluate((sel) => {
      const describe = (el) => ({
        tag: el.tagName ? el.tagName.toLowerCase() : '?',
        role: el.getAttribute ? el.getAttribute('role') : null,
        name: ((el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.value || '').trim().slice(0, 80),
      });
      if (sel) {
        const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 20);
        return { selector: sel, count: document.querySelectorAll(sel).length, sample: nodes.map(describe) };
      }
      return {
        title: document.title.slice(0, 200),
        links: document.querySelectorAll('a').length,
        buttons: document.querySelectorAll('button').length,
        inputs: document.querySelectorAll('input,textarea,select').length,
        images: document.querySelectorAll('img').length,
        sample: Array.from(document.querySelectorAll('button,a,input')).slice(0, 20).map(describe),
      };
    }, selector),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`inspect timed out after ${timeout}ms`)), timeout)),
  ]);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  noteAction();
  touchSession(ctx?.jobId);
  let json = JSON.stringify(summary);
  const fullLen = json.length;
  if (fullLen > INSPECT_CAP) {
    json = `${json.slice(0, INSPECT_CAP)}\n...[truncated: summary is ${fullLen} chars, showing first ${INSPECT_CAP}]`;
  }
  const count = summary && typeof summary.count === 'number' ? `${summary.count} match(es)` : 'page summary';
  emit(ctx, 'info', `browser.inspect done (${count})`);
  return { ok: true, output: json, after: statusAfter() };
}

async function click(p, ctx) {
  const sel = requireString(p, 'selector');
  if (sel.error) return { ok: false, error: `browser.click ${sel.error}` };
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  emit(ctx, 'info', `browser.click ${shortSelector(sel.value)} on ${getSessionStatus().page ?? 'unknown page'}`);
  await page.click(sel.value, { timeout });
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  setCurrentUrl(page.url());
  noteAction();
  touchSession(ctx?.jobId);
  return { ok: true, output: `Clicked ${shortSelector(sel.value)}`, after: statusAfter() };
}

async function type(p, ctx) {
  const sel = requireString(p, 'selector');
  if (sel.error) return { ok: false, error: `browser.type ${sel.error}` };
  if (typeof p.text !== 'string') return { ok: false, error: 'browser.type requires a text string' };
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  // Log the selector and the text length ONLY; typed text is never logged.
  emit(ctx, 'info', `browser.type into ${shortSelector(sel.value)} (${p.text.length} chars) on ${getSessionStatus().page ?? 'unknown page'}`);
  await page.fill(sel.value, p.text, { timeout });
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  setCurrentUrl(page.url());
  noteAction();
  touchSession(ctx?.jobId);
  return { ok: true, output: `Typed ${p.text.length} chars into ${shortSelector(sel.value)}`, after: statusAfter() };
}

async function select(p, ctx) {
  const sel = requireString(p, 'selector');
  if (sel.error) return { ok: false, error: `browser.select ${sel.error}` };
  const values = Array.isArray(p.value) ? p.value : [p.value];
  if (values.length === 0 || values.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'browser.select requires a value string (or array of strings)' };
  }
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  emit(ctx, 'info', `browser.select in ${shortSelector(sel.value)} (${values.length} value(s)) on ${getSessionStatus().page ?? 'unknown page'}`);
  const chosen = await page.selectOption(sel.value, values, { timeout });
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  setCurrentUrl(page.url());
  noteAction();
  touchSession(ctx?.jobId);
  return { ok: true, output: `Selected ${chosen.length} option(s) in ${shortSelector(sel.value)}`, after: statusAfter() };
}

async function scroll(p, ctx) {
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  if (typeof p.selector === 'string' && p.selector) {
    emit(ctx, 'info', `browser.scroll to ${shortSelector(p.selector)} on ${getSessionStatus().page ?? 'unknown page'}`);
    await page.locator(p.selector).scrollIntoViewIfNeeded({ timeout });
    noteAction();
    touchSession(ctx?.jobId);
    return { ok: true, output: `Scrolled to ${shortSelector(p.selector)}`, after: statusAfter() };
  }
  const hasX = Number.isFinite(Number(p.x));
  const hasY = Number.isFinite(Number(p.y));
  if (hasX || hasY) {
    const x = hasX ? Number(p.x) : 0;
    const y = hasY ? Number(p.y) : 0;
    emit(ctx, 'info', `browser.scroll to (${x},${y}) on ${getSessionStatus().page ?? 'unknown page'}`);
    await page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y]);
  } else {
    emit(ctx, 'info', `browser.scroll one viewport on ${getSessionStatus().page ?? 'unknown page'}`);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  }
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  noteAction();
  touchSession(ctx?.jobId);
  return { ok: true, output: 'Scrolled page', after: statusAfter() };
}

function sanitizeFileName(name) {
  const base = path.win32.basename(String(name || '')).replace(/[<>:"|?*\r\n]/g, '_').trim();
  return base || 'download';
}

async function maybeUploadArtifact(p, ctx, { name, kind, mime, data }) {
  if (p.upload === false) return '';
  if (typeof ctx?.uploadArtifact !== 'function') return '';
  try {
    const res = await ctx.uploadArtifact({ name, kind, mime, data });
    const id = res && typeof res.artifactId === 'string' ? res.artifactId : null;
    return id ? `, artifact ${id}` : ', artifact uploaded';
  } catch (err) {
    // The local result still succeeds; report the upload failure separately.
    return `, artifact upload failed: ${String(err?.message ?? err).slice(0, 200)}`;
  }
}

async function download(p, ctx) {
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const selector = typeof p.selector === 'string' && p.selector ? p.selector : null;
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  const dlDir = getDownloadsDir(ctx);
  await fs.mkdir(dlDir, { recursive: true });
  emit(
    ctx,
    'info',
    `browser.download${selector ? ` via ${shortSelector(selector)}` : ' (waiting for download event)'} on ${getSessionStatus().page ?? 'unknown page'}`,
  );
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout }),
    (async () => {
      if (selector) await page.click(selector, { timeout });
    })(),
  ]);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  const fileName = typeof p.expectFile === 'string' && p.expectFile
    ? sanitizeFileName(p.expectFile)
    : sanitizeFileName(dl.suggestedFilename());
  const dest = path.join(dlDir, fileName);
  await dl.saveAs(dest);
  const st = await fs.stat(dest);
  noteDownload();
  noteAction();
  touchSession(ctx?.jobId);
  const data = await fs.readFile(dest);
  const artifactNote = await maybeUploadArtifact(p, ctx, {
    name: fileName,
    kind: 'download',
    mime: 'application/octet-stream',
    data,
  });
  emit(ctx, 'info', `browser.download saved ${fileName} (${st.size} bytes)`);
  return {
    ok: true,
    output: `Downloaded ${fileName} (${st.size} bytes)${artifactNote}`,
    after: statusAfter(),
  };
}

async function upload(p, ctx) {
  const sel = requireString(p, 'selector');
  if (sel.error) return { ok: false, error: `browser.upload ${sel.error}` };
  if (typeof p.file !== 'string' || !p.file) return { ok: false, error: 'browser.upload requires a file path' };
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const resolved = resolveUploadFile(rootsOf(ctx), p.file, typeof p.root === 'string' ? p.root : undefined);
  if (!resolved) return { ok: false, error: `Refused: file escapes authorized roots: ${redactSecrets(p.file).slice(0, 200)}` };
  let st;
  try {
    st = await fs.stat(resolved.path);
  } catch {
    return { ok: false, error: 'browser.upload failed: no such file' };
  }
  if (!st.isFile()) return { ok: false, error: 'browser.upload target is not a file' };
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  emit(ctx, 'info', `browser.upload to ${shortSelector(sel.value)} (${st.size} bytes) on ${getSessionStatus().page ?? 'unknown page'}`);
  await page.setInputFiles(sel.value, resolved.path, { timeout });
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  noteAction();
  touchSession(ctx?.jobId);
  return {
    ok: true,
    output: `Uploaded ${sanitizeFileName(resolved.path)} (${st.size} bytes) to ${shortSelector(sel.value)}`,
    after: statusAfter(),
  };
}

async function screenshot(p, ctx) {
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  emit(ctx, 'info', `browser.screenshot${p.fullPage ? ' (full page)' : ''} on ${getSessionStatus().page ?? 'unknown page'}`);
  const buffer = await page.screenshot({ type: 'png', fullPage: p.fullPage === true, timeout });
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  noteScreenshot();
  noteAction();
  touchSession(ctx?.jobId);
  const safeJob = String(ctx?.jobId ?? 'browser').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'browser';
  const artifactNote = await maybeUploadArtifact(p, ctx, {
    name: `browser-${safeJob}-${getSessionStatus().screenshots}.png`,
    kind: 'screenshot',
    mime: 'image/png',
    data: buffer,
  });
  return {
    ok: true,
    output: `Screenshot captured (${buffer.length} bytes)${artifactNote}`,
    after: statusAfter(),
  };
}

async function waitFor(p, ctx) {
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const timeout = clampTimeout(p.timeoutMs);
  const mode = typeof p.for === 'string' ? p.for : (typeof p.selector === 'string' && p.selector ? 'selector' : 'timeout');
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  if (mode === 'selector') {
    const sel = requireString(p, 'selector');
    if (sel.error) return { ok: false, error: `browser.wait ${sel.error}` };
    emit(ctx, 'info', `browser.wait for selector ${shortSelector(sel.value)}`);
    await page.waitForSelector(sel.value, { timeout });
    noteAction();
    touchSession(ctx?.jobId);
    return { ok: true, output: `Wait satisfied: ${shortSelector(sel.value)} appeared`, after: statusAfter() };
  }
  if (mode === 'navigation') {
    emit(ctx, 'info', 'browser.wait for navigation');
    await page.waitForEvent('framenavigated', { timeout });
    if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
    setCurrentUrl(page.url());
    noteAction();
    touchSession(ctx?.jobId);
    return {
      ok: true,
      output: `Navigation observed: ${redactSecrets(page.url()).slice(0, 200)}`,
      after: statusAfter(),
    };
  }
  if (mode !== 'timeout') return { ok: false, error: `browser.wait requires for 'selector', 'timeout', or 'navigation'` };
  const rawMs = p.ms === undefined ? 1000 : Number(p.ms);
  if (!Number.isFinite(rawMs) || rawMs < 0) return { ok: false, error: 'browser.wait requires a non-negative ms' };
  const ms = Math.min(Math.floor(rawMs), timeout);
  emit(ctx, 'info', `browser.wait ${ms}ms`);
  await page.waitForTimeout(ms);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  noteAction();
  touchSession(ctx?.jobId);
  return { ok: true, output: `Waited ${ms} ms`, after: statusAfter() };
}

async function extract(p, ctx) {
  if (!getSessionStatus().active) {
    return { ok: false, error: 'No active browser session; use browser.open first' };
  }
  const format = p.format === undefined ? 'text' : p.format;
  if (format !== 'text') return { ok: false, error: `Refused: browser.extract supports format 'text' only` };
  const selector = typeof p.selector === 'string' && p.selector ? p.selector : null;
  const timeout = clampTimeout(p.timeoutMs);
  const { page } = await ensureSession(p, ctx);
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  emit(ctx, 'info', `browser.extract text ${selector ? shortSelector(selector) : '(body)'} on ${getSessionStatus().page ?? 'unknown page'}`);
  let text;
  try {
    text = await Promise.race([
      selector
        ? page.$eval(selector, (el) => el.innerText)
        : page.evaluate(() => document.body.innerText),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`extract timed out after ${timeout}ms`)), timeout)),
    ]);
  } catch {
    return { ok: false, error: `browser.extract failed: no element matches ${selector ? shortSelector(selector) : '(body)'}` };
  }
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  noteAction();
  touchSession(ctx?.jobId);
  let output = redactSecrets(String(text ?? ''));
  if (output.length > EXTRACT_CAP) {
    output = `${output.slice(0, EXTRACT_CAP)}\n...[truncated: text is ${output.length} chars, showing first ${EXTRACT_CAP}]`;
  }
  return { ok: true, output, after: statusAfter() };
}

async function doAction(kind, p, ctx) {
  if (kind === 'browser.open' || kind === 'browser.navigate') return openOrNavigate(kind, p, ctx);
  if (kind === 'browser.close') {
    emit(ctx, 'info', 'browser.close: closing session');
    await closeSession();
    return { ok: true, output: 'Browser session closed', after: statusAfter() };
  }
  switch (kind) {
    case 'browser.inspect': return inspect(p, ctx);
    case 'browser.click': return click(p, ctx);
    case 'browser.type': return type(p, ctx);
    case 'browser.select': return select(p, ctx);
    case 'browser.scroll': return scroll(p, ctx);
    case 'browser.download': return download(p, ctx);
    case 'browser.upload': return upload(p, ctx);
    case 'browser.screenshot': return screenshot(p, ctx);
    case 'browser.wait': return waitFor(p, ctx);
    case 'browser.extract': return extract(p, ctx);
    default: return { ok: false, error: `Refused: unknown browser kind '${kind}'` };
  }
}

// Runs one browser action under the session mutex. Stopping/cancelling closes
// the page (not the whole session) via the registered kill hook.
export async function runBrowserAction(kind, params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  if (!BROWSER_KINDS.has(kind)) return { ok: false, error: `Refused: unknown browser kind '${kind}'` };
  if (CONTROL_KINDS.has(kind) && !ctx?.approvalId) {
    return { ok: false, error: `${kind} requires an approved approvalId` };
  }
  if (cancelled(ctx)) return { ok: false, error: cancelError(ctx) };
  try {
    ctx?.registerKill?.(() => closePage().catch(() => {}));
  } catch {
    // kill-hook registration is best effort
  }
  try {
    return await runExclusive(() => doAction(kind, p, ctx));
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 500) };
  }
}

export { closeSession };
