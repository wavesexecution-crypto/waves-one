// Browser executor: opens http(s) URLs only, via Start-Process with
// single-quote escaping (no cmd shell, no metacharacter injection).
import { spawn } from 'node:child_process';
import { redactSecrets } from '../policy.mjs';

export async function execBrowser(params) {
  const url = params?.url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'browser.open requires a valid url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Refused: only https URLs may be opened' };
  }
  if (/[\r\n]/.test(url)) return { ok: false, error: 'Refused: invalid URL' };
  const escaped = url.replace(/'/g, "''");
  await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${escaped}'`],
      { windowsHide: true },
    );
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
  return { ok: true, output: `Opened ${redactSecrets(url)}` };
}
