import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';
import {
  CAPABILITIES,
  DEFAULT_POLICY,
  JOB_KINDS,
  classifyCommand,
  jobCapability,
  jobRisk,
  redactSecrets,
  resolveSandboxPath,
  validatePolicy,
  type JobKind,
  type Policy,
} from './agent-protocol';

// Server-side control plane for the Computer Agent. File-backed stores live
// in <repo>/.waves (gitignored). This module runs only in Route Handlers.
//
// Trust model (Phase 1, local-first):
// - The Next.js server binds to localhost. Agent endpoints require a per-
//   device bearer credential; control endpoints are same-origin UI calls.
// - Policy, approval binding, sandbox containment, and command classification
//   are enforced HERE. The agent re-validates everything before executing
//   (defense in depth). The browser never sees device secrets.

export const AGENT_VERSION = '1.0.0';
export const ONLINE_WINDOW_MS = 25_000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_OUTPUT_CHARS = 50_000;

export function workspaceRoot(): string {
  return process.env.WAVES_WORKSPACE || path.join(process.cwd(), 'workspace');
}

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

export class ApiError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const bad = (message: string) => new ApiError(400, message);
const forbidden = (message: string, extra?: Record<string, unknown>) =>
  new ApiError(403, message, extra);
const notFound = (message: string) => new ApiError(404, message);
const gone = (message: string) => new ApiError(410, message);
const unauthorized = () => new ApiError(401, 'Invalid or missing device credential.');

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message, ...(error.extra || {}) }, { status: error.status });
  }
  return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  deviceId: string;
  secretHash: string;
  machine: string;
  agentVersion: string;
  paired: boolean;
  revoked: boolean;
  createdAt: string;
  lastHeartbeat: string | null;
  currentJobId: string | null;
  status: 'idle' | 'running';
}

interface PairingCode {
  code: string;
  deviceId: string;
  expiresAt: number;
}

function loadDevices(): DeviceRecord[] {
  return readJson<DeviceRecord[]>('devices.json', []);
}

function loadCodes(): PairingCode[] {
  const codes = readJson<PairingCode[]>('codes.json', []);
  const live = codes.filter(c => c.expiresAt > Date.now());
  if (live.length !== codes.length) writeJson('codes.json', live);
  return live;
}

export function registerDevice(input: {
  deviceId: string;
  secretHash: string;
  machine: string;
  pairingCode: string;
  agentVersion: string;
}): { ok: true } {
  const { deviceId, secretHash, machine, pairingCode, agentVersion } = input;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId || '')) throw bad('Invalid deviceId.');
  if (!/^[0-9a-f]{64}$/.test(secretHash || '')) throw bad('Invalid secretHash.');
  if (typeof machine !== 'string' || !machine.trim() || machine.length > 100) {
    throw bad('Invalid machine name.');
  }
  if (!/^[A-Z2-9]{8}$/.test(pairingCode || '')) throw bad('Invalid pairing code format.');
  const devices = loadDevices();
  const existing = devices.find(d => d.deviceId === deviceId);
  if (existing?.revoked) throw forbidden('This device has been revoked. Re-pairing is not automatic.');
  const codes = loadCodes().filter(c => c.deviceId !== deviceId);
  if (codes.filter(c => c.deviceId === deviceId).length >= 3) throw bad('Too many active pairing codes.');
  codes.push({ code: pairingCode, deviceId, expiresAt: Date.now() + PAIRING_TTL_MS });
  writeJson('codes.json', codes);
  if (existing) {
    existing.secretHash = secretHash;
    existing.machine = machine;
    existing.agentVersion = agentVersion || existing.agentVersion;
    writeJson('devices.json', devices);
  } else {
    devices.push({
      deviceId, secretHash, machine, agentVersion: agentVersion || 'unknown',
      paired: false, revoked: false, createdAt: new Date().toISOString(),
      lastHeartbeat: null, currentJobId: null, status: 'idle',
    });
    writeJson('devices.json', devices);
  }
  appendAudit({
    agent: 'Control plane', machine: 'localhost', userAuth: 'device registration',
    action: 'device.registered', target: deviceId, permission: 'system_configuration',
    result: `Pairing code issued for ${machine}. Secret stored as hash only.`,
  });
  return { ok: true };
}

