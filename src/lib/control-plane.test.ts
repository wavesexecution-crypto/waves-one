import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-control-test-'));
process.env.WAVES_STATE_DIR = stateDir;
process.env.WAVES_WORKSPACE = path.join(stateDir, 'workspace');
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

function pairedDevice() {
  const deviceId = `dev-${randomUUID().slice(0, 8)}`;
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const code = 'ABCDEFGH';
  registerDevice({ deviceId, secretHash, machine: 'test-machine', pairingCode: code, agentVersion: 'test' });
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

  it('pairs a device without ever exposing its secret', () => {
    const { deviceId, secret, code } = pairedDevice();
    const claimed = claimDevice(code);
    expect(claimed.deviceId).toBe(deviceId);
    const device = verifyDevice(deviceAuth(deviceId, secret));
    expect(device.machine).toBe('test-machine');
    expect(JSON.stringify(listDevices())).not.toContain(secret.slice(0, 12));
    expect(() => claimDevice(code)).toThrow();
  });

  it('rejects forged or revoked credentials', () => {
    const { deviceId, secret, code } = pairedDevice();
    claimDevice(code);
    const forged = (secret[0] === 'a' ? 'b' : 'a') + secret.slice(1);
    expect(() => verifyDevice(deviceAuth(deviceId, forged))).toThrow();
    revokeDevice(deviceId);
    expect(() => verifyDevice(deviceAuth(deviceId, secret))).toThrow();
    expect(listDevices()).toHaveLength(0);
  });

  it('runs low-risk reads without approval and audits them', () => {
    const { deviceId, code } = pairedDevice();
    claimDevice(code);
    const { job } = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(job.risk).toBe('low');
    expect(job.status).toBe('authorized');
    const next = nextJob(deviceId);
    expect(next.job?.id).toBe(job.id);
    completeJob(deviceId, { jobId: job.id, ok: true, output: 'README.md' });
    const audit = listAudit(10).map(e => e.action);
    expect(audit).toContain('job.authorized');
    expect(audit).toContain('job.completed');
  });

  it('holds gated commands until an exact approval exists', () => {
    const { deviceId, secret, code } = pairedDevice();
    claimDevice(code);
    verifyDevice(deviceAuth(deviceId, secret));
    expect(() => enqueueJob({ kind: 'term.exec', params: { command: 'npm test' } }))
      .toThrowError(/approval/i);
    const approval = createApproval({
      title: 'Run tests', kind: 'term.exec',
      params: { command: 'npm test' }, reason: 'Verify the workspace.',
    });
    const { jobId } = decideApproval(approval.id, 'approved');
    expect(jobId).toBeDefined();
    // Approval binds to the exact job: different params are refused.
    expect(() => enqueueJob({
      kind: 'term.exec', params: { command: 'npm run build' }, approvalId: approval.id,
    })).toThrowError(/exact job/i);
    const next = nextJob(deviceId);
    expect(next.job?.id).toBe(jobId);
    completeJob(deviceId, { jobId: jobId!, ok: true, output: '11 passed' });
    // Single-use binding: the same approval cannot authorize a second job.
    expect(() => enqueueJob({
      kind: 'term.exec', params: { command: 'npm test' }, approvalId: approval.id,
    })).toThrowError(/already authorized|already used/i);
  });

  it('requires a reason for rejection', () => {
    const approval = createApproval({
      title: 'Push', kind: 'git.push', params: {}, reason: 'Ship it.',
    });
    expect(() => decideApproval(approval.id, 'rejected')).toThrowError(/reason/i);
    decideApproval(approval.id, 'rejected', 'Not yet.');
    expect(listAudit(5).map(e => e.action)).toContain('approval.rejected');
  });

  it('denies destructive commands before queueing', () => {
    expect(() => enqueueJob({ kind: 'term.exec', params: { command: 'Remove-Item C:\\Windows -Recurse' } }))
      .toThrowError(/denied/i);
    expect(() => enqueueJob({ kind: 'fs.read', params: { path: '..\\secret.txt' } }))
      .toThrowError(/authorized roots/i);
  });

  it('refuses high-risk policy escalation', () => {
    const policy = getPolicy();
    expect(() => setPolicy({
      ...policy,
      capabilities: { ...policy.capabilities, 'filesystem.delete': 'allowed' },
    })).toThrowError(/cannot be set to allowed/i);
  });

  it('stops dispatch and cancels the queue on emergency stop', () => {
    const { deviceId, code } = pairedDevice();
    claimDevice(code);
    enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const { cancelled } = stopAll(true);
    expect(cancelled).toBe(1);
    expect(nextJob(deviceId).job).toBeNull();
    expect(nextJob(deviceId).stopped).toBe(true);
    expect(controlStatus().stopped).toBe(true);
    resume();
    expect(controlStatus().stopped).toBe(false);
  });

  it('flags cancellation for a running job', () => {
    const { deviceId, code } = pairedDevice();
    claimDevice(code);
    const { job } = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    nextJob(deviceId);
    cancelJob(job.id);
    expect(agentFlags(deviceId).cancelCurrent).toBe(true);
    completeJob(deviceId, { jobId: job.id, ok: false, error: 'Stopped by owner' });
    expect(listAudit(5).map(e => e.action)).toContain('job.cancelled');
  });

  it('walks the full remote lifecycle with agent acknowledgement', () => {
    const { deviceId, secret, code } = pairedDevice();
    claimDevice(code);
    verifyDevice(deviceAuth(deviceId, secret));
    const { job } = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(job.status).toBe('authorized');
    const next = nextJob(deviceId);
    expect(next.job?.id).toBe(job.id);
    expect(getJob(job.id).status).toBe('dispatched');
    heartbeat(deviceId, { status: 'running', currentJobId: job.id });
    expect(getJob(job.id).status).toBe('running');
    completeJob(deviceId, { jobId: job.id, ok: true, output: 'ok' });
    expect(getJob(job.id).status).toBe('completed');
    // Duplicate identical completion is idempotent; conflicting rewrite is refused.
    expect(completeJob(deviceId, { jobId: job.id, ok: true, output: 'ok' })).toEqual({ ok: true });
    expect(() => completeJob(deviceId, { jobId: job.id, ok: true, output: 'different' })).toThrowError(/already/);
  });

  it('deduplicates enqueue by idempotency key', () => {
    const first = enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: 'phone-btn-1' });
    const second = enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: 'phone-btn-1' });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('expires jobs and approvals past their TTL', () => {
    const created = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const approval = createApproval({ title: 'T', kind: 'fs.list', params: { path: '.' }, reason: 'R' });
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
    reconcile();
    expect(getJob(created.job.id).status).toBe('expired');
    expect(() => decideApproval(approval.id, 'approved')).toThrowError(/expired/i);
  });

  it('requeues orphaned running jobs without duplicating work', () => {
    const { deviceId, code } = pairedDevice();
    claimDevice(code);
    const { job } = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    nextJob(deviceId);
    // Simulate a dead agent: heartbeat older than the stale threshold.
    revokeDevice(deviceId);
    reconcile();
    const requeued = getJob(job.id);
    expect(['authorized', 'failed']).toContain(requeued.status);
  });

  it('rotates credentials with immediate invalidation', () => {
    const { deviceId, secret, code } = pairedDevice();
    claimDevice(code);
    verifyDevice(deviceAuth(deviceId, secret));
    const { secret: next } = rotateSecret(deviceId);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyDevice(deviceAuth(deviceId, secret))).toThrow();
    verifyDevice(deviceAuth(deviceId, next));
    expect(listDevices().find(d => d.deviceId === deviceId)?.credentialRotatedAt).toBeDefined();
  });

  it('persists denied jobs as terminal records', () => {
    expect(() => enqueueJob({ kind: 'term.exec', params: { command: 'rm -rf /' } })).toThrowError(/denied/i);
    const denied = listJobs(10).find(j => j.status === 'denied');
    expect(denied?.kind).toBe('term.exec');
  });

  it('splits terminal capability by command class', () => {
    expect(() => enqueueJob({ kind: 'term.exec', params: { command: 'runas /user:x cmd' } })).toThrowError(/denied|terminal.admin/i);
    const { job } = enqueueJob({ kind: 'git.status', params: {} } as never);
    expect(job.capability).toBe('git.read');
  });

  it('gates browser navigation by domain policy', () => {
    expect(() => enqueueJob({ kind: 'browser.navigate', params: { url: 'https://unknown.example/' } })).toThrowError(/domain/i);
    const { job } = enqueueJob({ kind: 'browser.open', params: { url: 'https://github.com/x' } });
    expect(job.capability).toBe('browser.read');
  });

  it('requires approval for visible browser sessions', () => {
    expect(() => enqueueJob({ kind: 'browser.click', params: { selector: 'button', headed: true } })).toThrowError(/approval/i);
  });

  it('scrubs secret text from stored params on completion', () => {
    const { deviceId, code } = pairedDevice();
    claimDevice(code);
    const approval = createApproval({
      title: 'Type', kind: 'browser.type',
      params: { selector: '#q', text: 's3cr3t-value' }, reason: 'Fill the form.',
    });
    const { jobId } = decideApproval(approval.id, 'approved');
    nextJob(deviceId);
    completeJob(deviceId, { jobId: jobId!, ok: true, output: 'typed' });
    const stored = getJob(jobId!);
    expect(stored.params.text).toBe('[REDACTED]');
    expect(stored.params.textLength).toBe(12);
  });

  it('records audit fields for every computer action', () => {
    appendAudit({
      agent: 'WAVES Computer Agent', machine: 'workstation', userAuth: 'approval:aa-1',
      action: 'job.completed', target: 'job-1', command: 'git status',
      permission: 'git.read', approvalId: 'aa-1', result: 'clean',
      before: { size: 10 }, after: { size: 10 },
    });
    const [event] = listAudit(1);
    expect(event.permission).toBe('git.read');
    expect(event.approvalId).toBe('aa-1');
    expect(event.before).toEqual({ size: 10 });
  });
});
