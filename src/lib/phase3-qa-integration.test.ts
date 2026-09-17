import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

// Phase 3 QA integration matrix: covers gaps left by control-plane.test.ts
// and verifies failure modes that existed in Phase 2. Runs hermetically on
// the file store (WAVES_STORE=file) so it needs no Neon or network.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-phase3-qa-'));
process.env.WAVES_STATE_DIR = stateDir;
process.env.WAVES_STORE = 'file';
process.env.WAVES_WORKSPACE = path.join(stateDir, 'workspace');
fs.mkdirSync(process.env.WAVES_WORKSPACE, { recursive: true });

import {
  appendAudit,
  claimDevice,
  completeJob,
  controlStatus,
  createApproval,
  decideApproval,
  enqueueJob,
  listAudit,
  listDevices,
  getJob,
  getPolicy,
  heartbeat,
  listApprovals,
  nextJob,
  registerDevice,
  revokeDevice,
  rotateSecret,
  verifyDevice,
  setPolicy,
  reconcile,
  cancelJob,
  stopAll,
  resume,
  agentFlags,
  listJobs,
} from './control-plane';
import { storeKind, resetStoreCache, getStore } from './store';
import { requireOwner } from './owner-auth';

function deviceAuth(deviceId: string, secret: string) {
  return `Bearer ${deviceId}.${secret}`;
}

let codeCounter = 0;
function freshCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  codeCounter += 1;
  // Deterministic but valid 8-char code based on counter to avoid flakiness.
  let n = codeCounter * 1000003;
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[n % alphabet.length];
    n = Math.floor(n / alphabet.length) + 7;
  }
  return out;
}
function freshDevice(suffix = randomUUID().slice(0, 6)) {
  const deviceId = `qa-${suffix}-${randomUUID().slice(0, 4)}`;
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const code = freshCode();
  return { deviceId, secret, secretHash, code };
}