export function claimDevice(code: string): { deviceId: string; machine: string } {
  const codes = loadCodes();
  const match = codes.find(c => c.code === (code || '').trim().toUpperCase());
  if (!match) throw notFound('Pairing code not found. Run the agent pairing command to issue a fresh code.');
  if (match.expiresAt <= Date.now()) {
    writeJson('codes.json', codes.filter(c => c.code !== match.code));
    throw gone('Pairing code expired. Issue a fresh code from the agent.');
  }
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === match.deviceId);
  if (!device) throw notFound('Device record missing.');
  if (device.revoked) throw forbidden('This device has been revoked.');
  device.paired = true;
  writeJson('devices.json', devices);
  writeJson('codes.json', codes.filter(c => c.code !== match.code));
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO pairing confirmation',
    action: 'device.paired', target: device.deviceId, permission: 'system_configuration',
    result: `${device.machine} paired. Single-use code consumed.`,
  });
  return { deviceId: device.deviceId, machine: device.machine };
}

export interface DeviceStatus {
  deviceId: string;
  machine: string;
  paired: boolean;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string;
  currentJobId: string | null;
}

export function listDevices(): DeviceStatus[] {
  return loadDevices()
    .filter(d => d.paired && !d.revoked)
    .map(d => ({
      deviceId: d.deviceId,
      machine: d.machine,
      paired: d.paired,
      online: !!d.lastHeartbeat && Date.now() - Date.parse(d.lastHeartbeat) < ONLINE_WINDOW_MS,
      lastHeartbeat: d.lastHeartbeat,
      agentVersion: d.agentVersion,
      currentJobId: d.currentJobId,
    }));
}

export function verifyDevice(authorization: string | null): DeviceRecord {
  if (!authorization?.startsWith('Bearer ')) throw unauthorized();
  const token = authorization.slice('Bearer '.length);
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw unauthorized();
  const deviceId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(secret)) throw unauthorized();
  const device = loadDevices().find(d => d.deviceId === deviceId);
  if (!device || !device.paired || device.revoked) throw unauthorized();
  const presented = createHash('sha256').update(secret).digest();
  const expected = Buffer.from(device.secretHash, 'hex');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw unauthorized();
  }
  return device;
}

export function heartbeat(deviceId: string, input: {
  status: 'idle' | 'running'; currentJobId?: string | null; machine?: string; agentVersion?: string;
}): { ok: true } {
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  if (!device) throw unauthorized();
  device.lastHeartbeat = new Date().toISOString();
  device.status = input.status === 'running' ? 'running' : 'idle';
  device.currentJobId = input.currentJobId ?? device.currentJobId;
  if (input.machine) device.machine = typeof input.machine === 'string' ? input.machine.slice(0, 100) : device.machine;
  if (input.agentVersion) device.agentVersion = String(input.agentVersion).slice(0, 32);
  writeJson('devices.json', devices);
  return { ok: true };
}

export function revokeDevice(deviceId: string): { ok: true } {
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  if (!device) throw notFound('Device not found.');
  device.revoked = true;
  device.currentJobId = null;
  writeJson('devices.json', devices);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO revocation',
    action: 'device.revoked', target: deviceId, permission: 'system_configuration',
    result: `${device.machine} authorization revoked. Its credential no longer authenticates.`,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function getPolicy(): Policy {
  const stored = readJson<Policy | null>('policy.json', null);
  if (!stored) {
    writeJson('policy.json', DEFAULT_POLICY);
    return structuredClone(DEFAULT_POLICY);
  }
  validatePolicy(stored);
  return stored;
}

export function setPolicy(policy: Policy): Policy {
  validatePolicy(policy);
  const next: Policy = { version: Date.now(), capabilities: { ...policy.capabilities } };
  writeJson('policy.json', next);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO policy change',
    action: 'policy.updated', target: 'computer-agent', permission: 'system_configuration',
    result: 'Execution policy updated. High-risk capabilities remain non-allowable.',
  });
  return next;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobResult {
  ok: boolean;
  output?: string;
  error?: string;
  before?: unknown;
  after?: unknown;
  exitCode?: number;
  durationMs?: number;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  capability: string;
  risk: string;
  approvalId?: string;
  goalId?: string;
  requestedBy: string;
  deviceId?: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
  cancelRequested?: boolean;
  result?: JobResult;
}

