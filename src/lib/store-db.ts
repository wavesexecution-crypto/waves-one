import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ArtifactMeta } from './agent-protocol';
import { db, onDbReset } from './db';
import * as s from './db-schema';
import type {
  AgentApproval,
  AuditRecord,
  ControlFlags,
  DeviceRecord,
  JobRecord,
  JobStatus,
  PairingCode,
  Policy,
} from './control-plane-types';
import type { ControlStore, IdemValue, RateHit } from './store';
import { StoreConflict } from './store';

// Neon PostgreSQL store: the production source of truth.
//
// Concurrency contract:
// - Hot rows (jobs, approvals, devices) are locked with SELECT .. FOR UPDATE
//   inside runInTransaction before any read-modify-write, so concurrent
//   requests serialize instead of clobbering.
// - Single-use approvals and idempotency keys additionally carry partial
//   unique indexes (jobs_approval_single_use_idx, jobs_idempotency_idx,
//   approvals_idempotency_idx): even a missed lock fails loudly as a
//   23505 conflict, mapped to StoreConflict, never a silent double-bind.
// - Status transitions outside transactions use conditional UPDATEs
//   (updateJobIf / updateApprovalIf): losers get `false` and must re-read,
//   never overwrite.
// - audit_events, job_attempts, and artifacts_meta have no UPDATE/DELETE
//   paths here by design (append-only). job_attempts rows are completed via
//   a targeted ended_at/outcome write on the open row only — history rows are
//   never modified or removed.

type Exec = NodePgDatabase<typeof s>;

// Drizzle wraps driver failures (message "Failed query: ...", original as
// `.cause`), so walk the chain instead of trusting the top-level shape.
function dbErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === '23505' || code === '40P01') return code as string;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function dbConstraint(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && constraint) return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return 'unique';
}

function isUniqueViolation(error: unknown): string | null {
  return dbErrorCode(error) === '23505' ? dbConstraint(error) : null;
}

function conflict(error: unknown, what: string): Error {
  const constraint = isUniqueViolation(error);
  if (constraint) return new StoreConflict(`${what} conflicts with existing state (${constraint}).`);
  throw error;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const reqIso = (d: Date): string => d.toISOString();
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function toDevice(r: typeof s.devices.$inferSelect): DeviceRecord {
  return {
    deviceId: r.deviceId,
    secretHash: r.secretHash,
    machine: r.machine,
    agentVersion: r.agentVersion,
    paired: r.paired,
    revoked: r.revoked,
    createdAt: reqIso(r.createdAt),
    credentialRotatedAt: iso(r.credentialRotatedAt),
    lastHeartbeat: iso(r.lastHeartbeat),
    currentJobId: r.currentJobId,
    status: r.status === 'running' ? 'running' : 'idle',
    ...(r.lastTelemetry ? { lastTelemetry: r.lastTelemetry as DeviceRecord['lastTelemetry'] } : {}),
  };
}

function toJob(r: typeof s.jobs.$inferSelect): JobRecord {
  return {
    id: r.id,
    kind: r.kind as JobRecord['kind'],
    params: asRecord(r.params),
    capability: r.capability,
    risk: r.risk,
    ...(r.approvalId ? { approvalId: r.approvalId } : {}),
    ...(r.goalId ? { goalId: r.goalId } : {}),
    ...(r.idempotencyKey ? { idempotencyKey: r.idempotencyKey } : {}),
    requestedBy: r.requestedBy,
    ...(r.deviceId ? { deviceId: r.deviceId } : {}),
    createdAt: reqIso(r.createdAt),
    expiresAt: reqIso(r.expiresAt),
    status: r.status as JobRecord['status'],
    ...(r.authorizedAt ? { authorizedAt: reqIso(r.authorizedAt) } : {}),
    ...(r.cancelRequested ? { cancelRequested: true } : {}),
    attempts: (Array.isArray(r.attempts) ? r.attempts : []) as JobRecord['attempts'],
    ...(r.result ? { result: r.result as JobRecord['result'] } : {}),
  };
}

function toApproval(r: typeof s.approvals.$inferSelect): AgentApproval {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as AgentApproval['kind'],
    params: asRecord(r.params),
    reason: r.reason,
    ...(r.goalId ? { goalId: r.goalId } : {}),
    ...(r.idempotencyKey ? { idempotencyKey: r.idempotencyKey } : {}),
    status: r.status as AgentApproval['status'],
    createdBy: r.createdBy,
    createdAt: reqIso(r.createdAt),
    expiresAt: reqIso(r.expiresAt),
    ...(r.decidedAt ? { decidedAt: reqIso(r.decidedAt) } : {}),
    ...(r.note ? { note: r.note } : {}),
    jobIds: (Array.isArray(r.jobIds) ? r.jobIds : []) as string[],
  };
}

