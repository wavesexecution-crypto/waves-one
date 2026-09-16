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
  getPolicy,
  listAudit,
  listDevices,
  nextJob,
  registerDevice,
  resume,
  revokeDevice,
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
    const job = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(job.risk).toBe('low');
    const next = nextJob(deviceId);
    expect(next.job?.id).toBe(job.id);
    completeJob(deviceId, { jobId: job.id, ok: true, output: 'README.md' });
    const audit = listAudit(10).map(e => e.action);
    expect(audit).toContain('job.queued');
    expect(audit).toContain('job.completed');
  });

  it('holds gated commands until an exact approval exists', () => {    const { deviceId, secret, code } = pairedDevice();
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
      .toThrowError(/sandbox/i);
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
    const job = enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    nextJob(deviceId);
    cancelJob(job.id);
    expect(agentFlags(deviceId).cancelCurrent).toBe(true);
    completeJob(deviceId, { jobId: job.id, ok: false, error: 'Stopped by owner' });
    expect(listAudit(5).map(e => e.action)).toContain('job.cancelled');
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