function loadJobs(): JobRecord[] {
  return readJson<JobRecord[]>('jobs.json', []);
}

function str(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw bad(`Invalid ${name}.`);
  }
  return value;
}

function checkSandboxPaths(kind: JobKind, params: Record<string, unknown>): void {
  const root = workspaceRoot();
  const paths: string[] = [];
  if (kind === 'fs.move') paths.push(params.from as string, params.to as string);
  else if (typeof params.path === 'string') paths.push(params.path);
  if (typeof params.to === 'string' && kind === 'net.download') paths.push(params.to);
  if (typeof params.cwd === 'string') paths.push(params.cwd);
  for (const p of paths) {
    if (typeof p !== 'string' || !resolveSandboxPath(root, p)) {
      throw bad(`Path escapes the authorized sandbox: ${String(p).slice(0, 120)}`);
    }
  }
}

function validateJobInput(kind: JobKind, params: Record<string, unknown>): { commandClass?: 'readonly' | 'gated' | 'denied' } {
  if (!JOB_KINDS.includes(kind)) throw bad(`Unknown job kind: ${String(kind)}`);
  if (!params || typeof params !== 'object') throw bad('Job params are required.');
  switch (kind) {
    case 'fs.list':
    case 'fs.read':
    case 'fs.mkdir':
    case 'fs.delete':
      str(params.path, 500, 'path');
      break;
    case 'fs.write':
      str(params.path, 500, 'path');
      if (typeof params.content !== 'string' || params.content.length > 200_000) throw bad('Invalid content.');
      break;
    case 'fs.move':
      str(params.from, 500, 'source path');
      str(params.to, 500, 'destination path');
      break;
    case 'term.exec': {
      const command = str(params.command, 2000, 'command');
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      const commandClass = classifyCommand(command);
      if (commandClass === 'denied') throw forbidden(`Command denied by execution policy: ${command.slice(0, 120)}`);
      checkSandboxPaths(kind, params);
      return { commandClass };
    }
    case 'proc.list':
      break;
    case 'proc.start':
      str(params.binary, 100, 'binary');
      if (params.args !== undefined && (!Array.isArray(params.args) || params.args.some(a => typeof a !== 'string' || a.length > 500))) {
        throw bad('Invalid process arguments.');
      }
      break;
    case 'proc.stop':
      if (typeof params.pid !== 'number' || !Number.isInteger(params.pid) || params.pid <= 0) throw bad('Invalid pid.');
      break;
    case 'browser.open': {
      const url = str(params.url, 2000, 'url');
      if (!/^https:\/\//i.test(url)) throw bad('Only https URLs may be opened.');
      break;
    }
    case 'git.status':
    case 'git.log':
    case 'git.diff':
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    case 'git.commit':
      str(params.message, 1000, 'commit message');
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    case 'git.push':
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    case 'net.download': {
      const url = str(params.url, 2000, 'url');
      if (!/^https:\/\//i.test(url)) throw bad('Downloads require https.');
      str(params.to, 500, 'destination path');
      break;
    }
  }
  checkSandboxPaths(kind, params);
  return {};
}

function loadApprovals(): AgentApproval[] {
  return readJson<AgentApproval[]>('agent-approvals.json', []);
}

export interface AgentApproval {
  id: string;
  title: string;
  kind: JobKind;
  params: Record<string, unknown>;
  reason: string;
  goalId?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdBy: string;
  createdAt: string;
  decidedAt?: string;
  note?: string;
  // An approval authorizes exactly one job. Replays are refused.
  jobIds: string[];
}

function sameParams(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function enqueueJob(input: {
  kind: JobKind; params: Record<string, unknown>; approvalId?: string; goalId?: string;
}): JobRecord {
  const { kind, params } = input;
  const { commandClass } = validateJobInput(kind, params);
  const capability = jobCapability(kind);
  const risk = jobRisk(kind, commandClass);
  const policy = getPolicy();
  const policyValue = policy.capabilities[capability];
  if (policyValue === 'denied') {
    throw forbidden(`${capability} is denied by the execution policy.`, { capability });
  }
  const needsApproval = policyValue === 'approval' || risk !== 'low';
  let approval: AgentApproval | undefined;
  if (input.approvalId) {
    const approvals = loadApprovals();
    approval = approvals.find(a => a.id === input.approvalId);
    if (!approval || approval.status !== 'approved') {
      throw forbidden('Approval is not approved for this job.', { needsApproval: true });
    }
    if (approval.kind !== kind || !sameParams(approval.params, params)) {
      throw forbidden('Approval does not match this exact job. Approvals bind to one job only.', { needsApproval: true });
    }
    if ((approval.jobIds || []).length > 0) {
      throw forbidden('Approval has already authorized a job. Request a fresh approval.', { needsApproval: true });
    }
  } else if (needsApproval) {
    throw forbidden('This action requires CEO approval first.', { needsApproval: true, capability, risk });
  }
  const jobs = loadJobs();
  const job: JobRecord = {
    id: `job-${randomUUID()}`,
    kind, params, capability, risk,
    approvalId: approval?.id,
    goalId: input.goalId,
    requestedBy: 'Amey',
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  jobs.push(job);
  writeJson('jobs.json', jobs);
  if (approval) {
    const approvals = loadApprovals();
    const stored = approvals.find(a => a.id === approval.id);
    if (stored) {
      stored.jobIds.push(job.id);
      writeJson('agent-approvals.json', approvals);
    }
  }
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: approval ? `approval:${approval.id}` : 'standing policy',
    action: 'job.queued', target: job.id, command: kind === 'term.exec' ? String(params.command).slice(0, 500) : undefined,
    permission: capability, approvalId: approval?.id, result: `${kind} queued (${risk} risk).`,
  });
  return job;
}

export function listJobs(limit = 20): JobRecord[] {
  return loadJobs().slice(-Math.max(1, Math.min(100, limit))).reverse();
}

interface ControlFlags {
  stopped: boolean;
  paused: boolean;
}

function flags(): ControlFlags {
  const state = readJson<ControlFlags>('control.json', { stopped: false, paused: false });
  return { stopped: !!state.stopped, paused: !!state.paused };
}

export function nextJob(deviceId: string): {
  job: { id: string; kind: JobKind; params: Record<string, unknown>; approvalId?: string; goalId?: string } | null;
  policy: Policy;
  stopped: boolean;
  paused: boolean;
} {
  const { stopped, paused } = flags();
  const policy = getPolicy();
  if (stopped || paused) return { job: null, policy, stopped, paused };
  const jobs = loadJobs();
  let changed = false;
  let dispatch: JobRecord | undefined;
  for (const job of jobs) {
    if (job.status !== 'queued') continue;
    if (job.cancelRequested) {
      job.status = 'cancelled';
      changed = true;
      appendAudit({
        agent: 'Control plane', machine: 'localhost', userAuth: 'CEO cancellation',
        action: 'job.cancelled', target: job.id, permission: job.capability,
        result: `${job.kind} cancelled before execution.`,
      });
      continue;
    }
    job.status = 'running';
    job.deviceId = deviceId;
    dispatch = job;
    changed = true;
    break;
  }
  if (changed) writeJson('jobs.json', jobs);
  if (dispatch) {
    const devices = loadDevices();
    const device = devices.find(d => d.deviceId === deviceId);
    if (device) {
      device.currentJobId = dispatch.id;
      device.status = 'running';
      writeJson('devices.json', devices);
    }
  }
  return {
    job: dispatch ? {
      id: dispatch.id, kind: dispatch.kind, params: dispatch.params,
      approvalId: dispatch.approvalId, goalId: dispatch.goalId,
    } : null,
    policy, stopped, paused,
  };
}

export function agentFlags(deviceId: string): { stop: boolean; paused: boolean; cancelCurrent: boolean } {
  const { stopped, paused } = flags();
  const jobs = loadJobs();
  const running = jobs.find(j => j.deviceId === deviceId && j.status === 'running');
  return { stop: stopped, paused, cancelCurrent: stopped || !!running?.cancelRequested };
}

export function completeJob(deviceId: string, input: {
  jobId: string; ok: boolean; output?: string; error?: string;
  before?: unknown; after?: unknown; exitCode?: number; durationMs?: number;
}): { ok: true } {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === input.jobId);
  if (!job || job.status !== 'running') throw notFound('Running job not found.');
  if (job.deviceId && job.deviceId !== deviceId) throw forbidden('Job is owned by another device.');
  const output = typeof input.output === 'string'
    ? redactSecrets(input.output).slice(0, MAX_OUTPUT_CHARS) : undefined;
  job.result = {
    ok: !!input.ok,
    output,
    error: typeof input.error === 'string' ? redactSecrets(input.error).slice(0, 5000) : undefined,
    before: input.before, after: input.after,
    exitCode: input.exitCode, durationMs: input.durationMs,
  };
  job.status = job.cancelRequested ? 'cancelled' : input.ok ? 'completed' : 'failed';
  writeJson('jobs.json', jobs);
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  if (device) {
    device.currentJobId = null;
    device.status = 'idle';
    writeJson('devices.json', devices);
  }
  appendAudit({
    agent: 'WAVES Computer Agent', machine: device?.machine || 'workstation',
    userAuth: job.approvalId ? `approval:${job.approvalId}` : 'standing policy',
    action: `job.${job.status}`, target: job.id,
    command: job.kind === 'term.exec' ? String(job.params.command).slice(0, 500) : undefined,
    permission: job.capability, approvalId: job.approvalId,
    result: output?.slice(-2000) || (input.ok ? `${job.kind} completed.` : `${job.kind} failed.`),
    error: job.result.error,
    before: job.result.before, after: job.result.after,
  });
  return { ok: true };
}

export function pushEvents(deviceId: string, events: Array<{ level: string; message: string; jobId?: string }>): { ok: true } {
  if (!Array.isArray(events) || events.length > 50) throw bad('Invalid events batch.');
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  for (const event of events) {
    if (!['info', 'warning', 'error'].includes(event.level) || typeof event.message !== 'string') {
      throw bad('Invalid event.');
    }
    appendAudit({
      agent: 'WAVES Computer Agent', machine: device?.machine || 'workstation',
      userAuth: 'job execution', action: 'job.log', target: event.jobId || deviceId,
      permission: 'terminal.execute', result: redactSecrets(event.message).slice(0, 2000),
    });
  }
  return { ok: true };
}

export function cancelJob(jobId: string): { ok: true; status: string } {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) throw notFound('Job not found.');
  if (job.status === 'queued') {
    job.status = 'cancelled';
    writeJson('jobs.json', jobs);
    appendAudit({
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO cancellation',
      action: 'job.cancelled', target: job.id, permission: job.capability,
      result: `${job.kind} cancelled before execution.`,
    });
    return { ok: true, status: 'cancelled' };
  }
  if (job.status === 'running') {
    job.cancelRequested = true;
    writeJson('jobs.json', jobs);
    appendAudit({
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO cancellation',
      action: 'job.cancel_requested', target: job.id, permission: job.capability,
      result: 'Cancellation requested. The agent stops the running action.',
    });
    return { ok: true, status: 'running' };
  }
  return { ok: true, status: job.status };
}

