// Git executor: status/log/diff are low risk; commit/push/pull/branch/checkout
// and github.issue/github.pr (via gh) need approval. Every command runs inside
// the sandbox and the cwd must be a git repo. Returns stderr separately.
import { spawn } from 'node:child_process';
import { resolveAcrossRoots, redactSecrets } from '../policy.mjs';
import { refuseOutsideRoot } from './fs.mjs';

const REF_PATTERN = /^[A-Za-z0-9_./-]+$/;

function getRoots(ctx) {
  if (Array.isArray(ctx?.roots) && ctx.roots.length) return ctx.roots;
  return [ctx.workspaceRoot];
}

function validRef(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && REF_PATTERN.test(value);
}

function runCapture(bin, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, startError: e.message }));
    child.on('close', (code) => resolve({ ok: true, code, out, err }));
  });
}

function shapeResult(r, successNote) {
  if (r.startError !== undefined && !r.ok) {
    return { ok: false, error: `git failed to start: ${r.startError}` };
  }
  const stdout = redactSecrets(r.out || '');
  const stderr = r.err ? redactSecrets(r.err) : undefined;
  if (r.code === 0) {
    const result = { ok: true, output: stdout.trim() ? stdout : (successNote || '(no output)'), exitCode: 0 };
    if (stderr && stderr.trim()) result.stderr = stderr;
    return result;
  }
  const result = {
    ok: false,
    error: `git exited with code ${r.code}`,
    output: stdout.trim() ? stdout : undefined,
    exitCode: r.code ?? undefined,
  };
  if (stderr && stderr.trim()) result.stderr = stderr;
  return result;
}

function shapeGhResult(r) {
  if (r.startError !== undefined && !r.ok) {
    const missing = /ENOENT/i.test(r.startError);
    if (missing) {
      return { ok: false, error: 'Refused: gh CLI is not installed or not on PATH; install GitHub CLI to use github.issue/github.pr' };
    }
    return { ok: false, error: `gh failed to start: ${r.startError}` };
  }
  const stdout = redactSecrets(r.out || '');
  const stderr = r.err ? redactSecrets(r.err) : undefined;
  if (r.code === 0) {
    const result = { ok: true, output: stdout.trim() ? stdout : '(no output)', exitCode: 0 };
    if (stderr && stderr.trim()) result.stderr = stderr;
    return result;
  }
  // gh not found at runtime surfaces as exit code + "'gh' is not recognized".
  if (/not recognized|not found|ENOENT/i.test(`${r.out} ${r.err}`)) {
    return { ok: false, error: 'Refused: gh CLI is not installed or not on PATH; install GitHub CLI to use github.issue/github.pr' };
  }
  const result = {
    ok: false,
    error: `gh exited with code ${r.code}`,
    output: stdout.trim() ? stdout : undefined,
    exitCode: r.code ?? undefined,
  };
  if (stderr && stderr.trim()) result.stderr = stderr;
  return result;
}

async function ghAvailable() {
  const r = await runCapture('gh', ['--version'], getRoots({ workspaceRoot: process.cwd() })[0]);
  if (r.startError !== undefined && !r.ok) return false;
  if (r.code !== 0) {
    if (/not recognized|not found|ENOENT/i.test(`${r.out} ${r.err}`)) return false;
  }
  return r.code === 0;
}

