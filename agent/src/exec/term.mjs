// Terminal executor: spawns powershell.exe with no profile, confined cwd,
// clamped timeout, capped + redacted output. Killable via ctx.registerKill.
import { spawn } from 'node:child_process';
import { resolveSandboxPath, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';

const OUTPUT_CAP = 200 * 1024;

function killTree(pid) {
  return new Promise((resolve) => {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    } catch {
      resolve();
    }
  });
}

export async function execTerm(params, ctx) {
  const command = params?.command;
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'term.exec requires a command string' };
  }
  let cwd = ctx.workspaceRoot;
  if (params.cwd !== undefined) {
    const resolved = typeof params.cwd === 'string' ? resolveSandboxPath(ctx.workspaceRoot, params.cwd) : null;
    if (!resolved) return { ok: false, error: `cwd escapes sandbox: ${params.cwd}` };
    const linkRefusal = await refuseOutsideRoot(ctx.workspaceRoot, resolved, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
    cwd = resolved;
  }
  const timeoutSec = Math.min(Math.max(Number(params.timeoutSec ?? 120) || 120, 1), 600);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `Failed to spawn powershell: ${err.message}` });
      return;
    }

    let output = '';
    let truncated = false;
    let timedOut = false;
    let killed = false;
    let exitCode;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (chunk) => {
      if (truncated) return;
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_CAP) {
        output = output.slice(0, OUTPUT_CAP);
        truncated = true;
      }
    };

    ctx.registerKill?.(() => {
      killed = true;
      killTree(child.pid).then(() => {
        try { child.kill(); } catch { /* already dead */ }
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killTree(child.pid).then(() => {
        try { child.kill(); } catch { /* already dead */ }
      });
    }, timeoutSec * 1000);

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      finish({ ok: false, error: `term.exec failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      exitCode = code ?? undefined;
      const note = truncated ? `\n...[output truncated at ${OUTPUT_CAP / 1024}KB]` : '';
      const out = redactSecrets(output) + note || undefined;
      if (timedOut) {
        finish({ ok: false, error: `Timed out after ${timeoutSec}s`, output: out, exitCode });
        return;
      }
      if (killed) {
        const error = ctx.cancelReason?.() === 'stop' ? 'Stopped by owner' : 'Job cancelled by owner';
        finish({ ok: false, error, output: out, exitCode });
        return;
      }
      if (code === 0) {
        finish({ ok: true, output: redactSecrets(output) + note, exitCode: 0 });
      } else {
        finish({ ok: false, error: `Process exited with code ${code}`, output: out, exitCode });
      }
    });
  });
}