// ---------------------------------------------------------------------------
// Agent approvals (server-side; bind exactly one approved job)
// ---------------------------------------------------------------------------

export function createApproval(input: {
  title: string; kind: JobKind; params: Record<string, unknown>; reason: string; goalId?: string;
}): AgentApproval {
  if (!input.title?.trim() || input.title.length > 200) throw bad('Invalid approval title.');
  if (!input.reason?.trim() || input.reason.length > 2000) throw bad('An approval needs a reason.');
  validateJobInput(input.kind, input.params);
  const approvals = loadApprovals();
  const approval: AgentApproval = {
    id: `aa-${randomUUID()}`,
    title: input.title.trim(),
    kind: input.kind,
    params: input.params,
    reason: input.reason.trim(),
    goalId: input.goalId,
    status: 'pending',
    createdBy: 'Amey',
    createdAt: new Date().toISOString(),
    jobIds: [],
  };
  approvals.push(approval);
  writeJson('agent-approvals.json', approvals);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO request',
    action: 'approval.requested', target: approval.id, permission: jobCapability(input.kind),
    result: `${approval.title} awaits decision.`,
  });
  return approval;
}

export function listApprovals(): AgentApproval[] {
  return loadApprovals().slice().reverse();
}

export function decideApproval(id: string, decision: 'approved' | 'rejected', note?: string): { approval: AgentApproval; jobId?: string } {
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === id);
  if (!approval) throw notFound('Approval not found.');
  if (approval.status !== 'pending') throw bad('Approval already decided.');
  if (decision !== 'approved' && decision !== 'rejected') throw bad('Invalid decision.');
  if (decision === 'rejected' && !note?.trim()) throw bad('Rejection needs a reason.');
  approval.status = decision;
  approval.decidedAt = new Date().toISOString();
  approval.note = note?.trim().slice(0, 1000);
  // Persist before enqueueing: enqueueJob re-reads approvals from disk to
  // verify the approval is approved and binds to the exact job.
  writeJson('agent-approvals.json', approvals);
  let jobId: string | undefined;
  if (decision === 'approved') {
    try {
      const job = enqueueJob({ kind: approval.kind, params: approval.params, approvalId: approval.id, goalId: approval.goalId });
      jobId = job.id;
    } catch (error) {
      approval.status = 'pending';
      delete approval.decidedAt;
      delete approval.note;
      writeJson('agent-approvals.json', approvals);
      throw error;
    }
    // enqueueJob recorded the authorized jobId on disk; reload so the
    // returned record (and any later write) cannot clobber it.
    const fresh = loadApprovals().find(a => a.id === id);
    if (!fresh) throw notFound('Approval not found.');
    appendAudit({
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO decision',
      action: 'approval.approved', target: fresh.id, permission: jobCapability(fresh.kind),
      approvalId: fresh.id,
      result: `Approved. Job ${jobId} queued.`,
    });
    return { approval: fresh, jobId };
  }
  writeJson('agent-approvals.json', approvals);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO decision',
    action: 'approval.rejected', target: approval.id, permission: jobCapability(approval.kind),
    approvalId: approval.id,
    result: `Rejected: ${approval.note}`,
  });
  return { approval, jobId };
}

