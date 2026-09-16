// Git executor: status/log/diff are low risk; commit/push need approval.
// Every command runs inside the sandbox and the cwd must be a git repo.
import { spawn } from 'node:child_process';
import { resolveSandboxPath, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';

const REF_PATTERN = /^[A-Za-z0-9_./-]+$/;

function runGit(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, error: `git failed to start: ${e.message}` }));
    child.on('close', (code) => {
      const text = redactSecrets(out + (err ? `\n[stderr]\n${err}` : ''));
      if (code === 0) {
        resolve({ ok: true, output: text || '(no output)', exitCode: 0 });
      } else {
        resolve({ ok: false, error: `git exited with code ${code}`, output: text || undefined, exitCode: code ?? undefined });
      }
    });
  });
}

export async function execGit(kind, params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  let cwd = ctx.workspaceRoot;
  const rawCwd = p.cwd ?? p.path;
  if (rawCwd !== undefined) {
    const resolved = typeof rawCwd === 'string' ? resolveSandboxPath(ctx.workspaceRoot, rawCwd) : null;
    if (!resolved) return { ok: false, error: 'cwd escapes sandbox' };
    const linkRefusal = await refuseOutsideRoot(ctx.workspaceRoot, resolved, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
    cwd = resolved;
  }
  const repo = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!repo.ok) return { ok: false, error: `Not a git repository: ${cwd}` };

  switch (kind) {
    case 'git.status':
      return runGit(['status', '--short', '--branch'], cwd);
    case 'git.log': {
      const n = Math.min(Math.max(Number(p.n ?? 20) || 20, 1), 100);
      return runGit(['log', '--oneline', `-${n}`], cwd);
    }
    case 'git.diff': {
      const args = ['diff'];
      if (p.ref !== undefined) {
        if (typeof p.ref !== 'string' || !REF_PATTERN.test(p.ref)) {
          return { ok: false, error: 'Invalid ref' };
        }
        args.push(p.ref);
      }
      return runGit(args, cwd);
    }
    case 'git.commit': {
      if (!ctx.approvalId) return { ok: false, error: 'git.commit requires an approved approvalId' };
      if (typeof p.message !== 'string' || !p.message.trim()) {
        return { ok: false, error: 'git.commit requires a message' };
      }
      return runGit(['commit', '-m', p.message], cwd);
    }
    case 'git.push': {
      if (!ctx.approvalId) return { ok: false, error: 'git.push requires an approved approvalId' };
      const args = ['push'];
      for (const key of ['remote', 'branch']) {
        if (p[key] !== undefined) {
          if (typeof p[key] !== 'string' || !REF_PATTERN.test(p[key])) {
            return { ok: false, error: `Invalid ${key}` };
          }
          args.push(p[key]);
        }
      }
      return runGit(args, cwd);
    }
    default:
      return { ok: false, error: `Unknown git kind: ${kind}` };
  }
}
