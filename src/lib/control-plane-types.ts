import type { JobKind, JobStatus, Policy, Telemetry } from './agent-protocol';

// Canonical control-plane record shapes. This module carries types only — no
// filesystem, database, or Next.js imports — so both the file store (local
// dev/tests) and the Postgres store (Vercel production) can share it without
// import cycles. The domain model itself lives here; stores only persist it.

export type { JobKind, JobStatus, Policy, Telemetry };

export interface DeviceRecord {
  deviceId: string;
  secretHash: string;
  machine: string;
  agentVersion: string;
  paired: boolean;
  revoked: boolean;
  createdAt: string;
  credentialRotatedAt: string | null;
  lastHeartbeat: string | null;
  currentJobId: string | null;
  status: 'idle' | 'running';
  lastTelemetry?: Telemetry;
}

export interface DeviceStatus {
  deviceId: string;
  machine: string;
  paired: boolean;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string;
  currentJobId: string | null;
  credentialRotatedAt: string | null;
  telemetry?: Telemetry;
}

export interface PairingCode {
  code: string;
  deviceId: string;
  expiresAt: number;
}

export interface JobAttempt {
  deviceId: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
}

export interface JobResult {
  ok: boolean;
  output?: string;
  error?: string;
  stderr?: string;
  before?: unknown;
  after?: unknown;
  exitCode?: number;
  durationMs?: number;
  outcome?: 'stopped' | 'cancelled';
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  capability: string;
  risk: string;
  approvalId?: string;
  goalId?: string;
  idempotencyKey?: string;
  requestedBy: string;
  deviceId?: string;
  createdAt: string;
  expiresAt: string;
  status: JobStatus;
  authorizedAt?: string;
  cancelRequested?: boolean;
  attempts: JobAttempt[];
  result?: JobResult;
}

export interface PublicJob extends Omit<JobRecord, 'params'> {
  params: Record<string, unknown>;
}

export interface AgentApproval {
  id: string;
  title: string;
  kind: JobKind;
  params: Record<string, unknown>;
  reason: string;
  goalId?: string;
  idempotencyKey?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  note?: string;
  // An approval authorizes exactly one job. Replays are refused.
  jobIds: string[];
}

export interface AuditRecord {
  ts: string;
  agent: string;
  machine: string;
  userAuth: string;
  application?: string;
  action: string;
  target: string;
  command?: string;
  permission: string;
  approvalId?: string;
  result: string;
  error?: string;
  before?: unknown;
  after?: unknown;
}

export interface ControlFlags {
  stopped: boolean;
  paused: boolean;
}
