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

// Durable-store abstraction for the control plane. The domain model and all
// enforcement live in control-plane.ts; stores only persist records.
//
// Two implementations:
// - fileStore (src/lib/store-file.ts): local dev + unit/E2E tests. Single-
//   process atomicity via temp-file renames. NEVER on Vercel (ephemeral disk).
// - dbStore (src/lib/store-db.ts): Neon PostgreSQL. Source of truth for
//   production (and Vercel preview). Transactions protect approval binding,
//   job state transitions, and audit writes.
//
// Store selection (WAVES_STORE): 'db' forces Neon, 'file' forces local
// files. Default: Neon on Vercel (disk is ephemeral there — file state would
// silently vanish), files everywhere else so local dev/tests stay hermetic.
// Point local runs at Neon explicitly with WAVES_STORE=db.

export interface IdemValue {
  jobId?: string;
  approvalId?: string;
}

export interface RateHit {
  allowed: boolean;
  retryAfterMs: number;
}

// Thrown when a conditional write loses a race (row already moved on).
// Callers map this to 409 Conflict / retry — never to silent overwrite.
export class StoreConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConflict';
  }
}

export interface ControlStore {
  readonly kind: 'file' | 'db';

  // Devices + pairing codes (credential metadata only: secret HASHES, never
  // raw secrets — raw secrets exist only transiently in API inputs).
  listDevices(): Promise<DeviceRecord[]>;
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
  // Row-locked read for use inside runInTransaction (db: SELECT .. FOR
  // UPDATE; file: same as getDevice, single process).
  getDeviceForUpdate(deviceId: string): Promise<DeviceRecord | null>;
  saveDevice(device: DeviceRecord): Promise<void>;
  listCodes(): Promise<PairingCode[]>;
  saveCodes(codes: PairingCode[]): Promise<void>;
  addCode(code: PairingCode): Promise<void>;
  removeCode(code: string): Promise<void>;

  // Global control flags (stop/resume must be visible to every instance).
  readFlags(): Promise<ControlFlags>;
  writeFlags(flags: ControlFlags): Promise<void>;

  // Policy document.
  readPolicy(): Promise<Policy | null>;
  writePolicy(policy: Policy): Promise<void>;

  // Jobs. Transitions must use conditional writes (updateJobIf) so a stale
  // reader can never clobber a newer state; plain saveJob is for fields the
  // writer owns outright (owner device updates, reconciliation sweeps that
  // already hold the row lock inside a transaction).
  insertJob(job: JobRecord): Promise<void>;
  findJob(id: string): Promise<JobRecord | null>;
  // Row-locked read for use inside runInTransaction.
  getJobForUpdate(id: string): Promise<JobRecord | null>;
  listRecentJobs(limit: number): Promise<JobRecord[]>;
  listActiveJobs(): Promise<JobRecord[]>;
  saveJob(job: JobRecord): Promise<void>;
  updateJobIf(job: JobRecord, expectedStatuses: JobStatus[]): Promise<boolean>;
  countJobsByStatus(statuses: JobStatus[]): Promise<number>;

  // Job attempts live on the job row (attempts[]) and in the append-only
  // job_attempts table (db) for history.
  appendAttempt(jobId: string, attempt: { deviceId: string; startedAt: string }): Promise<void>;
  finishAttempt(jobId: string, outcome: string): Promise<void>;

  // Approvals. Single-use is enforced by the database (partial unique index
  // jobs_approval_single_use_idx) AND by jobIds checks inside transactions.
  insertApproval(approval: AgentApproval): Promise<void>;
  findApproval(id: string): Promise<AgentApproval | null>;
  // Row-locked read for use inside runInTransaction.
  getApprovalForUpdate(id: string): Promise<AgentApproval | null>;
  listApprovalsAll(): Promise<AgentApproval[]>;
  saveApproval(approval: AgentApproval): Promise<void>;
  updateApprovalIf(approval: AgentApproval, expectedStatus: AgentApproval['status']): Promise<boolean>;

  // Idempotency keys (phone double-tap / retry safety).
  idemGet(key: string): Promise<IdemValue | null>;
  idemSet(key: string, value: IdemValue): Promise<void>;

  // Audit is APPEND-ONLY. This interface exposes no update/delete for audit
  // events by design; implementations must not add any.
  auditAppend(record: AuditRecord): Promise<void>;
  auditTail(limit: number): Promise<AuditRecord[]>;

  // Artifact metadata (Neon) + binary payload (local disk or Vercel Blob).
  insertArtifactMeta(meta: ArtifactMeta): Promise<void>;
  listArtifactMetas(limit: number): Promise<ArtifactMeta[]>;
  findArtifactMeta(id: string): Promise<ArtifactMeta | null>;
  saveArtifactBlob(id: string, data: Buffer): Promise<void>;
  readArtifactBlob(id: string): Promise<Buffer | null>;

  // Fixed-window rate limiting, safe across instances (db) or process (file).
  rateHit(key: string, limit: number, windowMs: number, now: number): Promise<RateHit>;

  // Run fn atomically. File store runs it directly (single process);
  // db store wraps it in a Postgres transaction with a tx-scoped store.
  runInTransaction<T>(fn: (tx: ControlStore) => Promise<T>): Promise<T>;
}

let cached: ControlStore | null = null;

export function storeKind(): 'file' | 'db' {
  const override = process.env.WAVES_STORE;
  if (override === 'db' || override === 'file') return override;
  // On Vercel the filesystem is ephemeral: file state would vanish between
  // invocations, so Neon is mandatory there.
  if (process.env.VERCEL) return 'db';
  return 'file';
}

export async function getStore(): Promise<ControlStore> {
  if (cached) return cached;
  if (storeKind() === 'db') {
    const { dbStore } = await import('./store-db');
    cached = dbStore;
  } else {
    const { fileStore } = await import('./store-file');
    cached = fileStore as unknown as ControlStore;
  }
  return cached;
}

// Test hook: force a fresh selector decision (e.g. restart-persistence tests).
export function resetStoreCache(): void {
  cached = null;
}