function toAudit(r: typeof s.auditEvents.$inferSelect): AuditRecord {
  return {
    ts: reqIso(r.ts),
    agent: r.agent,
    machine: r.machine,
    userAuth: r.userAuth,
    ...(r.application ? { application: r.application } : {}),
    action: r.action,
    target: r.target,
    ...(r.command ? { command: r.command } : {}),
    permission: r.permission,
    ...(r.approvalId ? { approvalId: r.approvalId } : {}),
    result: r.result,
    ...(r.error ? { error: r.error } : {}),
    ...(r.before !== null && r.before !== undefined ? { before: r.before } : {}),
    ...(r.after !== null && r.after !== undefined ? { after: r.after } : {}),
  };
}

function jobColumns(j: JobRecord) {
  return {
    id: j.id,
    kind: j.kind,
    params: j.params,
    capability: j.capability,
    risk: j.risk,
    approvalId: j.approvalId ?? null,
    goalId: j.goalId ?? null,
    idempotencyKey: j.idempotencyKey ?? null,
    requestedBy: j.requestedBy,
    deviceId: j.deviceId ?? null,
    createdAt: new Date(j.createdAt),
    expiresAt: new Date(j.expiresAt),
    status: j.status,
    authorizedAt: j.authorizedAt ? new Date(j.authorizedAt) : null,
    cancelRequested: !!j.cancelRequested,
    attempts: j.attempts,
    result: j.result ?? null,
  };
}