// ---------------------------------------------------------------------------
// Emergency stop / resume
// ---------------------------------------------------------------------------

export function stopAll(cancelQueued: boolean): { stopped: true; cancelled: number } {
  writeJson('control.json', { stopped: true, paused: true });
  let cancelled = 0;
  if (cancelQueued) {
    const jobs = loadJobs();
    for (const job of jobs) {
      if (job.status === 'queued') {
        job.status = 'cancelled';
        cancelled += 1;
      }
    }
    writeJson('jobs.json', jobs);
  }
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO emergency stop',
    action: 'agent.stopped', target: 'computer-agent', permission: 'system_configuration',
    result: `Emergency stop engaged. Running actions halted${cancelQueued ? `, ${cancelled} queued job(s) cancelled` : ''}.`,
  });
  return { stopped: true, cancelled };
}

export function resume(): { stopped: false } {
  writeJson('control.json', { stopped: false, paused: false });
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO resume',
    action: 'agent.resumed', target: 'computer-agent', permission: 'system_configuration',
    result: 'Agent execution resumed. Queued jobs may dispatch.',
  });
  return { stopped: false };
}

export function controlStatus(): { stopped: boolean; paused: boolean; deviceCount: number; onlineCount: number; queuedJobs: number } {
  const { stopped, paused } = flags();
  const devices = listDevices();
  const queuedJobs = loadJobs().filter(j => j.status === 'queued').length;
  return { stopped, paused, deviceCount: devices.length, onlineCount: devices.filter(d => d.online).length, queuedJobs };
}

// ---------------------------------------------------------------------------
// Audit (append-only)
// ---------------------------------------------------------------------------

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

export function appendAudit(record: Omit<AuditRecord, 'ts'>): void {
  const line = JSON.stringify({ ...record, ts: new Date().toISOString() });
  fs.appendFileSync(path.join(dir(), 'audit.jsonl'), `${line}\n`);
}

export function listAudit(limit = 100): AuditRecord[] {
  let content = '';
  try {
    content = fs.readFileSync(path.join(dir(), 'audit.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const lines = content.trim().split('\n').filter(Boolean);
  const capped = Math.max(1, Math.min(500, limit));
  const events: AuditRecord[] = [];
  for (const line of lines.slice(-capped)) {
    try {
      events.push(JSON.parse(line) as AuditRecord);
    } catch {
      // Skip corrupt lines; the log stays readable.
    }
  }
  return events.reverse();
}

export { CAPABILITIES };
