import { test, expect, type APIRequestContext } from '@playwright/test';
import { spawn, execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Live Computer Agent verification: spawns the REAL agent service, pairs it,
// and drives supervised jobs through the control plane. Cleans up afterwards
// (revoke + kill) so prototype.spec.ts always sees demo mode.
test.describe.configure({ mode: 'serial' });

const SERVER = 'http://localhost:3100';
const REPO = process.cwd();

let agent: ChildProcess | null = null;
let deviceId = '';

function agentEnv(project: string) {
  const home = path.join(REPO, 'test-results', `agent-home-${project}`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return { ...process.env, APPDATA: home, WORKSPACE_ROOT: path.join(REPO, 'workspace') };
}

function runPair(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('node', ['agent/pair.mjs', '--server', SERVER], { cwd: REPO, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pair failed: ${stderr || error.message}`));
        return;
      }
      const match = stdout.match(/Pairing code:\s*([A-Z2-9]{8})/);
      if (!match) {
        reject(new Error(`no pairing code in output: ${stdout}`));
        return;
      }
      resolve(match[1]);
    });
  });
}

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await request.fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    data: body,
  });
  let json = {} as T;
  try {
    json = (await response.json()) as T;
  } catch {
    // Non-JSON error pages still carry the status code.
  }
  return { status: response.status(), json };
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 45000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function jobById(request: APIRequestContext, id: string) {
  const { json } = await api<{ jobs: Array<{ id: string; status: string; result?: { ok: boolean; output?: string; error?: string } }> }>(request, 'GET', '/api/control/jobs?limit=50');
  return json.jobs.find(job => job.id === id) || null;
}

test.beforeAll(async ({ request }, testInfo) => {
  const env = agentEnv(testInfo.project.name);
  const code = await runPair(env);
  const claimed = await api<{ deviceId: string }>(request, 'POST', '/api/control/pair', { code });
  expect(claimed.status).toBe(200);
  deviceId = claimed.json.deviceId;
  agent = spawn('node', ['agent/src/index.mjs', '--server', SERVER], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout?.resume();
  agent.stderr?.resume();
  await waitFor('agent online', async () => {
    const { json } = await api<{ devices: Array<{ deviceId: string; online: boolean }> }>(request, 'GET', '/api/control/devices');
    const device = json.devices.find(d => d.deviceId === deviceId);
    return device?.online ? device : null;
  });
});

test.afterAll(async ({ request }) => {
  try {
    if (deviceId) await api(request, 'POST', '/api/control/revoke', { deviceId });
    await api(request, 'POST', '/api/control/resume', {});
  } finally {
    agent?.kill();
    agent = null;
  }
});

test('live inspection completes on the workstation and is audited', async ({ request }) => {
  const created = await api<{ job: { id: string } }>(request, 'POST', '/api/control/jobs', { kind: 'fs.list', params: { path: '.' } });
  expect(created.status).toBe(200);
  const job = await waitFor('inspection completion', async () => {
    const found = await jobById(request, created.json.job.id);
    return found && (found.status === 'completed' || found.status === 'failed') ? found : null;
  });
  expect(job.status).toBe('completed');
  expect(job.result?.output).toContain('package.json');
  const { json } = await api<{ events: Array<{ action: string; permission: string; target: string }> }>(request, 'GET', '/api/control/audit?limit=100');
  const completed = json.events.find(e => e.action === 'job.completed' && e.target === job.id);
  expect(completed?.permission).toBe('filesystem.read');
});

test('gated command requires approval, runs once, and cannot be replayed', async ({ request }) => {
  const denied = await api<{ error: string; needsApproval: boolean }>(request, 'POST', '/api/control/jobs', { kind: 'term.exec', params: { command: 'npm test', cwd: '.' } });
  expect(denied.status).toBe(403);
  expect(denied.json.needsApproval).toBe(true);
  const approval = await api<{ approval: { id: string } }>(request, 'POST', '/api/control/approvals', {
    title: 'Run sandbox test suite', kind: 'term.exec',
    params: { command: 'npm test', cwd: '.' }, reason: 'Verify the sandbox project.',
  });
  expect(approval.status).toBe(200);
  const decided = await api<{ approval: { status: string }; jobId: string }>(request, 'POST', `/api/control/approvals/${approval.json.approval.id}/decide`, { decision: 'approved' });
  expect(decided.json.approval.status).toBe('approved');
  const job = await waitFor('test-run completion', async () => {
    const found = await jobById(request, decided.json.jobId);
    return found && (found.status === 'completed' || found.status === 'failed') ? found : null;
  });
  expect(job.status).toBe('completed');
  expect(job.result?.output).toMatch(/pass 2/);
  const replay = await api(request, 'POST', '/api/control/jobs', { kind: 'term.exec', params: { command: 'npm test', cwd: '.' }, approvalId: approval.json.approval.id });
  expect(replay.status).toBe(403);
});

test('destructive command is denied before execution and recorded', async ({ request }) => {
  const before = await api<{ jobs: Array<{ id: string }> }>(request, 'GET', '/api/control/jobs?limit=100');
  const denied = await api<{ jobId: string }>(request, 'POST', '/api/control/jobs', { kind: 'term.exec', params: { command: 'Remove-Item C:\\Windows -Recurse' } });
  expect(denied.status).toBe(403);
  expect(denied.json.jobId).toBeDefined();
  const after = await api<{ jobs: Array<{ id: string; status: string }> }>(request, 'GET', '/api/control/jobs?limit=100');
  const record = after.json.jobs.find(job => !before.json.jobs.some(b => b.id === job.id));
  // Refused before execution, kept as a terminal denied record — never dispatched.
  expect(record?.status).toBe('denied');
  expect(record?.id).toBe(denied.json.jobId);
  const { json } = await api<{ events: Array<{ action: string; target: string }> }>(request, 'GET', '/api/control/audit?limit=100');
  expect(json.events.some(e => e.action === 'job.rejected' && e.target === 'term.exec')).toBe(true);
});

test('emergency stop holds dispatch until resumed', async ({ request }) => {
  const stopped = await api<{ stopped: boolean }>(request, 'POST', '/api/control/stop', { cancelQueued: true });
  expect(stopped.json.stopped).toBe(true);
  const created = await api<{ job: { id: string } }>(request, 'POST', '/api/control/jobs', { kind: 'fs.list', params: { path: '.' } });
  expect(created.status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 6000));
  const held = await jobById(request, created.json.job.id);
  // Held, not lost and not executed.
  expect(held?.status).toBe('queued');
  const resumed = await api<{ stopped: boolean; released: number }>(request, 'POST', '/api/control/resume', {});
  expect(resumed.json.stopped).toBe(false);
  expect(resumed.json.released).toBeGreaterThanOrEqual(1);
  const released = await waitFor('resumed job completion', async () => {
    const found = await jobById(request, created.json.job.id);
    return found && (found.status === 'completed' || found.status === 'failed') ? found : null;
  });
  expect(released.status).toBe('completed');
});

test('idempotent enqueue returns the same job', async ({ request }) => {
  const key = `e2e-${Date.now()}`;
  const first = await api<{ job: { id: string }; deduped: boolean }>(request, 'POST', '/api/control/jobs', { kind: 'fs.list', params: { path: '.' }, idempotencyKey: key });
  const second = await api<{ job: { id: string }; deduped: boolean }>(request, 'POST', '/api/control/jobs', { kind: 'fs.list', params: { path: '.' }, idempotencyKey: key });
  expect(first.json.job.id).toBe(second.json.job.id);
  expect(second.json.deduped).toBe(true);
});

test('paths outside authorized roots are refused', async ({ request }) => {
  const pinned = await api(request, 'POST', '/api/control/jobs', { kind: 'fs.list', params: { path: '.', root: 'C:\\evil' } });
  expect(pinned.status).toBe(400);
  const traversal = await api(request, 'POST', '/api/control/jobs', { kind: 'fs.read', params: { path: '..\\..\\Windows\\win.ini' } });
  expect([400, 403]).toContain(traversal.status);
});

test('credential rotation invalidates the old secret', async ({ request }, testInfo) => {
  const home = path.join(REPO, 'test-results', `agent-home-${testInfo.project.name}`, 'waves-one-agent', 'identity.json');
  const identity = JSON.parse(fs.readFileSync(home, 'utf8')) as { deviceId: string; secret: string };
  const oldAuth = `Bearer ${identity.deviceId}.${identity.secret}`;
  const rotated = await request.fetch(`${SERVER}/api/agent/rotate`, {
    method: 'POST',
    headers: { authorization: oldAuth },
  });
  expect(rotated.ok()).toBe(true);
  const { secret } = (await rotated.json()) as { secret: string };
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  // Old credential dies immediately.
  const stale = await request.fetch(`${SERVER}/api/agent/flags`, {
    headers: { authorization: oldAuth },
  });
  expect(stale.status()).toBe(401);
  // Restart the agent on the rotated credential; it comes back online.
  agent?.kill();
  const rotatedHome = path.join(REPO, 'test-results', `agent-home-${testInfo.project.name}-rotated`);
  const rotatedIdentity = path.join(rotatedHome, 'waves-one-agent', 'identity.json');
  fs.rmSync(rotatedHome, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(rotatedIdentity), { recursive: true });
  fs.writeFileSync(rotatedIdentity, JSON.stringify({ ...identity, secret }, null, 2));
  const env = { ...process.env, APPDATA: rotatedHome, WORKSPACE_ROOT: path.join(REPO, 'workspace') };
  agent = spawn('node', ['agent/src/index.mjs', '--server', SERVER], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout?.resume();
  agent.stderr?.resume();
  await waitFor('agent online after rotation', async () => {
    const { json } = await api<{ devices: Array<{ deviceId: string; online: boolean }> }>(request, 'GET', '/api/control/devices');
    const device = json.devices.find(d => d.deviceId === deviceId);
    return device?.online ? device : null;
  });
});

async function approveKind(request: APIRequestContext, title: string, kind: string, params: Record<string, unknown>): Promise<string> {
  const approval = await api<{ approval: { id: string } }>(request, 'POST', '/api/control/approvals', { title, kind, params, reason: 'E2E browser verification.' });
  expect(approval.status).toBe(200);
  const decided = await api<{ approval: { status: string }; jobId: string }>(request, 'POST', `/api/control/approvals/${approval.json.approval.id}/decide`, { decision: 'approved' });
  expect(decided.json.jobId).toBeDefined();
  const job = await waitFor(`${title} completion`, async () => {
    const found = await jobById(request, decided.json.jobId);
    return found && ['completed', 'failed'].includes(found.status) ? found : null;
  }, 60000);
  expect(job.status).toBe('completed');
  return decided.json.jobId;
}

test('browser automation runs offline with screenshots as artifacts', async ({ request }) => {
  const page = 'data:text/html,<html><body><h1 id="t">waves check</h1><button id="b">Go</button><input id="q" type="text"></body></html>';
  await approveKind(request, 'browser open', 'browser.open', { url: page });
  await approveKind(request, 'browser click', 'browser.click', { selector: '#b' });
  await approveKind(request, 'browser type', 'browser.type', { selector: '#q', text: 'hello waves' });
  await approveKind(request, 'browser screenshot', 'browser.screenshot', { fullPage: false });
  const extractId = await (async () => {
    const approval = await api<{ approval: { id: string } }>(request, 'POST', '/api/control/approvals', {
      title: 'browser extract', kind: 'browser.extract', params: { selector: '#t' }, reason: 'E2E browser verification.',
    });
    const decided = await api<{ approval: { status: string }; jobId: string }>(request, 'POST', `/api/control/approvals/${approval.json.approval.id}/decide`, { decision: 'approved' });
    return decided.json.jobId;
  })();
  const extract = await waitFor('extract completion', async () => {
    const found = await jobById(request, extractId);
    return found && ['completed', 'failed'].includes(found.status) ? found : null;
  }, 60000);
  expect(extract?.status).toBe('completed');
  expect(extract?.result?.output).toContain('waves check');
  const { json } = await api<{ artifacts: Array<{ id: string; name: string; jobId?: string }> }>(request, 'GET', '/api/control/artifacts?limit=50');
  expect(json.artifacts.some(a => a.name.endsWith('.png'))).toBe(true);
});

test('device panel shows the live workstation', async ({ page }) => {
  await page.goto('/');
  const entered = page.getByRole('button', { name: 'Enter WAVES ONE' });
  try {
    await entered.click({ timeout: 8000 });
  } catch {
    // Already entered (persistent session); continue.
  }
  await expect(page.getByRole('heading', { name: 'Good morning, Amey.' })).toBeVisible();
  const desktop = page.getByRole('navigation', { name: 'Primary', exact: true });
  if (await desktop.isVisible()) {
    await desktop.getByRole('button', { name: /^AI/ }).click();
  } else {
    await page.getByRole('navigation', { name: 'Primary mobile' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^AI/ }).click();
  }
  await expect(page.getByText(os.hostname(), { exact: false }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: /STOP ALL/ })).toBeVisible();
});