export async function execGit(kind, params, ctx) {
  const p = params && typeof params === 'object' ? params : {};
  let cwd = getRoots(ctx)[0];
  let cwdRoot = cwd;
  const rawCwd = p.cwd ?? p.path;
  if (rawCwd !== undefined) {
    const hit = typeof rawCwd === 'string' ? resolveAcrossRoots(getRoots(ctx), rawCwd, p.root) : null;
    if (!hit) return { ok: false, error: 'cwd escapes sandbox' };
    const linkRefusal = await refuseOutsideRoot(hit.root, hit.path, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
    cwd = hit.path;
    cwdRoot = hit.root;
  } else {
    const linkRefusal = await refuseOutsideRoot(cwdRoot, cwd, 'working directory');
    if (linkRefusal) return { ok: false, error: `Refused: ${linkRefusal}` };
  }

  const needApproval = (what) => {
    if (!ctx.approvalId) return { ok: false, error: `${what} requires an approved approvalId` };
    return null;
  };

  switch (kind) {
    case 'git.status':
    case 'git.log':
    case 'git.diff':
    case 'git.commit':
    case 'git.push':
    case 'git.pull':
    case 'git.branch':
    case 'git.checkout': {
      const repo = await runCapture('git', ['rev-parse', '--is-inside-work-tree'], cwd);
      if (repo.code !== 0) return { ok: false, error: `Not a git repository: ${cwd}` };
      break;
    }
    case 'github.issue':
    case 'github.pr':
      break;
    default:
      return { ok: false, error: `Unknown git kind: ${kind}` };
  }

  switch (kind) {
    case 'git.status':
      return shapeResult(await runCapture('git', ['status', '--short', '--branch'], cwd));
    case 'git.log': {
      const n = Math.min(Math.max(Number(p.n ?? 20) || 20, 1), 100);
      return shapeResult(await runCapture('git', ['log', '--oneline', `-${n}`], cwd));
    }
    case 'git.diff': {
      const args = ['diff'];
      if (p.ref !== undefined) {
        if (!validRef(p.ref)) return { ok: false, error: 'Invalid ref' };
        args.push(p.ref);
      }
      return shapeResult(await runCapture('git', args, cwd));
    }
    case 'git.commit': {
      const denied = needApproval('git.commit');
      if (denied) return denied;
      if (typeof p.message !== 'string' || !p.message.trim()) {
        return { ok: false, error: 'git.commit requires a message' };
      }
      return shapeResult(await runCapture('git', ['commit', '-m', p.message], cwd));
    }
    case 'git.push': {
      const denied = needApproval('git.push');
      if (denied) return denied;
      const args = ['push'];
      for (const key of ['remote', 'branch']) {
        if (p[key] !== undefined) {
          if (!validRef(p[key])) return { ok: false, error: `Invalid ${key}` };
          args.push(p[key]);
        }
      }
      return shapeResult(await runCapture('git', args, cwd));
    }
    case 'git.pull': {
      const denied = needApproval('git.pull');
      if (denied) return denied;
      const args = ['pull', '--ff-only'];
      for (const key of ['remote', 'branch']) {
        if (p[key] !== undefined) {
          if (!validRef(p[key])) return { ok: false, error: `Invalid ${key}` };
          args.push(p[key]);
        }
      }
      return shapeResult(await runCapture('git', args, cwd));
    }
    case 'git.branch': {
      const denied = needApproval('git.branch');
      if (denied) return denied;
      if (p.name !== undefined) {
        if (!validRef(p.name)) return { ok: false, error: 'Invalid branch name' };
        const args = ['branch', p.name];
        if (p.startPoint !== undefined) {
          if (!validRef(p.startPoint)) return { ok: false, error: 'Invalid start point' };
          args.push(p.startPoint);
        }
        return shapeResult(await runCapture('git', args, cwd));
      }
      return shapeResult(await runCapture('git', ['branch', '--list'], cwd));
    }
    case 'git.checkout': {
      const denied = needApproval('git.checkout');
      if (denied) return denied;
      const name = p.ref ?? p.branch ?? p.name;
      if (!validRef(name)) return { ok: false, error: 'git.checkout requires a valid branch/ref name' };
      return shapeResult(await runCapture('git', ['checkout', name], cwd));
    }
    case 'github.issue': {
      const denied = needApproval('github.issue');
      if (denied) return denied;
      if (!(await ghAvailable())) {
        return { ok: false, error: 'Refused: gh CLI is not installed or not on PATH; install GitHub CLI to use github.issue/github.pr' };
      }
      if (typeof p.title !== 'string' || !p.title.trim()) {
        return { ok: false, error: 'github.issue requires a title' };
      }
      const args = ['issue', 'create', '--title', p.title];
      if (p.body !== undefined) {
        if (typeof p.body !== 'string') return { ok: false, error: 'Invalid body' };
        args.push('--body', p.body);
      }
      if (p.repo !== undefined) {
        if (!validRef(p.repo)) return { ok: false, error: 'Invalid repo' };
        args.push('--repo', p.repo);
      }
      return shapeGhResult(await runCapture('gh', args, cwd));
    }
    case 'github.pr': {
      const denied = needApproval('github.pr');
      if (denied) return denied;
      if (!(await ghAvailable())) {
        return { ok: false, error: 'Refused: gh CLI is not installed or not on PATH; install GitHub CLI to use github.issue/github.pr' };
      }
      if (typeof p.title !== 'string' || !p.title.trim()) {
        return { ok: false, error: 'github.pr requires a title' };
      }
      const args = ['pr', 'create', '--title', p.title];
      if (p.body !== undefined) {
        if (typeof p.body !== 'string') return { ok: false, error: 'Invalid body' };
        args.push('--body', p.body);
      }
      for (const [flag, key] of [['--head', 'head'], ['--base', 'base'], ['--repo', 'repo']]) {
        if (p[key] !== undefined) {
          if (!validRef(p[key])) return { ok: false, error: `Invalid ${key}` };
          args.push(flag, p[key]);
        }
      }
      return shapeGhResult(await runCapture('gh', args, cwd));
    }
    default:
      return { ok: false, error: `Unknown git kind: ${kind}` };
  }
}
