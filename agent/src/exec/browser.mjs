// Security: Playwright automation in the isolated profile from
// ../browser/session.mjs (never the owner's browser: no owner
// cookies/passwords). No CAPTCHA defeat: no solver, no obfuscation, no
// anti-detection switches; stock headless Chromium only. Secrets are never
// logged (selectors and lengths only). Domain policy is re-checked locally
// before every navigation via checkBrowserUrl (defense in depth; validateJob
// and the server pre-check too) and refusals are audit-visible errors.
//
// Router entry point. Keeps the current executeJob(kind, params, ctx) shape:
// kind is optional. When absent, only browser.open is served (backward
// compatible); any other kind requires the router to pass kind explicitly
// (or params._kind). Control kinds additionally require ctx.approvalId.

import { runBrowserAction, checkBrowserUrl, BROWSER_KINDS, CONTROL_KINDS } from '../browser/actions.mjs';

// Params fields that only make sense for non-open kinds. When kind is absent
// and any of these are present, refuse and ask for an explicit kind instead
// of mis-executing the job as browser.open.
const NON_OPEN_FIELDS = [
  'selector', 'text', 'value', 'file', 'for', 'format',
  'expectFile', 'x', 'y', 'ms', 'fullPage',
];

export async function execBrowser(params, ctx, kind) {
  const p = params && typeof params === 'object' ? params : {};
  let resolvedKind = typeof kind === 'string' && kind ? kind : undefined;
  if (!resolvedKind && typeof p._kind === 'string' && p._kind) resolvedKind = p._kind;
  if (!resolvedKind) {
    const looksLikeAction = NON_OPEN_FIELDS.some((field) => p[field] !== undefined);
    if (looksLikeAction) {
      return {
        ok: false,
        error: 'Browser action requires an explicit kind (router must pass kind to execBrowser)',
      };
    }
    resolvedKind = 'browser.open';
  }
  if (!BROWSER_KINDS.has(resolvedKind)) {
    return { ok: false, error: `Refused: unknown browser kind '${resolvedKind}'` };
  }
  // Defense in depth: validateJob already enforces capability + approval +
  // domain policy server-side; re-check approval and domains locally.
  if (CONTROL_KINDS.has(resolvedKind) && !ctx?.approvalId) {
    return { ok: false, error: `${resolvedKind} requires an approved approvalId` };
  }
  if ((resolvedKind === 'browser.open' || resolvedKind === 'browser.navigate') && typeof p.url === 'string') {
    const refusal = checkBrowserUrl(p.url, ctx);
    if (refusal) return { ok: false, error: refusal };
  }
  const rest = { ...p };
  delete rest._kind;
  try {
    return await runBrowserAction(resolvedKind, rest, ctx);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 500) };
  }
}