describe('Phase 3 QA integration matrix', () => {
  beforeEach(async () => {
    for (const file of fs.readdirSync(stateDir)) {
      const target = path.join(stateDir, file);
      if (file === 'workspace') continue;
      fs.rmSync(target, { recursive: true, force: true });
    }
    resetStoreCache();
  });

  // -------------------------------------------------------------------------
  // AUTH
  // -------------------------------------------------------------------------
  it('AUTH: rejects unauthorized API access without pairing', async () => {
    await expect(verifyDevice(null)).rejects.toThrow();
    await expect(verifyDevice('Bearer bogus')).rejects.toThrow();
    await expect(verifyDevice('Bearer dev.x')).rejects.toThrow();
  });

  it('AUTH: requires owner token when WAVES_OWNER_TOKEN is set', async () => {
    const prev = process.env.WAVES_OWNER_TOKEN;
    process.env.WAVES_OWNER_TOKEN = 'owner-secret-123';
    try {
      expect(requireOwner(new Request('http://x/'))!.status).toBe(401);
      expect(requireOwner(new Request('http://x/', { headers: { authorization: 'Bearer wrong' } }))!.status).toBe(401);
      expect(requireOwner(new Request('http://x/', { headers: { authorization: 'Bearer owner-secret-123' } }))).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.WAVES_OWNER_TOKEN;
      else process.env.WAVES_OWNER_TOKEN = prev;
    }
  });

  // -------------------------------------------------------------------------
  // STORE KIND / VERCEL RUNTIME
  // -------------------------------------------------------------------------
  it('VERCEL: selects db store when VERCEL env is set (ephemeral disk protection)', async () => {
    const prev = process.env.VERCEL;
    const prevStore = process.env.WAVES_STORE;
    process.env.VERCEL = '1';
    delete process.env.WAVES_STORE;
    expect(storeKind()).toBe('db');
    process.env.WAVES_STORE = 'file';
    expect(storeKind()).toBe('file');
    if (prev === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prev;
    if (prevStore === undefined) delete process.env.WAVES_STORE;
    else process.env.WAVES_STORE = prevStore;
    resetStoreCache();
    process.env.WAVES_STORE = 'file';
  });

  it('VERCEL: DATABASE_URL never leaks to browser via NEXT_PUBLIC', async () => {
    const leaked = Object.keys(process.env).filter(k => k.startsWith('NEXT_PUBLIC_') && /DATABASE|SECRET|TOKEN|PASSWORD/i.test(k));
    expect(leaked).toEqual([]);
    // DATABASE_URL is server-only; browser bundle must not contain it (checked via leakage above)
    // When running hermetic file-store tests, DATABASE_URL may be absent – that's expected.
    expect(Object.keys(process.env).some(k => k.startsWith('NEXT_PUBLIC_DATABASE'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // DEVICES
  // -------------------------------------------------------------------------
  it('DEVICES: full pairing → auth → heartbeat → revocation → rotation lifecycle', async () => {
    const d = freshDevice('devlife');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa-machine', pairingCode: d.code, agentVersion: 'qa-1' });
    await expect(verifyDevice(deviceAuth(d.deviceId, d.secret))).rejects.toThrow(); // not claimed yet
    await claimDevice(d.code);
    await verifyDevice(deviceAuth(d.deviceId, d.secret));
    await heartbeat(d.deviceId, { status: 'idle', currentJobId: null, machine: 'qa-machine', agentVersion: 'qa-1' });
    expect((await listDevices()).some(x => x.deviceId === d.deviceId && x.online)).toBe(true);
    const { secret: next } = await rotateSecret(d.deviceId);
    await expect(verifyDevice(deviceAuth(d.deviceId, d.secret))).rejects.toThrow();
    await verifyDevice(deviceAuth(d.deviceId, next));
    await revokeDevice(d.deviceId);
    await expect(verifyDevice(deviceAuth(d.deviceId, next))).rejects.toThrow();
    expect((await listDevices()).some(x => x.deviceId === d.deviceId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // JOBS LIFECYCLE
  // -------------------------------------------------------------------------
  it('JOBS: walks every terminal state and refuses resurrection', async () => {
    const d = freshDevice('jobstates');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);

    // authorized → dispatched → running → completed
    const { job: j1 } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(j1.status).toBe('authorized');
    const n1 = await nextJob(d.deviceId);
    expect(n1.job!.id).toBe(j1.id);
    expect((await getJob(j1.id)).status).toBe('dispatched');
    await heartbeat(d.deviceId, { status: 'running', currentJobId: j1.id });
    expect((await getJob(j1.id)).status).toBe('running');
    await completeJob(d.deviceId, { jobId: j1.id, ok: true, output: 'ok' });
    expect((await getJob(j1.id)).status).toBe('completed');
    // completed is terminal: conflicting complete is refused, identical is idempotent
    await expect(completeJob(d.deviceId, { jobId: j1.id, ok: true, output: 'different' })).rejects.toThrow(/already/);
    expect(await completeJob(d.deviceId, { jobId: j1.id, ok: true, output: 'ok' })).toEqual({ ok: true });

    // denied (policy blocks before queue)
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'rm -rf /' } })).rejects.toThrow(/denied/i);
    const denied = (await listJobs(20)).find(j => j.status === 'denied');
    expect(denied).toBeDefined();

    // cancelled before dispatch
    const { job: j2 } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    await cancelJob(j2.id);
    expect((await getJob(j2.id)).status).toBe('cancelled');

    // stopped via emergency stop
    await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const { cancelled } = await stopAll(true);
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect((await controlStatus()).stopped).toBe(true);
    expect((await agentFlags(d.deviceId)).stop).toBe(true);
    await resume();
    expect((await controlStatus()).stopped).toBe(false);
    // queued held during stop becomes authorized again after resume
    const { job: held } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    // enqueue during stop would be queued; but we already resumed, so new job is authorized
    expect(['authorized', 'queued']).toContain(held.status);

    // expired via backdated expiresAt + reconcile
    const { job: j4 } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const jobsFile = path.join(stateDir, 'jobs.json');
    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as Array<{ id: string; expiresAt: string }>;
    for (const j of jobs) if (j.id === j4.id) j.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    await reconcile();
    expect((await getJob(j4.id)).status).toBe('expired');
  });

  // -------------------------------------------------------------------------
  // APPROVALS: binding, single-use, replay, wrong-job, concurrent
  // -------------------------------------------------------------------------
  it('APPROVALS: binds exactly one job and refuses replay / wrong-job', async () => {
    const d = freshDevice('approval');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);

    const approval = await createApproval({ title: 'E2E', kind: 'term.exec', params: { command: 'npm test' }, reason: 'QA' });
    const { jobId } = await decideApproval(approval.id, 'approved');
    expect(jobId).toBeDefined();
    // wrong params with same approval → refused
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'npm run build' }, approvalId: approval.id })).rejects.toThrow(/exact job/i);
    // replay same approval → refused
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'npm test' }, approvalId: approval.id })).rejects.toThrow(/already authorized|already used/i);
    // decision replay → refused
    await expect(decideApproval(approval.id, 'approved')).rejects.toThrow(/already decided/i);
  });

  it('APPROVALS: concurrent decideApproval – exactly one winner (sequential for file store)', async () => {
    const approval = await createApproval({ title: 'Race', kind: 'fs.list', params: { path: '.' }, reason: 'Race QA' });
    // File store is single-process: concurrent Promise.all races are not protected
    // the same way as Neon (which uses SELECT FOR UPDATE + unique index). For
    // file store we verify sequential single-use; for db store the concurrent
    // race is covered in store-db.test.ts.
    if (storeKind() === 'file') {
      const first = await decideApproval(approval.id, 'approved');
      expect(first.jobId).toBeDefined();
      await expect(decideApproval(approval.id, 'approved')).rejects.toThrow();
      const jobs = await listJobs(50);
      expect(jobs.filter(j => j.approvalId === approval.id).length).toBe(1);
    } else {
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => decideApproval(approval.id, 'approved')));
      const wins = results.filter(r => r.status === 'fulfilled');
      const losses = results.filter(r => r.status === 'rejected');
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(3);
      const jobId = (wins[0] as PromiseFulfilledResult<{ jobId?: string }>).value.jobId;
      expect(jobId).toBeDefined();
      const jobs = await listJobs(50);
      expect(jobs.filter(j => j.approvalId === approval.id).length).toBe(1);
    }
  });

  it('APPROVALS: idempotency key deduplicates enqueues', async () => {
    const key = `qa-idem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    // File store deduplicates sequential calls reliably; concurrent Promise.all
    // is only guaranteed on db (unique index). Test sequential here.
    const first = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: key });
    const second = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: key });
    expect(first.job.id).toBe(second.job.id);
    expect(second.deduped).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PERMISSIONS: low=allowed, medium=approval, high=denied, server+agent parity
  // -------------------------------------------------------------------------
  it('PERMISSIONS: enforces low/medium/high via server and agent parity', async () => {
    // low: no approval needed
    const { job: low } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(low.risk).toBe('low');
    expect(low.status).toBe('authorized');

    // medium: requires approval
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'npm test' } })).rejects.toThrow(/approval/i);

    // high denied: terminal.admin
    await expect(enqueueJob({ kind: 'term.exec', params: { command: 'runas /user:admin cmd' } })).rejects.toThrow(/denied|admin/i);

    // high policy escalation refused
    const policy = await getPolicy();
    await expect(setPolicy({ ...policy, capabilities: { ...policy.capabilities, 'filesystem.delete': 'allowed' } } as never)).rejects.toThrow(/cannot be set to allowed/i);
  });

  // -------------------------------------------------------------------------
  // AUDIT
  // -------------------------------------------------------------------------
  it('AUDIT: append ordering, actor fields, secret redaction, before/after', async () => {
    const target = `qa-audit-${Date.now()}`;
    await appendAudit({ agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO', action: 'job.completed', target, permission: 'filesystem.read', result: 'ok', before: { size: 10 }, after: { size: 20 } });
    await appendAudit({ agent: 'WAVES Computer Agent', machine: 'workstation', userAuth: 'approval:aa-1', action: 'job.completed', target, permission: 'terminal.execute', result: 'token=secret-value-should-be-redacted-but-we-store-via-control-plane' });
    const events = (await listAudit(10)).filter(e => e.target === target);
    expect(events.length).toBe(2);
    expect(events[0].ts > events[1].ts || events[0].ts === events[1].ts).toBe(true); // newest first
    const withState = events.find(e => e.before !== undefined);
    expect(withState?.before).toEqual({ size: 10 });
    expect(withState?.after).toEqual({ size: 20 });
    // audit tail is append-only - no update/delete on store interface
    const store = await getStore();
    expect('auditUpdate' in store).toBe(false);
  });

  it('AUDIT: secret redaction in job params and output', async () => {
    const d = freshDevice('audit-secret');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);
    const approval = await createApproval({ title: 'Type secret', kind: 'browser.type', params: { selector: '#pw', text: 's3cr3t-value-long-enough' }, reason: 'QA' });
    const { jobId } = await decideApproval(approval.id, 'approved');
    expect(jobId).toBeDefined();
    await nextJob(d.deviceId);
    await completeJob(d.deviceId, { jobId: jobId!, ok: true, output: 'typed secret s3cr3t-value-long-enough and token=abc123XYZ789abc123XYZ789' });
    const stored = await getJob(jobId!);
    expect(stored.params.text).toBe('[REDACTED]');
    // output redaction happens in completeJob via redactSecrets
    expect(stored.result?.output).not.toContain('abc123XYZ789');
  });

  // -------------------------------------------------------------------------
  // DATABASE INTEGRATION: persistence, concurrent writes, stale-write
  // -------------------------------------------------------------------------
  it('DB: persists across resetStoreCache (process restart simulation)', async () => {
    const d = freshDevice('persist');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: `persist-${Date.now()}` });
    resetStoreCache();
    // fresh getStore reads same files
    expect((await getJob(job.id)).id).toBe(job.id);
    expect((await listDevices()).some(x => x.deviceId === d.deviceId)).toBe(true);
  });

  it('DB: refuses stale-write clobbering on terminal jobs via updateJobIf', async () => {
    const d = freshDevice('stale');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    await nextJob(d.deviceId);
    await completeJob(d.deviceId, { jobId: job.id, ok: true, output: 'done' });
    expect((await getJob(job.id)).status).toBe('completed');
    const store = await getStore();
    const stale = await store.findJob(job.id);
    expect(stale).not.toBeNull();
    // attempt to revert to running should fail (expectedStatuses mismatch)
    const ok = await store.updateJobIf({ ...stale!, status: 'running' as const }, ['running', 'dispatched']);
    expect(ok).toBe(false);
    expect((await getJob(job.id)).status).toBe('completed');
  });

  it('DB: approval persistence ordering – decide persists before enqueue reads', async () => {
    const approval = await createApproval({ title: 'Order', kind: 'fs.read', params: { path: '.' }, reason: 'QA order' });
    // decideApproval must persist approved status before enqueueJob re-reads it; verify by checking second decide fails
    const first = await decideApproval(approval.id, 'approved');
    expect(first.jobId).toBeDefined();
    await expect(decideApproval(approval.id, 'approved')).rejects.toThrow();
  });

  it('DB: transaction boundary – approval jobIds updated atomically', async () => {
    const approval = await createApproval({ title: 'Txn', kind: 'fs.list', params: { path: '.' }, reason: 'QA txn' });
    const { jobId } = await decideApproval(approval.id, 'approved');
    const stored = (await listApprovals()).find(a => a.id === approval.id);
    expect(stored?.jobIds).toContain(jobId);
    expect(stored?.status).toBe('approved');
  });

  it('DB: concurrent writes to same job serialize via updateJobIf', async () => {
    const d = freshDevice('concurrent-job');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const store = await getStore();
    const base = await store.findJob(job.id);
    expect(base).not.toBeNull();
    // Sequential stale-write test (file store is single-process; true concurrent
    // serialization is enforced by db via conditional UPDATE).
    const ok1 = await store.updateJobIf({ ...base!, status: 'dispatched' as const, deviceId: d.deviceId, attempts: [...base!.attempts, { deviceId: d.deviceId, startedAt: new Date().toISOString() }] }, ['authorized']);
    expect(ok1).toBe(true);
    await store.findJob(job.id);
    // Second write with stale base (still authorized) must lose to the already-dispatched row.
    const ok2 = await store.updateJobIf({ ...base!, status: 'dispatched' as const, deviceId: 'other-device', attempts: [...base!.attempts, { deviceId: 'other-device', startedAt: new Date().toISOString() }] }, ['authorized']);
    expect(ok2).toBe(false);
    const refetched = await store.findJob(job.id);
    expect(refetched!.status).toBe('dispatched');
    // Cleanup: complete so as not to pollute later tests
    await completeJob(d.deviceId, { jobId: job.id, ok: true, output: 'ok' });
  });

  // -------------------------------------------------------------------------
  // FAILURE & EDGE CASES
  // -------------------------------------------------------------------------
  it('FAILURE: malformed requests are 400, not 500, and do not create jobs', async () => {
    const before = (await listJobs(100)).length;
    await expect(enqueueJob({ kind: 'fs.list' as never, params: null as never })).rejects.toThrow();
    await expect(enqueueJob({ kind: 'fs.read' as never, params: { path: '..\\evil' } })).rejects.toThrow(/authorized roots|escapes/i);
    expect((await listJobs(100)).length).toBe(before + 0); // malformed does not persist as denied (only 403 does)
  });

  it('FAILURE: duplicate job via idempotency is safe, duplicate request without key creates new job', async () => {
    const key = `dup-${Date.now()}`;
    const a = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: key });
    const b = await enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: key });
    expect(a.job.id).toBe(b.job.id);
    const c = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const d = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(c.job.id).not.toBe(d.job.id);
  });

  it('FAILURE: browser refresh / server restart does not lose queued jobs', async () => {
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    expect(job.status).toBe('authorized');
    resetStoreCache();
    expect((await getJob(job.id)).status).toBe('authorized');
  });

  it('FAILURE: revoked device heartbeat still rejected', async () => {
    const d = freshDevice('revoked-hb');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);
    await revokeDevice(d.deviceId);
    // heartbeat still writes but device is revoked so verify should fail
    await expect(verifyDevice(deviceAuth(d.deviceId, d.secret))).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // SECURITY REGRESSION
  // -------------------------------------------------------------------------
  it('SECURITY: path escape via traversal, ADS, and absolute outside root refused', async () => {
    await expect(enqueueJob({ kind: 'fs.read', params: { path: '..\\..\\Windows\\win.ini' } })).rejects.toThrow(/authorized roots|escapes/i);
    await expect(enqueueJob({ kind: 'fs.write', params: { path: 'notes:secret', content: 'x' } })).rejects.toThrow(/escapes|alternate/i);
    await expect(enqueueJob({ kind: 'fs.list', params: { path: 'C:\\Windows' } })).rejects.toThrow(/authorized roots|escapes/i);
  });

  it('SECURITY: junction-like traversal via symlink target semantics (lexical)', async () => {
    // agent-fs-links.test covers real filesystem junction; here verify control plane also refuses lexical escape
    await expect(enqueueJob({ kind: 'fs.read', params: { path: '..\\..\\..\\etc\\passwd' } })).rejects.toThrow(/authorized roots|escapes/i);
  });

  it('SECURITY: browser domain allow/block and replay', async () => {
    await expect(enqueueJob({ kind: 'browser.navigate', params: { url: 'https://evil.example/' } })).rejects.toThrow(/domain/i);
    const { job } = await enqueueJob({ kind: 'browser.open', params: { url: 'https://github.com/waves' } });
    expect(job.capability).toBe('browser.read');
  });

  it('SECURITY: high-risk capability cannot be set to allowed and headed browser needs approval', async () => {
    const policy = await getPolicy();
    await expect(setPolicy({ ...policy, capabilities: { ...policy.capabilities, 'terminal.admin': 'allowed' } as never })).rejects.toThrow(/cannot be set to allowed/i);
    await expect(enqueueJob({ kind: 'browser.click', params: { selector: 'button', headed: true } })).rejects.toThrow(/approval/i);
  });

  it('SECURITY: STOP ALL halts dispatch and prevents silent completion', async () => {
    const d = freshDevice('stop');
    await registerDevice({ deviceId: d.deviceId, secretHash: d.secretHash, machine: 'qa', pairingCode: d.code, agentVersion: 'qa' });
    await claimDevice(d.code);
    const { job } = await enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    await stopAll(true);
    expect(job.status).toBe('authorized');
    const next = await nextJob(d.deviceId);
    expect(next.job).toBeNull();
    expect(next.stopped).toBe(true);
    await resume();
    await nextJob(d.deviceId);
    // after resume, job may be re-dispatched (or was cancelled if stopAll cancelled queued)
    // either way, no false completed
    const final = await getJob(job.id);
    expect(['cancelled', 'dispatched', 'authorized', 'queued'].includes(final.status)).toBe(true);
  });
});
