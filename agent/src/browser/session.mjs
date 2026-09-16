// Security: isolated automation profile under
// %APPDATA%\waves-one-agent\browser-profile (NOT the owner's browser: no
// owner cookies, passwords, history, or extensions are loaded). No CAPTCHA
// defeat: this module contains no solver, no obfuscation, and no
// anti-detection switches; automation uses a stock Chromium launched via
// playwright-core. Secrets are never logged (selectors and lengths only).
// Domain policy is enforced per navigation in actions.mjs.
//
// Lazy, mutex-serialized Playwright session with a 5-minute idle auto-close.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { redactSecrets } from '../policy.mjs';
import { resolveChromium } from './executable.mjs';

const IDLE_MS = 5 * 60 * 1000;

const state = {
  context: null,
  page: null,
  jobId: undefined,
  currentUrl: '',
  actions: 0,
  screenshots: 0,
  downloads: 0,
  idleTimer: null,
};

// Simple promise mutex: one browser job at a time is the norm, but access
// is serialized so concurrent jobs cannot interleave page operations.
let tail = Promise.resolve();
export function runExclusive(fn) {
  const run = tail.then(() => fn(), () => fn());
  tail = run.catch(() => {});
  return run;
}

export function profileDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'waves-one-agent', 'browser-profile');
}

function firstRoot(ctx) {
  if (Array.isArray(ctx?.roots) && ctx.roots.length > 0) return ctx.roots[0];
  if (typeof ctx?.workspaceRoot === 'string' && ctx.workspaceRoot) return ctx.workspaceRoot;
  return process.cwd();
}

export function getDownloadsDir(ctx) {
  return path.join(firstRoot(ctx), 'browser-downloads');
}

export function setCurrentUrl(url) {
  state.currentUrl = redactSecrets(String(url ?? '')).slice(0, 500);
}

// Plain object only: no page/context handles ever leave this module.
export function getSessionStatus() {
  const status = {
    active: Boolean(state.context && state.page && !state.page.isClosed()),
    actions: state.actions,
    screenshots: state.screenshots,
    downloads: state.downloads,
  };
  if (state.currentUrl) status.page = state.currentUrl;
  if (state.jobId !== undefined) status.jobId = state.jobId;
  return status;
}

// (Re)arms the 5-minute idle auto-close timer. Unref'd so it never pins the
// agent process open on its own.
export function touchSession(jobId) {
  if (jobId !== undefined) state.jobId = jobId;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    closeSession().catch(() => {});
  }, IDLE_MS);
  if (typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
}

export function noteAction() {
  state.actions += 1;
}

export function noteScreenshot() {
  state.screenshots += 1;
}

export function noteDownload() {
  state.downloads += 1;
}

// Kill hook target: closes the current page only, never the whole session,
// so a stop/cancel halts the in-flight page without destroying the profile.
export async function closePage() {
  const page = state.page;
  state.page = null;
  if (page && !page.isClosed()) {
    try {
      await page.close();
    } catch {
      // best effort
    }
  }
}

export async function closeSession() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  try {
    if (state.page && !state.page.isClosed()) await state.page.close();
  } catch {
    // best effort
  }
  try {
    if (state.context) await state.context.close();
  } catch {
    // best effort
  }
  state.context = null;
  state.page = null;
  state.jobId = undefined;
  state.currentUrl = '';
  state.actions = 0;
  state.screenshots = 0;
  state.downloads = 0;
}

// Lazily launches the isolated persistent context on first use and returns
// { context, page }. Headed (visible on the owner's screen) is consequential
// and allowed only with an approved approvalId.
export async function ensureSession(params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  if (p.headed === true && !ctx?.approvalId) {
    throw new Error('Refused: headed mode requires an approved approvalId');
  }
  if (!state.context) {
    const exe = resolveChromium();
    if (!exe) {
      throw new Error(
        'No local Chromium executable found (checked PLAYWRIGHT_CHROMIUM_PATH and %LOCALAPPDATA%\\ms-playwright); refusing to download one',
      );
    }
    const downloadsPath = getDownloadsDir(ctx);
    await fs.mkdir(downloadsPath, { recursive: true });
    state.context = await chromium.launchPersistentContext(profileDir(), {
      executablePath: exe,
      headless: p.headed !== true,
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      downloadsPath,
    });
  }
  touchSession(ctx?.jobId);
  if (!state.page || state.page.isClosed()) {
    state.page = await state.context.newPage();
  }
  return { context: state.context, page: state.page };
}
