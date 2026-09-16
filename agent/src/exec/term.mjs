// Terminal executor: spawns powershell.exe with no profile, confined cwd,
// clamped timeout, capped + redacted output. Killable via ctx.registerKill.
// Returns { ok, output, stderr?, exitCode? } — stderr is posted separately.
import { spawn } from 'node:child_process';
import { resolveAcrossRoots, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';

const OUTPUT_CAP = 200 * 1024;

function getRoots(ctx) {
  if (Array.isArray(ctx?.roots) && ctx.roots.length) return ctx.roots;
  return [ctx.workspaceRoot];
}

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
  let cwd = getRoots(ctx)[0];
  let cwdRoot = cwd;
  if (params.cwd !== undefined) {
    const hit = typeof params.cwd === 'string'
      ? resolveAcrossRoots(getRoots(ctx), params.cwd, params.root)
      : null;
    if (!hit) return { ok: false, error: `cwd escapes sandbox: ${params.cwd}` };
    const linkRefusal = await refuseOutsideRoot(hit.root, hit.path, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
    cwd = hit.path;
    cwdRoot = hit.root;
  } else if (cwd) {
    // Default cwd stays inside the first root; still guard links.
    const linkRefusal = await refuseOutsideRoot(cwdRoot, cwd, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
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

    let stdout = '';
    let stderr = '';
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
    const appendStdout = (chunk) => {
      if (truncated) return;
      stdout += chunk.toString('utf8');
      if (stdout.length + stderr.length > OUTPUT_CAP) truncated = true;
    };
    const appendStderr = (chunk) => {
      if (truncated) return;
      stderr += chunk.toString('utf8');
      if (stdout.length + stderr.length > OUTPUT_CAP) truncated = true;
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

    child.stdout?.on('data', appendStdout);
    child.stderr?.on('data', appendStderr);
    child.on('error', (err) => {
      finish({ ok: false, error: `term.exec failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      exitCode = code ?? undefined;
      const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(0, OUTPUT_CAP);
      const note = truncated ? `\n...[output truncated at ${OUTPUT_CAP / 1024}KB]` : '';
      const out = redactSecrets(combined) + note || undefined;
      const errText = stderr ? redactSecrets(stderr.slice(0, OUTPUT_CAP)) : undefined;
      if (timedOut) {
        finish({ ok: false, error: `Timed out after ${timeoutSec}s`, output: out, stderr: errText, exitCode });
        return;
      }
      if (killed) {
        const error = ctx.cancelReason?.() === 'stop' ? 'Stopped by owner' : 'Job cancelled by owner';
        finish({ ok: false, error, output: out, stderr: errText, exitCode });
        return;
      }
      if (code === 0) {
        const result = { ok: true, output: redactSecrets(combined) + note, exitCode: 0 };
        if (errText) result.stderr = errText;
        finish(result);
      } else {
        finish({ ok: false, error: `Process exited with code ${code}`, output: out, stderr: errText, exitCode });
      }
    });
  });
}
