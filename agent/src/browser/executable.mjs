// Security: isolated automation profile (never the owner's browser, so no
// owner cookies, passwords, or sessions are reachable). No CAPTCHA defeat:
// this module contains no solver, no obfuscation, and no anti-detection
// switches; automation uses a stock headless Chromium. Secrets are never
// logged (selectors and lengths only). Domain policy is enforced per
// navigation via isUrlAllowed (defense in depth, server pre-checks too).
//
// Chromium discovery only. Resolution order:
//   1. PLAYWRIGHT_CHROMIUM_PATH env var (verified to exist), then
//   2. newest chrome.exe under %LOCALAPPDATA%\ms-playwright\chromium-*
//      (chrome-win64 / chrome-win / chrome-win-arm64 layouts), else null.
// This module never downloads anything.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const EXE_SUBDIRS = ['chrome-win64', 'chrome-win', 'chrome-win-arm64'];

function newestExeFirst(candidates) {
  return candidates
    .map((exe) => {
      try {
        return { exe, mtimeMs: statSync(exe).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.exe);
}

function scanPlaywrightCache() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const cacheDir = path.join(localAppData, 'ms-playwright');
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^chromium-\d+$/.test(entry.name)) continue;
    const base = path.join(cacheDir, entry.name);
    for (const sub of EXE_SUBDIRS) {
      const exe = path.join(base, sub, 'chrome.exe');
      if (existsSync(exe)) candidates.push(exe);
    }
  }
  const ranked = newestExeFirst(candidates);
  return ranked.length > 0 ? ranked[0] : null;
}

// Returns an absolute path to a local Chromium executable, or null when
// none is installed. Never triggers a download.
export function resolveChromium() {
  const envPath = (process.env.PLAYWRIGHT_CHROMIUM_PATH || '').trim();
  if (envPath && existsSync(envPath)) return envPath;
  return scanPlaywrightCache();
}
