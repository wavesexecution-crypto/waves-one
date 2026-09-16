import type { ArtifactMeta, CapabilityId, JobKind, JobStatus, Policy, Telemetry } from "./agent-protocol";

const OWNER_TOKEN_KEY = "waves-owner-token";

export interface ControlStatus {
  stopped: boolean;
  paused: boolean;
  deviceCount: number;
  onlineCount: number;
  queuedJobs: number;
  runningJobs: number;
}

export interface DeviceStatus {
  deviceId: string;
  machine: string;
  paired: boolean;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string;
  currentJobId: string | null;
  credentialRotatedAt?: string | null;
  telemetry?: Telemetry;
}

export interface JobAttempt {
  deviceId: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
}

export interface JobResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
}

export interface AgentJob {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  capability: CapabilityId;
  risk: string;
  approvalId?: string | null;
  goalId?: string | null;
  requestedBy: string;
  createdAt: string;
  expiresAt?: string;
  status: JobStatus;
  authorizedAt?: string;
  attempts?: JobAttempt[];
  cancelRequested?: boolean;
  result?: JobResult;
  error?: string | null;
}

export interface AgentApproval {
  id: string;
  title: string;
  kind: string;
  params: Record<string, unknown>;
  reason: string;
  goalId?: string | null;
  status: "pending" | "approved" | "rejected";
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  decidedAt?: string;
  note?: string;
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

export function getOwnerToken(): string | null {
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
    const token = localStorage.getItem(OWNER_TOKEN_KEY);
    return token && token.length ? token : null;
  } catch {
    return null;
  }
}

export function getOwnerTokenMode(): boolean {
  return getOwnerToken() !== null;
}

export function setOwnerToken(token: string): void {
  try {
    localStorage.setItem(OWNER_TOKEN_KEY, token);
  } catch {
    /* owner token is a browser-only convenience */
  }
}

export function clearOwnerToken(): void {
  try {
    localStorage.removeItem(OWNER_TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function artifactDownloadUrl(id: string): string {
  return `/api/control/artifacts/${encodeURIComponent(id)}`;
}

/** Display-only redaction: browser.type secret text never renders in readable form. */
export function hideSecretParams(kind: string, params: Record<string, unknown>): Record<string, unknown> {
  if (kind === "browser.type" && params && typeof params.text === "string") {
    const { text: _secret, ...rest } = params;
    void _secret;
    return { ...rest, text: "[secret withheld]" };
  }
  return params;
}

async function parseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const json = await response.json();
    if (json && typeof json === "object") return json as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

async function request<T>(path: string, init?: RequestInit, unwrap?: (body: Record<string, unknown>) => T): Promise<T> {
  let response: Response;
  const ownerToken = getOwnerToken();
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch {
    throw new Error("Control plane unreachable");
  }
  const body = await parseBody(response);
  if (response.status === 401) {
    throw new Error("Owner authorization required (set the owner token in Settings)");
  }
  if (!response.ok) {
    const message = typeof body.error === "string" && body.error ? body.error : "Request failed";
    const needsApproval = body.needsApproval === true ? " (requires approval)" : "";
    throw new Error(`${message}${needsApproval}`);
  }
  if (unwrap) return unwrap(body);
  return body as unknown as T;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function getStatus(): Promise<ControlStatus> {
  return request<ControlStatus>("/api/control/status", undefined, body => ({
    stopped: body.stopped === true,
    paused: body.paused === true,
    deviceCount: typeof body.deviceCount === "number" ? body.deviceCount : 0,
    onlineCount: typeof body.onlineCount === "number" ? body.onlineCount : 0,
    queuedJobs: typeof body.queuedJobs === "number" ? body.queuedJobs : 0,
    runningJobs: typeof body.runningJobs === "number" ? body.runningJobs : 0,
  }));
}

export function getDevices(): Promise<DeviceStatus[]> {
  return request<DeviceStatus[]>("/api/control/devices", undefined, body => asArray<DeviceStatus>(body.devices));
}

export function pairDevice(code: string): Promise<{ deviceId: string; machine: string }> {
  return request("/api/control/pair", { method: "POST", body: JSON.stringify({ code }) }, body => ({
    deviceId: String(body.deviceId || ""),
    machine: String(body.machine || ""),
  }));
}

export function createJob(input: { kind: JobKind; params: Record<string, unknown>; approvalId?: string; goalId?: string; idempotencyKey?: string }): Promise<{ job: AgentJob; deduped?: boolean }> {
  return request("/api/control/jobs", { method: "POST", body: JSON.stringify(input) }, body => ({
    job: body.job as AgentJob,
    deduped: body.deduped === true ? true : undefined,
  }));
}

export function listJobs(limit = 20): Promise<AgentJob[]> {
  return request<AgentJob[]>(`/api/control/jobs?limit=${limit}`, undefined, body => asArray<AgentJob>(body.jobs));
}

export function createApproval(input: { title: string; kind: string; params: Record<string, unknown>; reason: string; goalId?: string; idempotencyKey?: string }): Promise<{ approval: AgentApproval }> {
  return request("/api/control/approvals", { method: "POST", body: JSON.stringify(input) }, body => ({ approval: body.approval as AgentApproval }));
}

export function listApprovals(): Promise<AgentApproval[]> {
  return request<AgentApproval[]>("/api/control/approvals", undefined, body => asArray<AgentApproval>(body.approvals));
}

export function decideApproval(id: string, decision: "approved" | "rejected", note?: string): Promise<{ approval: AgentApproval; jobId?: string }> {
  return request(`/api/control/approvals/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    body: JSON.stringify(note === undefined ? { decision } : { decision, note }),
  }, body => ({ approval: body.approval as AgentApproval, jobId: typeof body.jobId === "string" ? body.jobId : undefined }));
}

export function getPolicy(): Promise<Policy> {
  return request<Policy>("/api/control/policy", undefined, body => body.policy as Policy);
}

export function putPolicy(policy: Policy): Promise<Policy> {
  return request<Policy>("/api/control/policy", { method: "PUT", body: JSON.stringify({ policy }) }, body => body.policy as Policy);
}

export function listAudit(limit = 100): Promise<AuditRecord[]> {
  return request<AuditRecord[]>(`/api/control/audit?limit=${limit}`, undefined, body => asArray<AuditRecord>(body.events));
}

export function listArtifacts(): Promise<ArtifactMeta[]> {
  return request<ArtifactMeta[]>("/api/control/artifacts", undefined, body => asArray<ArtifactMeta>(body.artifacts));
}

export function stopAll(cancelQueued?: boolean): Promise<{ stopped: boolean }> {
  return request("/api/control/stop", {
    method: "POST",
    body: JSON.stringify(cancelQueued === undefined ? {} : { cancelQueued }),
  }, body => ({ stopped: body.stopped === true }));
}

export function resume(): Promise<{ stopped: boolean }> {
  return request("/api/control/resume", { method: "POST", body: JSON.stringify({}) }, body => ({ stopped: body.stopped === true }));
}

export function cancelJob(jobId: string): Promise<void> {
  return request<void>("/api/control/cancel", { method: "POST", body: JSON.stringify({ jobId }) }, () => undefined);
}

export function revokeDevice(deviceId: string): Promise<void> {
  return request<void>("/api/control/revoke", { method: "POST", body: JSON.stringify({ deviceId }) }, () => undefined);
}
