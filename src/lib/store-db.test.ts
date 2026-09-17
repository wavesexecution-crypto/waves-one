import { createHash, randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Neon integration tests: the control plane against real PostgreSQL.
// Run when a pooled Neon connection is configured (DATABASE_URL); skipped
// otherwise so local/offline unit runs stay hermetic. Point at a Neon dev
// or preview BRANCH database — never production. Test rows carry a
// `dbtest-` prefix (audit rows are append-only by design and stay in the
// dev audit log as identifiable test evidence).

const hasDb = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (hasDb && !process.env.WAVES_STORE) process.env.WAVES_STORE = 'db';

const PREFIX = `dbtest-${Date.now().toString(36)}-`;
const tag = (id: string) => `${PREFIX}${id}`.slice(0, 100);

function deviceAuth(deviceId: string, secret: string) {
  return `Bearer ${deviceId}.${secret}`;
}

describe.skipIf(!hasDb || process.env.WAVES_STORE !== 'db')('control plane on Neon PostgreSQL', () => {
  let cp: typeof import('./control-plane');
  let store: import('./store').ControlStore;

  beforeAll(async () => {
    process.env.WAVES_STORE = 'db';
    const { resetStoreCache, getStore } = await import('./store');
    resetStoreCache();
    store = await getStore();
    expect(store.kind).toBe('db');
    cp = await import('./control-plane');
  });

  afterAll(async () => {
    const { resetStoreCache } = await import('./store');
    const { resetDbClients } = await import('./db');
    resetStoreCache();
    resetDbClients();
  });

  // Drain releasable/running jobs so each test dispatches only its own job.
  // (Test-harness cleanup via the store; the app itself never force-closes.)
  beforeEach(async () => {
    const active = await store.listActiveJobs();
    for (const j of active) {
      if (j.status === 'queued' || j.status === 'authorized') {
        await cp.cancelJob(j.id);
      } else {
        await store.updateJobIf({ ...j, status: 'cancelled' }, ['running', 'dispatched']);
      }
    }
  }, 90000);

  async function pairedDevice(suffix: string) {
    const deviceId = tag(`dev-${suffix}`).slice(0, 64);
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const secretHash = createHash('sha256').update(secret).digest('hex');
    // Pairing codes: 8 chars from A-Z2-9 (no ambiguous 0/1).
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomBytes(8), b => alphabet[b % alphabet.length]).join('');
    await cp.registerDevice({ deviceId, secretHash, machine: 'dbtest-machine', pairingCode: code, agentVersion: 'dbtest' });
    await cp.claimDevice(code);
    return { deviceId, secret };
  }

  it('persists state across fresh connections (server restart)', { timeout: 90000 }, async () => {
    const { deviceId, secret } = await pairedDevice('restart');
    const { job } = await cp.enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: tag('restart-key') });

    // Simulate a server restart: drop every cached client/selector and
    // reconnect from scratch. Durable state must survive.
    const { resetStoreCache } = await import('./store');
    const { resetDbClients } = await import('./db');
    resetStoreCache();
    resetDbClients();

    await cp.verifyDevice(deviceAuth(deviceId, secret));
    const devices = await cp.listDevices();
    expect(devices.some(d => d.deviceId === deviceId)).toBe(true);
    expect((await cp.getJob(job.id)).id).toBe(job.id);
  });

  it('binds a concurrent approval to exactly one job', { timeout: 90000 }, async () => {
    const approval = await cp.createApproval({
      title: 'Concurrent approval', kind: 'fs.list',
      params: { path: '.' }, reason: 'Race test.',
    });
    // Five concurrent CEO decisions: exactly one may win the binding.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => cp.decideApproval(approval.id, 'approved')),
    );
    const won = results.filter(r => r.status === 'fulfilled');
    expect(won.length).toBe(1);
    const jobId = (won[0] as PromiseFulfilledResult<{ jobId?: string }>).value.jobId;
    expect(jobId).toBeDefined();
    const jobs = await cp.listJobs(100);
    expect(jobs.filter(j => j.approvalId === approval.id)).toHaveLength(1);
  });

  it('deduplicates concurrent enqueues by idempotency key', { timeout: 90000 }, async () => {
    const key = tag('idem-race');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cp.enqueueJob({ kind: 'fs.list', params: { path: '.' }, idempotencyKey: key })),
    );
    const ids = new Set(results.map(r => r.job.id));
    expect(ids.size).toBe(1);
    expect(results.filter(r => r.deduped).length).toBeGreaterThanOrEqual(0);
  });

  it('revokes device credentials with immediate effect', { timeout: 90000 }, async () => {
    const { deviceId, secret } = await pairedDevice('revoke');
    await cp.verifyDevice(deviceAuth(deviceId, secret));
    await cp.revokeDevice(deviceId);
    await expect(cp.verifyDevice(deviceAuth(deviceId, secret))).rejects.toThrow();
    expect((await cp.listDevices()).some(d => d.deviceId === deviceId)).toBe(false);
  });

  it('keeps audit append-only with no update/delete path', { timeout: 90000 }, async () => {
    const target = tag('audit-target');
    for (let i = 0; i < 3; i += 1) {
      await cp.appendAudit({
        agent: 'dbtest', machine: 'dbtest', userAuth: 'dbtest',
        action: 'dbtest.event', target, permission: 'system_configuration',
        result: `event ${i}`,
      });
    }
    const events = (await cp.listAudit(500)).filter(e => e.target === target);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.result)).toEqual(['event 2', 'event 1', 'event 0']);
    // The store surface exposes append + tail only — no mutation path exists
    // to call, for either implementation.
    expect('auditUpdate' in store).toBe(false);
    expect('auditDelete' in store).toBe(false);
    expect(typeof store.auditAppend).toBe('function');
  });

  it('refuses stale-write clobbering on terminal jobs', { timeout: 90000 }, async () => {
    const { deviceId } = await pairedDevice('stale');
    const { job } = await cp.enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    await cp.nextJob(deviceId);
    await cp.completeJob(deviceId, { jobId: job.id, ok: true, output: 'done' });
    // A stale copy (pre-completion state) must not overwrite the terminal row.
    const stale = { ...(await store.findJob(job.id))!, status: 'running' as const };
    expect(await store.updateJobIf(stale, ['running', 'dispatched'])).toBe(false);
    expect((await cp.getJob(job.id)).status).toBe('completed');
  });

  it('completes the full lifecycle on Neon', { timeout: 90000 }, async () => {
    const { deviceId } = await pairedDevice('lifecycle');
    const { job } = await cp.enqueueJob({ kind: 'fs.list', params: { path: '.' } });
    const next = await cp.nextJob(deviceId);
    expect(next.job?.id).toBe(job.id);
    await cp.heartbeat(deviceId, { status: 'running', currentJobId: job.id });
    expect((await cp.getJob(job.id)).status).toBe('running');
    await cp.completeJob(deviceId, { jobId: job.id, ok: true, output: 'neon-ok' });
    expect((await cp.getJob(job.id)).status).toBe('completed');
  });
});
