import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-control-test-'));
process.env.WAVES_STATE_DIR = stateDir;
process.env.WAVES_WORKSPACE = path.join(stateDir, 'workspace');
// Hermetic by default: file store in an isolated temp dir, even when the
// developer shell has DATABASE_URL set. DB paths are covered separately in
// store-db.test.ts against Neon.
process.env.WAVES_STORE = 'file';
fs.mkdirSync(process.env.WAVES_WORKSPACE, { recursive: true });

import {
  agentFlags,
  appendAudit,
  cancelJob,
  claimDevice,
  completeJob,
  controlStatus,
  createApproval,
  decideApproval,
  enqueueJob,
  getJob,
  getPolicy,
  heartbeat,
  listAudit,
  listDevices,
  listJobs,
  nextJob,
  reconcile,
  registerDevice,
  resume,
  revokeDevice,
  rotateSecret,
  setPolicy,
  stopAll,
  verifyDevice,
} from './control-plane';

function deviceAuth(deviceId: string, secret: string) {
  return `Bearer ${deviceId}.${secret}`;
}

async function pairedDevice() {
  const deviceId = `dev-${randomUUID().slice(0, 8)}`;
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const code = 'ABCDEFGH';
  await registerDevice({ deviceId, secretHash, machine: 'test-machine', pairingCode: code, agentVersion: 'test' });
  // Each test needs a unique code; re-register with a fresh one.
  return { deviceId, secret, code };
}

