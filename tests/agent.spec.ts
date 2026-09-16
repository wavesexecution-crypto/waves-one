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

test('destructive command is denied before queueing and audited', async ({ request }) => {
  const before = await api<{ jobs: Array<{ id: string }> }>(request, 'GET', '/api/control/jobs?limit=100');
  const denied = await api(request, 'POST', '/api/control/jobs', { kind: 'term.exec', params: { command: 'Remove-Item C:\\Windows -Recurse' } });
  expect(denied.status).toBe(403);
  const after = await api<{ jobs: Array<{ id: string }> }>(request, 'GET', '/api/control/jobs?limit=100');
  expect(after.json.jobs.length).toBe(before.json.jobs.length);
  const { json } = await api<{ events: Array<{ action: string; target: string }> }>(request, 'GET', '/api/control/audit?limit=100');
  expect(json.events.some(e => e.action === 'job.rejected' && e.target === 'term.exec')).toBe(true);
});

test('emergency stop halts dispatch until resumed', async ({ request }) => {
  const stopped = await api<{ stopped: boolean }>(request, 'POST', '/api/control/stop', { cancelQueued: true });
  expect(stopped.json.stopped).toBe(true);
  const created = await api<{ job: { id: string } }>(request, 'POST', '/api/control/jobs', { kind: 'fs.list', params: { path: '.' } });
  expect(created.status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 6000));
  const held = await jobById(request, created.json.job.id);
  expect(held?.status).toBe('queued');
  await api(request, 'POST', '/api/control/resume', {});
  const released = await waitFor('resumed job completion', async () => {
    const found = await jobById(request, created.json.job.id);
    return found && (found.status === 'completed' || found.status === 'failed') ? found : null;
  });
  expect(released.status).toBe('completed');
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