function bind(exec: Exec): ControlStore {
  return {
    kind: 'db',

    async listDevices(): Promise<DeviceRecord[]> {
      const rows = await exec.select().from(s.devices).orderBy(asc(s.devices.createdAt));
      return rows.map(toDevice);
    },
    async getDevice(deviceId: string): Promise<DeviceRecord | null> {
      const rows = await exec.select().from(s.devices).where(eq(s.devices.deviceId, deviceId)).limit(1);
      return rows.length ? toDevice(rows[0]) : null;
    },
    async getDeviceForUpdate(deviceId: string): Promise<DeviceRecord | null> {
      const rows = await exec
        .select()
        .from(s.devices)
        .where(eq(s.devices.deviceId, deviceId))
        .limit(1)
        .for('update');
      return rows.length ? toDevice(rows[0]) : null;
    },
    async saveDevice(d: DeviceRecord): Promise<void> {
      const values = {
        deviceId: d.deviceId,
        secretHash: d.secretHash,
        machine: d.machine,
        agentVersion: d.agentVersion,
        paired: d.paired,
        revoked: d.revoked,
        createdAt: new Date(d.createdAt),
        credentialRotatedAt: d.credentialRotatedAt ? new Date(d.credentialRotatedAt) : null,
        lastHeartbeat: d.lastHeartbeat ? new Date(d.lastHeartbeat) : null,
        currentJobId: d.currentJobId,
        status: d.status,
        lastTelemetry: d.lastTelemetry ?? null,
      };
      await exec
        .insert(s.devices)
        .values(values)
        .onConflictDoUpdate({ target: s.devices.deviceId, set: { ...values, deviceId: undefined } as never });
    },

    async listCodes(): Promise<PairingCode[]> {
      // Prune expired codes on read (same lazy-expiry semantics as file).
      await exec.delete(s.pairingCodes).where(lt(s.pairingCodes.expiresAt, new Date()));
      const rows = await exec.select().from(s.pairingCodes);
      return rows.map(r => ({ code: r.code, deviceId: r.deviceId, expiresAt: r.expiresAt.getTime() }));
    },
    async saveCodes(codes: PairingCode[]): Promise<void> {
      const wanted = new Set(codes.map(c => c.code));
      const current = await exec.select().from(s.pairingCodes);
      for (const row of current) {
        if (!wanted.has(row.code)) await exec.delete(s.pairingCodes).where(eq(s.pairingCodes.code, row.code));
      }
      for (const c of codes) {
        await exec
          .insert(s.pairingCodes)
          .values({ code: c.code, deviceId: c.deviceId, expiresAt: new Date(c.expiresAt) })
          .onConflictDoNothing();
      }
    },
    async addCode(code: PairingCode): Promise<void> {
      try {
        await exec
          .insert(s.pairingCodes)
          .values({ code: code.code, deviceId: code.deviceId, expiresAt: new Date(code.expiresAt) });
      } catch (error) {
        throw conflict(error, 'Pairing code');
      }
    },
    async removeCode(code: string): Promise<void> {
      await exec.delete(s.pairingCodes).where(eq(s.pairingCodes.code, code));
    },

    async readFlags(): Promise<ControlFlags> {
      const rows = await exec.select().from(s.controlState).where(eq(s.controlState.id, 'default')).limit(1);
      if (!rows.length) return { stopped: false, paused: false };
      return { stopped: rows[0].stopped, paused: rows[0].paused };
    },
    async writeFlags(f: ControlFlags): Promise<void> {
      await exec
        .insert(s.controlState)
        .values({ id: 'default', stopped: f.stopped, paused: f.paused, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: s.controlState.id,
          set: { stopped: f.stopped, paused: f.paused, updatedAt: new Date() },
        });
    },

    async readPolicy(): Promise<Policy | null> {
      const rows = await exec.select().from(s.policies).where(eq(s.policies.id, 'default')).limit(1);
      if (!rows.length) return null;
      return {
        version: 2,
        capabilities: rows[0].capabilities as Policy['capabilities'],
        roots: rows[0].roots as Policy['roots'],
        domains: rows[0].domains as Policy['domains'],
      };
    },
    async writePolicy(p: Policy): Promise<void> {
      await exec
        .insert(s.policies)
        .values({ id: 'default', version: 2, capabilities: p.capabilities, roots: p.roots, domains: p.domains, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: s.policies.id,
          set: { version: 2, capabilities: p.capabilities, roots: p.roots, domains: p.domains, updatedAt: new Date() },
        });
    },

    async insertJob(job: JobRecord): Promise<void> {
      try {
        await exec.insert(s.jobs).values(jobColumns(job));
      } catch (error) {
        throw conflict(error, 'Job insert');
      }
    },
    async findJob(id: string): Promise<JobRecord | null> {
      const rows = await exec.select().from(s.jobs).where(eq(s.jobs.id, id)).limit(1);
      return rows.length ? toJob(rows[0]) : null;
    },
    async getJobForUpdate(id: string): Promise<JobRecord | null> {
      const rows = await exec.select().from(s.jobs).where(eq(s.jobs.id, id)).limit(1).for('update');
      return rows.length ? toJob(rows[0]) : null;
    },
    async listRecentJobs(limit: number): Promise<JobRecord[]> {
      const n = Math.max(1, Math.min(500, limit));
      const rows = await exec.select().from(s.jobs).orderBy(desc(s.jobs.createdAt), desc(s.jobs.id)).limit(n);
      return rows.map(toJob);
    },
    async listActiveJobs(): Promise<JobRecord[]> {
      const rows = await exec
        .select()
        .from(s.jobs)
        .where(inArray(s.jobs.status, ['queued', 'authorized', 'dispatched', 'running']))
        .orderBy(asc(s.jobs.createdAt), asc(s.jobs.id));
      return rows.map(toJob);
    },
    async saveJob(job: JobRecord): Promise<void> {
      const values = jobColumns(job);
      await exec
        .insert(s.jobs)
        .values(values)
        .onConflictDoUpdate({ target: s.jobs.id, set: { ...values, id: undefined } as never });
    },
    async updateJobIf(job: JobRecord, expectedStatuses: JobStatus[]): Promise<boolean> {
      const values = jobColumns(job);
      const updated = await exec
        .update(s.jobs)
        .set({ ...values, id: undefined } as never)
        .where(and(eq(s.jobs.id, job.id), inArray(s.jobs.status, expectedStatuses)))
        .returning({ id: s.jobs.id });
      return updated.length > 0;
    },
    async countJobsByStatus(statuses: JobStatus[]): Promise<number> {
      if (!statuses.length) return 0;
      const rows = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(s.jobs)
        .where(inArray(s.jobs.status, statuses));
      return rows[0]?.n ?? 0;
    },

    async appendAttempt(jobId: string, attempt: { deviceId: string; startedAt: string }): Promise<void> {
      // Keep the job-row attempts[] (legacy shape the control plane reads)
      // and the append-only job_attempts history in sync. Raw SQL with
      // unqualified SET targets (Postgres rejects qualified SET columns).
      await exec.insert(s.jobAttempts).values({ jobId, deviceId: attempt.deviceId, startedAt: new Date(attempt.startedAt) });
      await exec.execute(
        sql`update jobs set attempts = coalesce(attempts, '[]'::jsonb) || ${JSON.stringify(attempt)}::jsonb where id = ${jobId}`,
      );
    },
    async finishAttempt(jobId: string, outcome: string): Promise<void> {
      const now = new Date();
      await exec.execute(sql`
        update job_attempts set ended_at = ${now}, outcome = ${outcome}
        where id = (
          select id from job_attempts
          where job_id = ${jobId} and ended_at is null
          order by id desc limit 1
        )`);
      // Close the matching in-row attempt (same derived-state semantics as
      // the file store: last open attempt only, history untouched).
      const rows = await exec.select().from(s.jobs).where(eq(s.jobs.id, jobId)).limit(1);
      if (rows.length) {
        const attempts = (Array.isArray(rows[0].attempts) ? rows[0].attempts : []) as Array<Record<string, unknown>>;
        const last = attempts[attempts.length - 1] as Record<string, unknown> | undefined;
        if (last && !last.endedAt) {
          last.endedAt = now.toISOString();
          last.outcome = outcome;
          await exec.update(s.jobs).set({ attempts }).where(eq(s.jobs.id, jobId));
        }
      }
    },

    async insertApproval(a: AgentApproval): Promise<void> {
      try {
        await exec.insert(s.approvals).values({
          id: a.id,
          title: a.title,
          kind: a.kind,
          params: a.params,
          reason: a.reason,
          goalId: a.goalId ?? null,
          idempotencyKey: a.idempotencyKey ?? null,
          status: a.status,
          createdBy: a.createdBy,
          createdAt: new Date(a.createdAt),
          expiresAt: new Date(a.expiresAt),
          decidedAt: a.decidedAt ? new Date(a.decidedAt) : null,
          note: a.note ?? null,
          jobIds: a.jobIds,
        });
      } catch (error) {
        throw conflict(error, 'Approval insert');
      }
    },
    async findApproval(id: string): Promise<AgentApproval | null> {
      const rows = await exec.select().from(s.approvals).where(eq(s.approvals.id, id)).limit(1);
      return rows.length ? toApproval(rows[0]) : null;
    },
    async getApprovalForUpdate(id: string): Promise<AgentApproval | null> {
      const rows = await exec.select().from(s.approvals).where(eq(s.approvals.id, id)).limit(1).for('update');
      return rows.length ? toApproval(rows[0]) : null;
    },
    async listApprovalsAll(): Promise<AgentApproval[]> {
      const rows = await exec.select().from(s.approvals).orderBy(asc(s.approvals.createdAt), asc(s.approvals.id));
      return rows.map(toApproval);
    },
    async saveApproval(a: AgentApproval): Promise<void> {
      const values = {
        title: a.title,
        kind: a.kind,
        params: a.params,
        reason: a.reason,
        goalId: a.goalId ?? null,
        idempotencyKey: a.idempotencyKey ?? null,
        status: a.status,
        createdBy: a.createdBy,
        createdAt: new Date(a.createdAt),
        expiresAt: new Date(a.expiresAt),
        decidedAt: a.decidedAt ? new Date(a.decidedAt) : null,
        note: a.note ?? null,
        jobIds: a.jobIds,
      };
      await exec
        .insert(s.approvals)
        .values({ id: a.id, ...values })
        .onConflictDoUpdate({ target: s.approvals.id, set: values });
    },
    async updateApprovalIf(a: AgentApproval, expectedStatus: AgentApproval['status']): Promise<boolean> {
      const updated = await exec
        .update(s.approvals)
        .set({
          title: a.title,
          kind: a.kind,
          params: a.params,
          reason: a.reason,
          goalId: a.goalId ?? null,
          idempotencyKey: a.idempotencyKey ?? null,
          status: a.status,
          decidedAt: a.decidedAt ? new Date(a.decidedAt) : null,
          note: a.note ?? null,
          jobIds: a.jobIds,
        })
        .where(and(eq(s.approvals.id, a.id), eq(s.approvals.status, expectedStatus)))
        .returning({ id: s.approvals.id });
      return updated.length > 0;
    },

    async idemGet(key: string): Promise<IdemValue | null> {
      const rows = await exec.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.key, key)).limit(1);
      if (!rows.length) return null;
      return {
        ...(rows[0].jobId ? { jobId: rows[0].jobId } : {}),
        ...(rows[0].approvalId ? { approvalId: rows[0].approvalId } : {}),
      };
    },
    async idemSet(key: string, v: IdemValue): Promise<void> {
      // First-writer-wins: a concurrent duplicate must fail here so the
      // caller falls back to the winner instead of forking state.
      try {
        await exec
          .insert(s.idempotencyKeys)
          .values({ key, jobId: v.jobId ?? null, approvalId: v.approvalId ?? null, createdAt: new Date() });
      } catch (error) {
        throw conflict(error, 'Idempotency key');
      }
    },

    async auditAppend(record: AuditRecord): Promise<void> {
      await exec.insert(s.auditEvents).values({
        agent: record.agent,
        machine: record.machine,
        userAuth: record.userAuth,
        application: record.application ?? null,
        action: record.action,
        target: record.target,
        command: record.command ?? null,
        permission: record.permission,
        approvalId: record.approvalId ?? null,
        result: record.result,
        error: record.error ?? null,
        before: (record.before ?? null) as never,
        after: (record.after ?? null) as never,
      });
    },
    async auditTail(limit: number): Promise<AuditRecord[]> {
      const n = Math.max(1, Math.min(500, limit));
      const rows = await exec.select().from(s.auditEvents).orderBy(desc(s.auditEvents.id)).limit(n);
      return rows.map(toAudit);
    },

    async insertArtifactMeta(m: ArtifactMeta): Promise<void> {
      try {
        await exec.insert(s.artifactsMeta).values({
          id: m.id,
          jobId: m.jobId ?? null,
          name: m.name,
          kind: m.kind,
          mime: m.mime,
          size: m.size,
          sha256: m.sha256,
          createdAt: new Date(m.createdAt),
        });
      } catch (error) {
        throw conflict(error, 'Artifact metadata');
      }
    },
    async listArtifactMetas(limit: number): Promise<ArtifactMeta[]> {
      const n = Math.max(1, Math.min(200, limit));
      const rows = await exec.select().from(s.artifactsMeta).orderBy(desc(s.artifactsMeta.createdAt)).limit(n);
      return rows.map(r => ({
        id: r.id,
        ...(r.jobId ? { jobId: r.jobId } : {}),
        name: r.name,
        kind: r.kind,
        mime: r.mime,
        size: r.size,
        sha256: r.sha256,
        createdAt: r.createdAt.toISOString(),
      }));
    },
    async findArtifactMeta(id: string): Promise<ArtifactMeta | null> {
      const rows = await exec.select().from(s.artifactsMeta).where(eq(s.artifactsMeta.id, id)).limit(1);
      if (!rows.length) return null;
      const r = rows[0];
      return {
        id: r.id,
        ...(r.jobId ? { jobId: r.jobId } : {}),
        name: r.name,
        kind: r.kind,
        mime: r.mime,
        size: r.size,
        sha256: r.sha256,
        createdAt: r.createdAt.toISOString(),
      };
    },
    async saveArtifactBlob(id: string, data: Buffer): Promise<void> {
      await exec
        .insert(s.artifactBlobs)
        .values({ id, data })
        .onConflictDoUpdate({ target: s.artifactBlobs.id, set: { data } });
    },
    async readArtifactBlob(id: string): Promise<Buffer | null> {
      const rows = await exec.select().from(s.artifactBlobs).where(eq(s.artifactBlobs.id, id)).limit(1);
      if (!rows.length) return null;
      const data = rows[0].data as unknown;
      return Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    },

    async rateHit(key: string, limit: number, windowMs: number, now: number): Promise<RateHit> {
      const windowStart = Math.floor(now / windowMs);
      // Opportunistic prune of this key's stale windows (bounded: at most a
      // couple of rows per key exist at any time).
      await exec.execute(
        sql`delete from ${s.rateWindows} where ${s.rateWindows.key} = ${key} and ${s.rateWindows.windowStart} < ${windowStart}`,
      );
      const rows = await exec
        .select()
        .from(s.rateWindows)
        .where(and(eq(s.rateWindows.key, key), eq(s.rateWindows.windowStart, windowStart)))
        .limit(1)
        .for('update');
      if (!rows.length) {
        await exec.insert(s.rateWindows).values({ key, windowStart, count: 1 }).onConflictDoNothing();
        return { allowed: true, retryAfterMs: 0 };
      }
      if (rows[0].count >= limit) {
        return { allowed: false, retryAfterMs: Math.max(0, (windowStart + 1) * windowMs - now) };
      }
      await exec
        .update(s.rateWindows)
        .set({ count: rows[0].count + 1 })
        .where(and(eq(s.rateWindows.key, key), eq(s.rateWindows.windowStart, windowStart)));
      return { allowed: true, retryAfterMs: 0 };
    },

    async runInTransaction<T>(fn: (tx: ControlStore) => Promise<T>): Promise<T> {
      const database = db();
      // Retry once on deadlock: concurrent approval/job races take row locks
      // in a consistent order, but Postgres can still elect a victim.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await database.transaction(async tx => fn(bind(tx as unknown as Exec)));
        } catch (error) {
          if (dbErrorCode(error) === '40P01' && attempt < 2) continue;
          throw error;
        }
      }
    },
  };
}

// Root store. Bound lazily on first use so importing this module never
// touches the network (db() caches the shared pg Pool via globalThis).
let rootStore: ControlStore | null = null;
function root(): ControlStore {
  if (!rootStore) rootStore = bind(db());
  return rootStore;
}
onDbReset(() => {
  rootStore = null;
});

export const dbStore: ControlStore = new Proxy({ kind: 'db' } as ControlStore, {
  get(_target, prop) {
    if (prop === 'kind') return 'db';
    const value = (root() as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(root()) : value;
  },
});