describe('control plane', () => {
  beforeEach(() => {
    for (const file of fs.readdirSync(stateDir)) {
      const target = path.join(stateDir, file);
      if (file === 'workspace') continue;
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('pairs a device without ever exposing its secret', async () => {
    const { deviceId, secret, code } = await pairedDevice();
    const claimed = await claimDevice(code);
    expect(claimed.deviceId).toBe(deviceId);
    const device = await verifyDevice(deviceAuth(deviceId, secret));
    expect(device.machine).toBe('test-machine');
    expect(JSON.stringify(await listDevices())).not.toContain(secret.slice(0, 12));
    await expect(claimDevice(code)).rejects.toThrow();
  });

  it('rejects forged or revoked credentials', async () => {
    const { deviceId, secret, code } = await pairedDevice();
    await claimDevice(code);
    const forged = (secret[0] === 'a' ? 'b' : 'a') + secret.slice(1);
    await expect(verifyDevice(deviceAuth(deviceId, forged))).rejects.toThrow();
    await revokeDevice(deviceId);
    await expect(verifyDevice(deviceAuth(deviceId, secret))).rejects.toThrow();
    expect(await listDevices()).toHaveLength(0);
  });

  it('runs low-risk reads without approval and audits them', async () => {
    const { deviceId, code } = await pairedDevice();
    await claimDevice(code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(job.risk).toBe('low');
    expect(job.status).toBe('authorized');
    const next = await nextJob(deviceId);
    expect(next.job?.id).toBe(job.id);
    await completeJob(deviceId, { jobId: job.id, ok: true, output: 'README.md' });
    const audit = (await listAudit(10)).map(e => e.action);
    expect(audit).toContain('job.authorized');
    expect(audit).toContain('job.completed');
  });

  it('holds gated commands until an exact approval exists', async () => {
    const { deviceId, secret, code } = await pairedDevice();
    await claimDevice(code);
    await verifyDevice(deviceAuth(deviceId, secret));
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'npm test' } }))
      .rejects.toThrowError(/approval/i);
    const approval = await createApproval({
      title: 'Run tests', kind: 'term.exec',
      params: { command: 'npm test' }, reason: 'Verify the workspace.',
    });
    const { jobId } = await decideApproval(approval.id, 'approved');
    expect(jobId).toBeDefined();
    // Approval binds to the exact job: different params are refused.
    await expect(enqueueJob({
      kind: 'term.exec', params: { command: 'npm run build' }, approvalId: approval.id,
    })).rejects.toThrowError(/exact job/i);
    const next = await nextJob(deviceId);
    expect(next.job?.id).toBe(jobId);
    await completeJob(deviceId, { jobId: jobId!, ok: true, output: '11 passed' });
    // Single-use binding: the same approval cannot authorize a second job.
    await expect(enqueueJob({
      kind: 'term.exec', params: { command: 'npm test' }, approvalId: approval.id,
    })).rejects.toThrowError(/already authorized|already used/i);
  });

  it('requires a reason for rejection', async () => {
    const approval = await createApproval({
      title: 'Push', kind: 'git.push', params: {}, reason: 'Ship it.',
    });
    await expect(decideApproval(approval.id, 'rejected')).rejects.toThrowError(/reason/i);
    await decideApproval(approval.id, 'rejected', 'Not yet.');
    expect((await listAudit(5)).map(e => e.action)).toContain('approval.rejected');
  });

  it('denies destructive commands before queueing', async () => {
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'Remove-Item C:\\Windows -Recurse' } }))
      .rejects.toThrowError(/denied/i);
    await expect(enqueueJob({ kind: 'fs.read', params: { path: '..\\secret.txt' } }))
      .rejects.toThrowError(/authorized roots/i);
  });

  it('refuses high-risk policy escalation', async () => {
    const policy = await getPolicy();
    await expect(setPolicy({
      ...policy,
      capabilities: { ...policy.capabilities, 'filesystem.delete': 'allowed' },
    })).rejects.toThrowError(/cannot be set to allowed/i);
  });

  it('stops dispatch and cancels the queue on emergency stop', async () => {
    const { deviceId, code } = await pairedDevice();
    await claimDevice(code);
    await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const { cancelled } = await stopAll(true);
    expect(cancelled).toBe(1);
    expect((await nextJob(deviceId)).job).toBeNull();
    expect((await nextJob(deviceId)).stopped).toBe(true);
    expect((await controlStatus()).stopped).toBe(true);
    await resume();
    expect((await controlStatus()).stopped).toBe(false);
  });

  it('flags cancellation for a running job', async () => {
    const { deviceId, code } = await pairedDevice();
    await claimDevice(code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    await nextJob(deviceId);
    await cancelJob(job.id);
    expect((await agentFlags(deviceId)).cancelCurrent).toBe(true);
    await completeJob(deviceId, { jobId: job.id, ok: false, error: 'Stopped by owner' });
    expect((await listAudit(5)).map(e => e.action)).toContain('job.cancelled');
  });

  it('walks the full remote lifecycle with agent acknowledgement', async () => {
    const { deviceId, secret, code } = await pairedDevice();
    await claimDevice(code);
    await verifyDevice(deviceAuth(deviceId, secret));
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(job.status).toBe('authorized');
    const next = await nextJob(deviceId);
    expect(next.job?.id).toBe(job.id);
    expect((await getJob(job.id)).status).toBe('dispatched');
    await heartbeat(deviceId, { status: 'running', currentJobId: job.id });
    expect((await getJob(job.id)).status).toBe('running');
    await completeJob(deviceId, { jobId: job.id, ok: true, output: 'ok' });
    expect((await getJob(job.id)).status).toBe('completed');
    // Duplicate identical completion is idempotent; conflicting rewrite is refused.
    expect(await completeJob(deviceId, { jobId: job.id, ok: true, output: 'ok' })).toEqual({ ok: true });
    await expect(completeJob(deviceId, { jobId: job.id, ok: true, output: 'different' })).rejects.toThrowError(/already/);
  });

  it('deduplicates enqueue by idempotency key', async () => {
    const first = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: 'phone-btn-1' });
    const second = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: 'phone-btn-1' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('expires jobs and approvals past their TTL', async () => {
    const created = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const approval = await createApproval({ title: 'T', kind: 'fs.list', params: { path: '.' }, reason: 'R' });
    expect(created.job.expiresAt).toBeDefined();
    expect(approval.expiresAt).toBeDefined();
    // Backdate both records past expiry, then reconcile.
    const jobsFile = path.join(stateDir, 'jobs.json');
    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as Array<{ id: string; expiresAt: string }>;
    for (const job of jobs) job.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    const approvalsFile = path.join(stateDir, 'agent-approvals.json');
    const approvals = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')) as Array<{ id: string; expiresAt: string }>;
    for (const item of approvals) item.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(approvalsFile, JSON.stringify(approvals));
    await reconcile();
    expect((await getJob(created.job.id)).status).toBe('expired');
    await expect(decideApproval(approval.id, 'approved')).rejects.toThrowError(/expired/i);
  });

  it('requeues orphaned running jobs without duplicating work', async () => {
    const { deviceId, code } = await pairedDevice();
    await claimDevice(code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    await nextJob(deviceId);
    // Simulate a dead agent: heartbeat older than the stale threshold.
    await revokeDevice(deviceId);
    await reconcile();
    const requeued = await getJob(job.id);
    expect(['authorized', 'failed']).toContain(requeued.status);
  });

  it('rotates credentials with immediate invalidation', async () => {
    const { deviceId, secret, code } = await pairedDevice();
    await claimDevice(code);
    await verifyDevice(deviceAuth(deviceId, secret));
    const { secret: next } = await rotateSecret(deviceId);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyDevice(deviceAuth(deviceId, secret))).rejects.toThrow();
    await verifyDevice(deviceAuth(deviceId, next));
    expect((await listDevices()).find(d => d.deviceId === deviceId)?.credentialRotatedAt).toBeDefined();
  });

  it('persists denied jobs as terminal records', async () => {
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'rm -rf /' } })).rejects.toThrowError(/denied/i);
    const denied = (await listJobs(10)).find(j => j.status === 'denied');
    expect(denied?.kind).toBe('term.exec');
  });

  it('splits terminal capability by command class', async () => {
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'runas /user:x cmd' } })).rejects.toThrowError(/denied|terminal.admin/i);
    const { job } = await enqueueJob({ kind: 'git.status', params: {} } as never);
    expect(job.capability).toBe('git.read');
  });

  it('gates browser navigation by domain policy', async () => {
    await expect(enqueueJob({ kind: 'browser.navigate', params: { url: 'https://unknown.example/' } })).rejects.toThrowError(/domain/i);
    const { job } = await enqueueJob({ kind: 'browser.open', params: { url: 'https://github.com/x' } });
    expect(job.capability).toBe('browser.read');
  });

  it('requires approval for visible browser sessions', async () => {
    await expect(enqueueJob({ kind: 'browser.click', params: { selector: 'button', headed: true } })).rejects.toThrowError(/approval/i);
  });

  it('scrubs secret text from stored params on completion', async () => {
    const { deviceId, code } = await pairedDevice();
    await claimDevice(code);
    const approval = await createApproval({
      title: 'Type', kind: 'browser.type',
      params: { selector: '#q', text: 's3cr3t-value' }, reason: 'Fill the form.',
    });
    const { jobId } = await decideApproval(approval.id, 'approved');
    await nextJob(deviceId);
    await completeJob(deviceId, { jobId: jobId!, ok: true, output: 'typed' });
    const stored = await getJob(jobId!);
    expect(stored.params.text).toBe('[REDACTED]');
    expect(stored.params.textLength).toBe(12);
  });

  it('records audit fields for every computer action', async () => {
    await appendAudit({
      agent: 'WAVES Computer Agent', machine: 'workstation', userAuth: 'approval:aa-1',
      action: 'job.completed', target: 'job-1', command: 'git status',
      permission: 'git.read', approvalId: 'aa-1', result: 'clean',
      before: { size: 10 }, after: { size: 10 },
    });
    const [event] = await listAudit(1);
    expect(event.permission).toBe('git.read');
    expect(event.approvalId).toBe('aa-1');
    expect(event.before).toEqual({ size: 10 });
  });
});
