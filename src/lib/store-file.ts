import fs from 'fs';
import path from 'path';
import type { ArtifactMeta } from './agent-protocol';
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

// File-backed store: local dev and tests, preserved exactly (now async for
// interface parity). Single-process atomicity via temp-file renames.
// Used for local dev and unit tests; NEVER on Vercel (ephemeral disk) —
// store.ts forces the Neon store there.

function dir(): string {
  const d = process.env.WAVES_STATE_DIR || path.join(process.cwd(), '.waves');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  const target = path.join(dir(), name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

function artifactsDir(): string {
  const d = path.join(dir(), 'artifacts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const rateBuckets = new Map<string, number[]>();

export function resetFileRateLimits(): void {
  rateBuckets.clear();
}

function checkRateLimitBucket(
  buckets: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): RateHit {
  let hits = buckets.get(key) || [];
  hits = hits.filter(t => now - t < windowMs);
  if (hits.length >= limit) {
    return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - hits[0])) };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }
  return { allowed: true, retryAfterMs: 0 };
}

export const fileStore: ControlStore = {
  kind: 'file',

  async listDevices(): Promise<DeviceRecord[]> {
    return readJson<DeviceRecord[]>('devices.json', []);
  },
  async getDevice(deviceId: string): Promise<DeviceRecord | null> {
    return readJson<DeviceRecord[]>('devices.json', []).find(d => d.deviceId === deviceId) || null;
  },
  async getDeviceForUpdate(deviceId: string): Promise<DeviceRecord | null> {
    return fileStore.getDevice(deviceId);
  },
  async saveDevice(d: DeviceRecord): Promise<void> {
    const all = readJson<DeviceRecord[]>('devices.json', []);
    const i = all.findIndex(x => x.deviceId === d.deviceId);
    if (i >= 0) all[i] = d;
    else all.push(d);
    writeJson('devices.json', all);
  },

  async listCodes(): Promise<PairingCode[]> {
    const codes = readJson<PairingCode[]>('codes.json', []);
    const live = codes.filter(c => c.expiresAt > Date.now());
    if (live.length !== codes.length) writeJson('codes.json', live);
    return live;
  },
  async saveCodes(codes: PairingCode[]): Promise<void> {
    writeJson('codes.json', codes);
  },
  async addCode(code: PairingCode): Promise<void> {
    const codes = await fileStore.listCodes();
    codes.push(code);
    writeJson('codes.json', codes);
  },
  async removeCode(code: string): Promise<void> {
    const codes = readJson<PairingCode[]>('codes.json', []);
    writeJson('codes.json', codes.filter(c => c.code !== code));
  },

  async readFlags(): Promise<ControlFlags> {
    const state = readJson<{ stopped?: boolean; paused?: boolean }>('control.json', { stopped: false, paused: false });
    return { stopped: !!state.stopped, paused: !!state.paused };
  },
  async writeFlags(f: ControlFlags): Promise<void> {
    writeJson('control.json', f);
  },

  async readPolicy(): Promise<Policy | null> {
    return readJson<Policy | null>('policy.json', null);
  },
  async writePolicy(p: Policy): Promise<void> {
    writeJson('policy.json', p);
  },

  async insertJob(job: JobRecord): Promise<void> {
    const jobs = readJson<JobRecord[]>('jobs.json', []);
    jobs.push(job);
    writeJson('jobs.json', jobs);
  },
  async findJob(id: string): Promise<JobRecord | null> {
    return readJson<JobRecord[]>('jobs.json', []).find(j => j.id === id) || null;
  },
  async getJobForUpdate(id: string): Promise<JobRecord | null> {
    return fileStore.findJob(id);
  },
  async listRecentJobs(limit: number): Promise<JobRecord[]> {
    return readJson<JobRecord[]>('jobs.json', []).slice(-Math.max(1, Math.min(500, limit))).reverse();
  },
  async listActiveJobs(): Promise<JobRecord[]> {
    return readJson<JobRecord[]>('jobs.json', []).filter(j =>
      ['queued', 'authorized', 'dispatched', 'running'].includes(j.status),
    );
  },
  async saveJob(job: JobRecord): Promise<void> {
    const jobs = readJson<JobRecord[]>('jobs.json', []);
    const i = jobs.findIndex(j => j.id === job.id);
    if (i >= 0) jobs[i] = job;
    else jobs.push(job);
    writeJson('jobs.json', jobs);
  },
  async updateJobIf(job: JobRecord, expectedStatuses: JobStatus[]): Promise<boolean> {
    const jobs = readJson<JobRecord[]>('jobs.json', []);
    const i = jobs.findIndex(j => j.id === job.id);
    if (i < 0 || !expectedStatuses.includes(jobs[i].status)) return false;
    jobs[i] = job;
    writeJson('jobs.json', jobs);
    return true;
  },
  async countJobsByStatus(statuses: JobStatus[]): Promise<number> {
    return readJson<JobRecord[]>('jobs.json', []).filter(j => statuses.includes(j.status)).length;
  },

  async appendAttempt(jobId: string, attempt: { deviceId: string; startedAt: string }): Promise<void> {
    const jobs = readJson<JobRecord[]>('jobs.json', []);
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      job.attempts.push(attempt);
      writeJson('jobs.json', jobs);
    }
  },
  async finishAttempt(jobId: string, outcome: string): Promise<void> {
    const jobs = readJson<JobRecord[]>('jobs.json', []);
    const job = jobs.find(j => j.id === jobId);
    const last = job?.attempts[job.attempts.length - 1];
    if (job && last && !last.endedAt) {
      last.endedAt = new Date().toISOString();
      last.outcome = outcome;
      writeJson('jobs.json', jobs);
    }
  },

  async insertApproval(a: AgentApproval): Promise<void> {
    const approvals = readJson<AgentApproval[]>('agent-approvals.json', []);
    approvals.push(a);
    writeJson('agent-approvals.json', approvals);
  },
  async findApproval(id: string): Promise<AgentApproval | null> {
    return readJson<AgentApproval[]>('agent-approvals.json', []).find(a => a.id === id) || null;
  },
  async getApprovalForUpdate(id: string): Promise<AgentApproval | null> {
    return fileStore.findApproval(id);
  },
  async listApprovalsAll(): Promise<AgentApproval[]> {
    return readJson<AgentApproval[]>('agent-approvals.json', []);
  },
  async saveApproval(a: AgentApproval): Promise<void> {
    const approvals = readJson<AgentApproval[]>('agent-approvals.json', []);
    const i = approvals.findIndex(x => x.id === a.id);
    if (i >= 0) approvals[i] = a;
    else approvals.push(a);
    writeJson('agent-approvals.json', approvals);
  },
  async updateApprovalIf(a: AgentApproval, expectedStatus: AgentApproval['status']): Promise<boolean> {
    const approvals = readJson<AgentApproval[]>('agent-approvals.json', []);
    const i = approvals.findIndex(x => x.id === a.id);
    if (i < 0 || approvals[i].status !== expectedStatus) return false;
    approvals[i] = a;
    writeJson('agent-approvals.json', approvals);
    return true;
  },

  async idemGet(key: string): Promise<IdemValue | null> {
    return readJson<Record<string, IdemValue & { createdAt: string }>>('idem.json', {})[key] || null;
  },
  async idemSet(key: string, v: IdemValue): Promise<void> {
    const idem = readJson<Record<string, IdemValue & { createdAt: string }>>('idem.json', {});
    idem[key] = { ...v, createdAt: new Date().toISOString() };
    writeJson('idem.json', idem);
  },

  async auditAppend(record: AuditRecord): Promise<void> {
    fs.appendFileSync(path.join(dir(), 'audit.jsonl'), `${JSON.stringify(record)}\n`);
  },
  async auditTail(n: number): Promise<AuditRecord[]> {
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir(), 'audit.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const events: AuditRecord[] = [];
    for (const line of content.trim().split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, n)))) {
      try {
        events.push(JSON.parse(line) as AuditRecord);
      } catch {
        // Skip corrupt lines; the log stays readable.
      }
    }
    return events.reverse();
  },

  async insertArtifactMeta(m: ArtifactMeta): Promise<void> {
    const all = readJson<ArtifactMeta[]>('artifacts.json', []);
    all.push(m);
    writeJson('artifacts.json', all.slice(-500));
  },
  async listArtifactMetas(n: number): Promise<ArtifactMeta[]> {
    return readJson<ArtifactMeta[]>('artifacts.json', []).slice(-Math.max(1, Math.min(200, n))).reverse();
  },
  async findArtifactMeta(id: string): Promise<ArtifactMeta | null> {
    return readJson<ArtifactMeta[]>('artifacts.json', []).find(a => a.id === id) || null;
  },
  async saveArtifactBlob(id: string, data: Buffer): Promise<void> {
    fs.writeFileSync(path.join(artifactsDir(), `${id}.bin`), data);
  },
  async readArtifactBlob(id: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(path.join(artifactsDir(), `${id}.bin`));
    } catch {
      return null;
    }
  },

  async rateHit(key: string, limit: number, windowMs: number, now: number): Promise<RateHit> {
    // Dev/test path: same fixed-window semantics as the db store, process-
    // local. Production (multi-instance) uses the Neon rate_windows table.
    return checkRateLimitBucket(rateBuckets, key, limit, windowMs, now);
  },

  // Single process: the closure already runs atomically with respect to
  // other in-process callers. Cross-process concurrency is a documented
  // dev-only limitation — production uses the db store.
  async runInTransaction<T>(fn: (tx: ControlStore) => Promise<T>): Promise<T> {
    return fn(fileStore);
  },
};

export type FileStore = typeof fileStore;
