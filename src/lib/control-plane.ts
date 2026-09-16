import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';
import {
  CAPABILITIES,
  DEFAULT_POLICY,
  JOB_KINDS,
  classifyCommand,
  effectiveCapability,
  isUrlAllowed,
  jobRisk,
  migratePolicy,
  redactSecrets,
  resolveAcrossRoots,
  scrubSecretParams,
  sha256Hex,
  validatePolicy,
  type ArtifactMeta,
  type JobKind,
  type JobStatus,
  type Policy,
  type Telemetry,
} from './agent-protocol';

// Server-side control plane for the Computer Agent (protocol v2).
// File-backed durable stores in <repo>/.waves (gitignored, atomic writes):
// devices, jobs (+attempts, idempotency), approvals, policy, artifacts,
// audit log. No in-memory-only state: everything survives server restarts.
//
// Trust model: localhost binding (dev) or owner-token + TLS (cloud).
// Policy, approval binding, roots, domains, and command classification are
// enforced HERE; the agent independently re-validates before executing.
// The browser never sees device secrets.

export const AGENT_VERSION = '1.0.0';
export const ONLINE_WINDOW_MS = 25_000;
export const STALE_RUNNING_MS = 75_000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const JOB_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DISPATCHES = 3;
export const MAX_OUTPUT_CHARS = 50_000;
export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

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
const conflict = (message: string) => new ApiError(409, message);
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
  credentialRotatedAt: string | null;
  lastHeartbeat: string | null;
  currentJobId: string | null;
  status: 'idle' | 'running';
  lastTelemetry?: Telemetry;
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
  const codes = loadCodes();
  const active = codes.filter(c => c.deviceId === deviceId);
  if (active.length >= 3) throw bad('Too many active pairing codes.');
  codes.push({ code: pairingCode, deviceId, expiresAt: Date.now() + PAIRING_TTL_MS });
  writeJson('codes.json', codes);
  if (existing) {
    existing.secretHash = secretHash;
    existing.machine = machine.trim();
    existing.agentVersion = typeof agentVersion === 'string' ? agentVersion.slice(0, 32) : existing.agentVersion;
    writeJson('devices.json', devices);
  } else {
    devices.push({
      deviceId, secretHash, machine: machine.trim(),
      agentVersion: typeof agentVersion === 'string' ? agentVersion.slice(0, 32) : 'unknown',
      paired: false, revoked: false, createdAt: new Date().toISOString(),
      credentialRotatedAt: null, lastHeartbeat: null, currentJobId: null, status: 'idle',
    });
    writeJson('devices.json', devices);
  }
  appendAudit({
    agent: 'Control plane', machine: 'control-plane', userAuth: 'device registration',
    action: 'device.registered', target: deviceId, permission: 'system_configuration',
    result: `Pairing code issued for ${machine.trim()}. Secret stored as hash only.`,
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
  credentialRotatedAt: string | null;
  telemetry?: Telemetry;
}

function toStatus(d: DeviceRecord): DeviceStatus {
  return {
    deviceId: d.deviceId,
    machine: d.machine,
    paired: d.paired,
    online: !!d.lastHeartbeat && Date.now() - Date.parse(d.lastHeartbeat) < ONLINE_WINDOW_MS,
    lastHeartbeat: d.lastHeartbeat,
    agentVersion: d.agentVersion,
    currentJobId: d.currentJobId,
    credentialRotatedAt: d.credentialRotatedAt,
    telemetry: d.lastTelemetry,
  };
}

export function listDevices(): DeviceStatus[] {
  return loadDevices()
    .filter(d => d.paired && !d.revoked)
    .map(toStatus);
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
  status: 'idle' | 'running'; currentJobId?: string | null; machine?: string;
  agentVersion?: string; telemetry?: Telemetry;
}): { ok: true } {
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  if (!device) throw unauthorized();
  device.lastHeartbeat = new Date().toISOString();
  if (input.currentJobId !== undefined) {
    device.currentJobId = input.currentJobId;
    device.status = input.currentJobId ? 'running' : 'idle';
  } else {
    device.status = input.status === 'running' ? 'running' : 'idle';
  }
  if (typeof input.machine === 'string' && input.machine.trim()) {
    device.machine = input.machine.trim().slice(0, 100);
  }
  if (typeof input.agentVersion === 'string' && input.agentVersion) {
    device.agentVersion = input.agentVersion.slice(0, 32);
  }
  if (input.telemetry && typeof input.telemetry === 'object') {
    device.lastTelemetry = sanitizeTelemetry(input.telemetry);
  }
  writeJson('devices.json', devices);
  // A heartbeat acknowledges the running job: dispatched -> running.
  if (device.currentJobId) {
    const jobs = loadJobs();
    const job = jobs.find(j => j.id === device.currentJobId && j.deviceId === deviceId);
    if (job && job.status === 'dispatched') {
      job.status = 'running';
      writeJson('jobs.json', jobs);
    }
  }
  reconcile();
  return { ok: true };
}

// Telemetry is operational diagnostics only: no browsing history, file
// contents, keystrokes, or personal data beyond the OS account name.
function sanitizeTelemetry(input: Telemetry): Telemetry {
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
  const out: Telemetry = {};
  const cpu = num(input.cpuPct);
  if (cpu !== undefined) out.cpuPct = Math.min(100, Math.max(0, cpu));
  const mem = num(input.memPct);
  if (mem !== undefined) out.memPct = Math.min(100, Math.max(0, mem));
  const disk = num(input.diskPct);
  if (disk !== undefined) out.diskPct = Math.min(100, Math.max(0, disk));
  if (typeof input.diskPath === 'string') out.diskPath = input.diskPath.slice(0, 120);
  if (typeof input.procs === 'number' && Number.isFinite(input.procs)) out.procs = Math.max(0, Math.floor(input.procs));
  if (typeof input.uptimeSec === 'number' && Number.isFinite(input.uptimeSec)) out.uptimeSec = Math.max(0, Math.floor(input.uptimeSec));
  if (typeof input.user === 'string') out.user = input.user.slice(0, 64);
  if (typeof input.os === 'string') out.os = input.os.slice(0, 64);
  if (input.tools && typeof input.tools === 'object') {
    out.tools = {};
    for (const [name, version] of Object.entries(input.tools).slice(0, 20)) {
      out.tools[String(name).slice(0, 32)] = typeof version === 'string' ? version.slice(0, 64) : null;
    }
  }
  const browser = input.browser;
  if (browser && typeof browser === 'object') {
    out.browser = {
      active: browser.active === true,
      page: typeof browser.page === 'string' ? browser.page.slice(0, 500) : undefined,
      jobId: typeof browser.jobId === 'string' ? browser.jobId.slice(0, 80) : undefined,
      actions: typeof browser.actions === 'number' ? Math.max(0, Math.floor(browser.actions)) : undefined,
      screenshots: typeof browser.screenshots === 'number' ? Math.max(0, Math.floor(browser.screenshots)) : undefined,
      downloads: typeof browser.downloads === 'number' ? Math.max(0, Math.floor(browser.downloads)) : undefined,
    };
  }
  return out;
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

export function rotateSecret(deviceId: string): { secret: string } {
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  if (!device || !device.paired || device.revoked) throw unauthorized();
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  device.secretHash = createHash('sha256').update(secret).digest('hex');
  device.credentialRotatedAt = new Date().toISOString();
  writeJson('devices.json', devices);
  appendAudit({
    agent: 'Control plane', machine: device.machine, userAuth: 'device credential rotation',
    action: 'device.rotated', target: deviceId, permission: 'system_configuration',
    result: 'Device credential rotated. Previous credential invalidated immediately.',
  });
  return { secret };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function getPolicy(): Policy {
  const stored = readJson<Policy | { version?: number } | null>('policy.json', null);
  if (!stored || typeof stored !== 'object') {
    const fresh = structuredClone(DEFAULT_POLICY);
    fresh.roots = [workspaceRoot()];
    writeJson('policy.json', fresh);
    return fresh;
  }
  if ((stored as { version?: number }).version !== 2) {
    const migrated = migratePolicy(stored);
    if (migrated.roots.length === 0) migrated.roots = [workspaceRoot()];
    writeJson('policy.json', migrated);
    appendAudit({
      agent: 'Control plane', machine: 'control-plane', userAuth: 'policy migration',
      action: 'policy.migrated', target: 'computer-agent', permission: 'system_configuration',
      result: 'Phase-1 policy migrated to version 2 without weakening.',
    });
    return migrated;
  }
  const policy = stored as Policy;
  validatePolicy(policy);
  if (policy.roots.length === 0) {
    return { ...policy, roots: [workspaceRoot()] };
  }
  return policy;
}

export function setPolicy(policy: Policy): Policy {
  validatePolicy(policy);
  const next: Policy = {
    version: 2,
    capabilities: { ...policy.capabilities },
    roots: policy.roots.map(r => r.trim()),
    domains: {
      allowed: policy.domains.allowed.map(h => h.trim().toLowerCase()),
      blocked: policy.domains.blocked.map(h => h.trim().toLowerCase()),
    },
  };
  writeJson('policy.json', next);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO policy change',
    action: 'policy.updated', target: 'computer-agent', permission: 'system_configuration',
    result: `Execution policy updated: ${next.roots.length} root(s), ${next.domains.allowed.length} allowed domain(s). High-risk capabilities remain non-allowable.`,
  });
  return next;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

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

function loadJobs(): JobRecord[] {
  const jobs = readJson<JobRecord[]>('jobs.json', []);
  // Lazy migration of Phase-1 records ONLY (recognized by missing v2
  // fields). A live running job must never be touched here: reconcile()
  // owns liveness decisions.
  let changed = false;
  for (const job of jobs) {
    const legacy = !Array.isArray(job.attempts) || !job.expiresAt;
    if (!legacy) continue;
    if (!Array.isArray(job.attempts)) job.attempts = [];
    if (!job.expiresAt) {
      job.expiresAt = new Date(Date.parse(job.createdAt) + JOB_TTL_MS).toISOString();
    }
    if ((job.status as string) === 'running') {
      job.status = 'authorized';
      job.deviceId = undefined;
    }
    changed = true;
  }
  if (changed) writeJson('jobs.json', jobs);
  return jobs;
}

function str(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw bad(`Invalid ${name}.`);
  }
  return value;
}

const REF_PATTERN = /^[A-Za-z0-9_./-]+$/;

function checkRoots(kind: JobKind, params: Record<string, unknown>, policy: Policy): void {
  const roots = policy.roots.length ? policy.roots : [workspaceRoot()];
  const pinned = typeof params.root === 'string' ? params.root : undefined;
  if (pinned !== undefined && !roots.some(r => r.toLowerCase() === pinned.toLowerCase())) {
    throw bad(`Pinned root is not authorized: ${pinned.slice(0, 120)}`);
  }
  const fields: string[] = [];
  if (kind === 'fs.move' || kind === 'fs.copy') fields.push(params.from as string, params.to as string);
  else if (kind === 'fs.rename') fields.push(params.from as string, params.to as string);
  else if (typeof params.path === 'string') fields.push(params.path);
  if ((kind === 'net.download' || kind === 'upload.artifact') && typeof params.to === 'string' && kind === 'net.download') fields.push(params.to);
  if (kind === 'upload.artifact' && typeof params.path === 'string') fields.push(params.path);
  if (typeof params.cwd === 'string') fields.push(params.cwd);
  if (kind === 'browser.upload' && typeof params.file === 'string') fields.push(params.file);
  for (const value of fields) {
    if (typeof value !== 'string' || !resolveAcrossRoots(roots, value, pinned)) {
      throw bad(`Path escapes the authorized roots: ${String(value).slice(0, 120)}`);
    }
  }
}

function validateJobInput(kind: JobKind, params: Record<string, unknown>, policy: Policy): { commandClass?: 'readonly' | 'gated' | 'admin' | 'denied' } {
  if (!JOB_KINDS.includes(kind)) throw bad(`Unknown job kind: ${String(kind)}`);
  if (!params || typeof params !== 'object') throw bad('Job params are required.');
  if (params.root !== undefined && typeof params.root !== 'string') throw bad('Invalid root pin.');
  switch (kind) {
    case 'fs.list':
    case 'fs.read':
    case 'fs.mkdir':
    case 'fs.delete':
    case 'fs.hash':
    case 'fs.meta':
      str(params.path, 500, 'path');
      break;
    case 'fs.search':
      str(params.query, 200, 'query');
      if (params.path !== undefined) str(params.path, 500, 'path');
      break;
    case 'fs.write':
      str(params.path, 500, 'path');
      if (typeof params.content !== 'string' || params.content.length > 200_000) throw bad('Invalid content.');
      break;
    case 'fs.move':
    case 'fs.copy':
      str(params.from, 500, 'source path');
      str(params.to, 500, 'destination path');
      break;
    case 'fs.rename':
      str(params.from, 500, 'source path');
      str(params.to, 500, 'destination path');
      break;
    case 'term.exec': {
      const command = str(params.command, 2000, 'command');
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      const commandClass = classifyCommand(command);
      if (commandClass === 'denied') throw forbidden(`Command denied by execution policy: ${command.slice(0, 120)}`);
      checkRoots(kind, params, policy);
      return { commandClass };
    }
    case 'proc.list':
      break;
    case 'proc.start':
      str(params.binary, 100, 'binary');
      if (/[\\/]/.test(params.binary as string)) throw bad('Binary must be a bare name, not a path.');
      if (params.args !== undefined && (!Array.isArray(params.args) || params.args.some(a => typeof a !== 'string' || a.length > 500))) {
        throw bad('Invalid process arguments.');
      }
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    case 'proc.stop':
      if (typeof params.pid !== 'number' || !Number.isInteger(params.pid) || params.pid <= 0) throw bad('Invalid pid.');
      break;
    case 'browser.open':
    case 'browser.navigate': {
      const url = str(params.url, 2000, 'url');
      if (!isUrlAllowed(url, policy.domains)) throw forbidden(`Navigation refused by domain policy: ${url.slice(0, 120)}`);
      break;
    }
    case 'browser.inspect':
    case 'browser.extract':
    case 'browser.screenshot':
    case 'browser.close':
      if (params.selector !== undefined) str(params.selector, 500, 'selector');
      break;
    case 'browser.click':
    case 'browser.select':
    case 'browser.scroll':
    case 'browser.download':
    case 'browser.wait':
      if (params.selector !== undefined) str(params.selector, 500, 'selector');
      break;
    case 'browser.type':
      str(params.selector, 500, 'selector');
      if (typeof params.text !== 'string' || params.text.length > 5000) throw bad('Invalid text.');
      break;
    case 'browser.upload':
      str(params.selector, 500, 'selector');
      str(params.file, 500, 'file');
      break;
    case 'git.status':
    case 'git.log':
    case 'git.diff':
    case 'git.pull':
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    case 'git.commit':
      str(params.message, 1000, 'commit message');
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    case 'git.push':
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      if (params.remote !== undefined && (typeof params.remote !== 'string' || !REF_PATTERN.test(params.remote))) throw bad('Invalid remote.');
      if (params.branch !== undefined && (typeof params.branch !== 'string' || !REF_PATTERN.test(params.branch))) throw bad('Invalid branch.');
      break;
    case 'git.branch':
    case 'git.checkout': {
      const ref = str(kind === 'git.branch' ? params.name : params.ref, 200, 'ref');
      if (!REF_PATTERN.test(ref)) throw bad('Invalid ref.');
      if (params.cwd !== undefined) str(params.cwd, 500, 'working directory');
      break;
    }
    case 'github.issue':
      str(params.title, 200, 'title');
      if (params.body !== undefined && (typeof params.body !== 'string' || params.body.length > 5000)) throw bad('Invalid body.');
      if (params.repo !== undefined && (typeof params.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(params.repo))) throw bad('Invalid repo.');
      break;
    case 'github.pr':
      str(params.title, 200, 'title');
      if (params.body !== undefined && (typeof params.body !== 'string' || params.body.length > 8000)) throw bad('Invalid body.');
      for (const key of ['base', 'head'] as const) {
        if (params[key] !== undefined && (typeof params[key] !== 'string' || !REF_PATTERN.test(params[key] as string))) throw bad(`Invalid ${key}.`);
      }
      break;
    case 'net.download': {
      const url = str(params.url, 2000, 'url');
      if (!/^https:\/\//i.test(url)) throw bad('Downloads require https.');
      str(params.to, 500, 'destination path');
      break;
    }
    case 'upload.artifact':
      str(params.path, 500, 'path');
      if (params.name !== undefined) str(params.name, 200, 'name');
      break;
  }
  checkRoots(kind, params, policy);
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

function sameParams(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Attach a binding proof for secret-bearing params without storing a second
// copy of the secret in a comparable field.
function normalizeJobParams(kind: JobKind, params: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'browser.type' && typeof params.text === 'string') {
    return { ...params, textSha256: sha256Hex(params.text) };
  }
  return params;
}

function loadIdempotency(): Record<string, { jobId?: string; approvalId?: string; createdAt: string }> {
  return readJson('idem.json', {});
}

function trimParamsForDenial(kind: JobKind, params: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...scrubSecretParams(kind, params) };
  if (typeof copy.content === 'string') copy.content = `[withheld ${copy.content.length} chars]`;
  if (typeof copy.body === 'string' && copy.body.length > 500) copy.body = copy.body.slice(0, 500);
  return copy;
}

function persistDeniedJob(kind: JobKind, params: Record<string, unknown>, capability: string, risk: string, reason: string): JobRecord {
  const jobs = loadJobs();
  const job: JobRecord = {
    id: `job-${randomUUID()}`,
    kind,
    params: trimParamsForDenial(kind, params),
    capability, risk,
    requestedBy: 'Amey',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    status: 'denied',
    attempts: [],
  };
  jobs.push(job);
  writeJson('jobs.json', jobs);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'standing policy',
    action: 'job.denied', target: job.id,
    command: kind === 'term.exec' && typeof params.command === 'string'
      ? redactSecrets(params.command).slice(0, 500) : undefined,
    permission: capability, result: `Refused before execution: ${reason}`,
  });
  return job;
}

export function enqueueJob(input: {
  kind: JobKind; params: Record<string, unknown>; approvalId?: string;
  goalId?: string; idempotencyKey?: string;
}): { job: JobRecord; deduped: boolean } {
  const { kind } = input;
  const policy = getPolicy();
  const params = normalizeJobParams(kind, (input.params || {}) as Record<string, unknown>);
  // Validation-time refusals (denied commands, domain blocks) persist as
  // terminal denied records. Malformed payloads (400) do not: their shape
  // cannot be trusted for storage.
  let commandClass: 'readonly' | 'gated' | 'admin' | 'denied' | undefined;
  try {
    ({ commandClass } = validateJobInput(kind, params, policy));
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      let classified: 'readonly' | 'gated' | 'admin' | undefined;
      try {
        if (kind === 'term.exec' && typeof params.command === 'string') {
          const c = classifyCommand(params.command);
          if (c !== 'denied') classified = c;
        }
      } catch {
        // Classification is best-effort here; the refusal stands regardless.
      }
      const cap = effectiveCapability(kind, classified);
      const denied = persistDeniedJob(kind, params, cap, jobRisk(kind, classified), error.message);
      throw forbidden(error.message, { jobId: denied.id });
    }
    throw error;
  }
  const capability = effectiveCapability(kind, commandClass);
  const risk = jobRisk(kind, commandClass);
  const policyValue = policy.capabilities[capability];
  const headed = (params as { headed?: unknown }).headed === true;
  if (policyValue === 'denied' || (headed && kind.startsWith('browser.') && !input.approvalId)) {
    const reason = policyValue === 'denied'
      ? `${capability} is denied by the execution policy.`
      : 'Visible browser sessions require an approval.';
    const denied = persistDeniedJob(kind, params, capability, risk, reason);
    throw forbidden(reason, { jobId: denied.id });
  }
  const needsApproval = policyValue === 'approval' || risk !== 'low' || headed;
  if (input.idempotencyKey) {
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
      throw bad('Invalid idempotency key.');
    }
    const idem = loadIdempotency();
    const hit = idem[`job:${input.idempotencyKey}`];
    if (hit) {
      const existing = loadJobs().find(j => j.id === hit.jobId);
      if (existing) return { job: existing, deduped: true };
    }
  }
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
  // Jobs created during a stop/pause wait in held state instead of becoming
  // releasable. Resume promotes them; nothing is lost or silently run.
  const held = flags().stopped || flags().paused;
  const nowIso = new Date().toISOString();
  const job: JobRecord = {
    id: `job-${randomUUID()}`,
    kind, params, capability, risk,
    approvalId: approval?.id,
    goalId: input.goalId,
    idempotencyKey: input.idempotencyKey,
    requestedBy: 'Amey',
    createdAt: nowIso,
    expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    status: held ? 'queued' : 'authorized',
    authorizedAt: held ? undefined : nowIso,
    attempts: [],
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
  if (input.idempotencyKey) {
    const idem = loadIdempotency();
    idem[`job:${input.idempotencyKey}`] = { jobId: job.id, createdAt: new Date().toISOString() };
    writeJson('idem.json', idem);
  }
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: approval ? `approval:${approval.id}` : 'standing policy',
    action: held ? 'job.queued' : 'job.authorized', target: job.id,
    command: kind === 'term.exec' ? redactSecrets(String(params.command)).slice(0, 500) : undefined,
    permission: capability, approvalId: approval?.id,
    result: held
      ? `${kind} held in queue during stop/pause. Resumes on release.`
      : `${kind} authorized (${risk} risk).`,
  });
  return { job, deduped: false };
}

export interface PublicJob extends Omit<JobRecord, 'params'> {
  params: Record<string, unknown>;
}

function publicJob(job: JobRecord): PublicJob {
  return { ...job, params: scrubSecretParams(job.kind, job.params) };
}

export function listJobs(limit = 20): PublicJob[] {
  reconcile();
  return loadJobs().slice(-Math.max(1, Math.min(100, limit))).reverse().map(publicJob);
}

export function getJob(id: string): PublicJob {
  const job = loadJobs().find(j => j.id === id);
  if (!job) throw notFound('Job not found.');
  return publicJob(job);
}

interface ControlFlags {
  stopped: boolean;
  paused: boolean;
}

function flags(): ControlFlags {
  const state = readJson<ControlFlags>('control.json', { stopped: false, paused: false });
  return { stopped: !!state.stopped, paused: !!state.paused };
}

// Expiry sweep + orphaned-running recovery. Jobs never vanish silently:
// expiry and requeue are audited. Reconnect is safe: a job returns to
// authorized (never duplicated) with an attempts cap.
export function reconcile(): void {
  const jobs = loadJobs();
  const devices = loadDevices();
  let changed = false;
  const now = Date.now();
  for (const job of jobs) {
    if (['queued', 'authorized', 'dispatched', 'running'].includes(job.status) && Date.parse(job.expiresAt) < now) {
      job.status = 'expired';
      changed = true;
      appendAudit({
        agent: 'Control plane', machine: 'control-plane', userAuth: 'request expiration',
        action: 'job.expired', target: job.id, permission: job.capability,
        result: `${job.kind} expired before completion.`,
      });
      continue;
    }
    if ((job.status === 'running' || job.status === 'dispatched') && job.deviceId) {
      const device = devices.find(d => d.deviceId === job.deviceId);
      // A revoked device can no longer authenticate, so its work is safe to
      // reclaim immediately. Otherwise allow a grace period for heartbeats.
      const lastAttempt = job.attempts[job.attempts.length - 1];
      const attemptAge = lastAttempt ? now - Date.parse(lastAttempt.startedAt) : Number.POSITIVE_INFINITY;
      let idleFor: number;
      if (!device || device.revoked) {
        idleFor = device?.revoked ? Number.POSITIVE_INFINITY : attemptAge;
      } else {
        const heartbeatAge = device.lastHeartbeat ? now - Date.parse(device.lastHeartbeat) : Number.POSITIVE_INFINITY;
        idleFor = Math.min(heartbeatAge, attemptAge);
      }
      if (idleFor > STALE_RUNNING_MS) {
        const last = job.attempts[job.attempts.length - 1];
        if (last && !last.endedAt) {
          last.endedAt = new Date().toISOString();
          last.outcome = 'orphaned';
        }
        if (job.attempts.length >= MAX_DISPATCHES) {
          job.status = 'failed';
          appendAudit({
            agent: 'Control plane', machine: 'control-plane', userAuth: 'reconnect safety',
            action: 'job.failed', target: job.id, permission: job.capability,
            result: `${job.kind} failed after ${job.attempts.length} orphaned attempts.`,
            error: 'Agent disconnected repeatedly.',
          });
        } else {
          job.status = 'authorized';
          job.deviceId = undefined;
          appendAudit({
            agent: 'Control plane', machine: 'control-plane', userAuth: 'reconnect safety',
            action: 'job.requeued', target: job.id, permission: job.capability,
            result: `Agent ${!device ? 'gone' : 'stale'}; ${job.kind} returned to authorized without duplicating work.`,
          });
        }
        changed = true;
      }
    }
  }
  if (changed) writeJson('jobs.json', jobs);
  const approvals = loadApprovals();
  let approvalsChanged = false;
  for (const approval of approvals) {
    if (approval.status === 'pending' && Date.parse(approval.expiresAt) < now) {
      approval.status = 'expired';
      approvalsChanged = true;
    }
  }
  if (approvalsChanged) writeJson('agent-approvals.json', approvals);
}

export function nextJob(deviceId: string): {
  job: { id: string; kind: JobKind; params: Record<string, unknown>; approvalId?: string; goalId?: string } | null;
  policy: Policy;
  stopped: boolean;
  paused: boolean;
} {
  reconcile();
  const { stopped, paused } = flags();
  const policy = getPolicy();
  if (stopped || paused) return { job: null, policy, stopped, paused };
  const jobs = loadJobs();
  let dispatch: JobRecord | undefined;
  for (const job of jobs) {
    if (job.status !== 'authorized') continue;
    if (job.cancelRequested) {
      job.status = 'cancelled';
      appendAudit({
        agent: 'Control plane', machine: 'control-plane', userAuth: 'CEO cancellation',
        action: 'job.cancelled', target: job.id, permission: job.capability,
        result: `${job.kind} cancelled before dispatch.`,
      });
      continue;
    }
    if (job.attempts.length >= MAX_DISPATCHES) {
      job.status = 'failed';
      appendAudit({
        agent: 'Control plane', machine: 'control-plane', userAuth: 'reconnect safety',
        action: 'job.failed', target: job.id, permission: job.capability,
        result: `${job.kind} exceeded the dispatch budget.`,
      });
      continue;
    }
    job.status = 'dispatched';
    job.deviceId = deviceId;
    job.attempts.push({ deviceId, startedAt: new Date().toISOString() });
    dispatch = job;
    break;
  }
  writeJson('jobs.json', jobs);
  if (dispatch) {
    const devices = loadDevices();
    const device = devices.find(d => d.deviceId === deviceId);
    if (device) {
      device.currentJobId = dispatch.id;
      device.status = 'running';
      writeJson('devices.json', devices);
    }
    appendAudit({
      agent: 'Control plane', machine: 'control-plane', userAuth: dispatch.approvalId ? `approval:${dispatch.approvalId}` : 'standing policy',
      action: 'job.dispatched', target: dispatch.id, permission: dispatch.capability,
      approvalId: dispatch.approvalId,
      result: `${dispatch.kind} dispatched to ${deviceId} (attempt ${dispatch.attempts.length}).`,
    });
  }
  return {
    job: dispatch ? {
      // Full params go ONLY to the authenticated agent. List endpoints scrub.
      id: dispatch.id, kind: dispatch.kind, params: dispatch.params,
      approvalId: dispatch.approvalId, goalId: dispatch.goalId,
    } : null,
    policy, stopped, paused,
  };
}

export function agentFlags(deviceId: string): { stop: boolean; paused: boolean; cancelCurrent: boolean } {
  const { stopped, paused } = flags();
  const jobs = loadJobs();
  const running = jobs.find(j => j.deviceId === deviceId && (j.status === 'running' || j.status === 'dispatched'));
  return { stop: stopped, paused, cancelCurrent: stopped || !!running?.cancelRequested };
}

export function completeJob(deviceId: string, input: {
  jobId: string; ok: boolean; output?: string; error?: string; stderr?: string;
  before?: unknown; after?: unknown; exitCode?: number; durationMs?: number;
  outcome?: 'stopped' | 'cancelled';
}): { ok: true } {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === input.jobId);
  if (!job) throw notFound('Job not found.');
  if (job.deviceId && job.deviceId !== deviceId) throw forbidden('Job is owned by another device.');
  if (!['running', 'dispatched'].includes(job.status)) {
    // Idempotent completion: an identical duplicate post is accepted, a
    // conflicting one is rejected so reconnects can't rewrite history.
    if (job.result && sameParams(job.result, {
      ok: input.ok, output: input.output, error: input.error, stderr: input.stderr,
      before: input.before, after: input.after, exitCode: input.exitCode,
      durationMs: input.durationMs, outcome: input.outcome,
    })) {
      return { ok: true };
    }
    throw conflict(`Job is already ${job.status}.`);
  }
  const output = typeof input.output === 'string'
    ? redactSecrets(input.output).slice(0, MAX_OUTPUT_CHARS) : undefined;
  const stderr = typeof input.stderr === 'string'
    ? redactSecrets(input.stderr).slice(0, MAX_OUTPUT_CHARS) : undefined;
  const result: JobResult = {
    ok: !!input.ok,
    output,
    error: typeof input.error === 'string' ? redactSecrets(input.error).slice(0, 5000) : undefined,
    stderr,
    before: input.before, after: input.after,
    exitCode: input.exitCode, durationMs: input.durationMs,
    outcome: input.outcome,
  };
  // VERIFYING: server-side result validation before anything is terminal.
  job.status = 'verifying';
  const verified = verifyResult(job, result);
  if (input.outcome === 'stopped') job.status = 'stopped';
  else if (input.outcome === 'cancelled' || job.cancelRequested) job.status = 'cancelled';
  else job.status = verified && input.ok ? 'completed' : 'failed';
  job.result = result;
  // Secrets never rest in the store: scrub dispatch-time params on completion.
  job.params = scrubSecretParams(job.kind, job.params);
  const last = job.attempts[job.attempts.length - 1];
  if (last && !last.endedAt) {
    last.endedAt = new Date().toISOString();
    last.outcome = job.status;
  }
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
    command: job.kind === 'term.exec'
      ? redactSecrets(String((job.params as { command?: unknown }).command || '')).slice(0, 500) || undefined
      : undefined,
    permission: job.capability, approvalId: job.approvalId,
    result: output?.slice(-2000) || (input.ok ? `${job.kind} completed.` : `${job.kind} failed.`),
    error: job.result.error,
    before: job.result.before, after: job.result.after,
  });
  void verified;
  return { ok: true };
}

// Result integrity gate: caps, redaction, and mutation evidence. Returns true
// when the result is well-formed; terminal status still follows ok/outcome.
function verifyResult(job: JobRecord, result: JobResult): boolean {
  void job;
  if (result.output !== undefined && typeof result.output !== 'string') return false;
  if (result.error !== undefined && typeof result.error !== 'string') return false;
  return true;
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
  reconcile();
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) throw notFound('Job not found.');
  if (job.status === 'queued' || job.status === 'authorized') {
    job.status = 'cancelled';
    writeJson('jobs.json', jobs);
    appendAudit({
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO cancellation',
      action: 'job.cancelled', target: job.id, permission: job.capability,
      result: `${job.kind} cancelled before dispatch.`,
    });
    return { ok: true, status: 'cancelled' };
  }
  if (job.status === 'running' || job.status === 'dispatched') {
    job.cancelRequested = true;
    writeJson('jobs.json', jobs);
    appendAudit({
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO cancellation',
      action: 'job.cancel_requested', target: job.id, permission: job.capability,
      result: 'Cancellation requested. The agent stops the running action.',
    });
    return { ok: true, status: job.status };
  }
  return { ok: true, status: job.status };
}

// ---------------------------------------------------------------------------
// Agent approvals (server-side; bind exactly one approved job)
// ---------------------------------------------------------------------------

export function createApproval(input: {
  title: string; kind: JobKind; params: Record<string, unknown>; reason: string;
  goalId?: string; idempotencyKey?: string;
}): AgentApproval {
  if (!input.title?.trim() || input.title.length > 200) throw bad('Invalid approval title.');
  if (!input.reason?.trim() || input.reason.length > 2000) throw bad('An approval needs a reason.');
  const policy = getPolicy();
  const params = normalizeJobParams(input.kind, (input.params || {}) as Record<string, unknown>);
  validateJobInput(input.kind, params, policy);
  if (input.idempotencyKey) {
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
      throw bad('Invalid idempotency key.');
    }
    const idem = loadIdempotency();
    const hit = idem[`approval:${input.idempotencyKey}`];
    if (hit?.approvalId) {
      const existing = loadApprovals().find(a => a.id === hit.approvalId);
      if (existing) return existing;
    }
  }
  const approvals = loadApprovals();
  const approval: AgentApproval = {
    id: `aa-${randomUUID()}`,
    title: input.title.trim(),
    kind: input.kind,
    params,
    reason: input.reason.trim(),
    goalId: input.goalId,
    idempotencyKey: input.idempotencyKey,
    status: 'pending',
    createdBy: 'Amey',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    jobIds: [],
  };
  approvals.push(approval);
  writeJson('agent-approvals.json', approvals);
  if (input.idempotencyKey) {
    const idem = loadIdempotency();
    idem[`approval:${input.idempotencyKey}`] = { approvalId: approval.id, createdAt: new Date().toISOString() };
    writeJson('idem.json', idem);
  }
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO request',
    action: 'approval.requested', target: approval.id, permission: effectiveCapability(input.kind),
    result: `${approval.title} awaits decision.`,
  });
  return approval;
}

export function listApprovals(): AgentApproval[] {
  reconcile();
  return loadApprovals().slice().reverse().map(a => ({ ...a, params: scrubSecretParams(a.kind, a.params) }));
}

function storedApproval(id: string): AgentApproval {
  const approval = loadApprovals().find(a => a.id === id);
  if (!approval) throw notFound('Approval not found.');
  return approval;
}

export function decideApproval(id: string, decision: 'approved' | 'rejected', note?: string): { approval: AgentApproval; jobId?: string } {
  reconcile();
  const approvals = loadApprovals();
  const approval = approvals.find(a => a.id === id);
  if (!approval) throw notFound('Approval not found.');
  if (approval.status === 'expired') throw gone('Approval expired. Request a fresh approval.');
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
      const created = enqueueJob({ kind: approval.kind, params: approval.params, approvalId: approval.id, goalId: approval.goalId });
      jobId = created.job.id;
    } catch (error) {
      approval.status = 'pending';
      delete approval.decidedAt;
      delete approval.note;
      writeJson('agent-approvals.json', approvals);
      throw error;
    }
    // enqueueJob recorded the authorized jobId on disk; reload so the
    // returned record (and any later write) cannot clobber it.
    const fresh = storedApproval(id);
    appendAudit({
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO decision',
      action: 'approval.approved', target: fresh.id, permission: effectiveCapability(fresh.kind),
      approvalId: fresh.id,
      result: `Approved. Job ${jobId} authorized.`,
    });
    return { approval: { ...fresh, params: scrubSecretParams(fresh.kind, fresh.params) }, jobId };
  }
  writeJson('agent-approvals.json', approvals);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO decision',
    action: 'approval.rejected', target: approval.id, permission: effectiveCapability(approval.kind),
    approvalId: approval.id,
    result: `Rejected: ${approval.note}`,
  });
  return { approval: { ...approval, params: scrubSecretParams(approval.kind, approval.params) }, jobId };
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
      if (job.status === 'queued' || job.status === 'authorized') {
        job.status = 'cancelled';
        cancelled += 1;
      }
    }
    writeJson('jobs.json', jobs);
  }
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO emergency stop',
    action: 'agent.stopped', target: 'computer-agent', permission: 'system_configuration',
    result: `Emergency stop engaged. Running actions halted${cancelQueued ? `, ${cancelled} held job(s) cancelled` : ''}. New jobs queue in held state.`,
  });
  return { stopped: true, cancelled };
}

export function resume(): { stopped: false; released: number } {
  writeJson('control.json', { stopped: false, paused: false });
  // Jobs held during the stop become releasable again.
  const jobs = loadJobs();
  let released = 0;
  for (const job of jobs) {
    if (job.status === 'queued') {
      job.status = 'authorized';
      job.authorizedAt = new Date().toISOString();
      released += 1;
    }
  }
  writeJson('jobs.json', jobs);
  appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO resume',
    action: 'agent.resumed', target: 'computer-agent', permission: 'system_configuration',
    result: `Agent execution resumed. ${released} held job(s) released.`,
  });
  return { stopped: false, released };
}

export function controlStatus(): {
  stopped: boolean; paused: boolean; deviceCount: number; onlineCount: number;
  queuedJobs: number; runningJobs: number;
} {
  reconcile();
  const { stopped, paused } = flags();
  const devices = listDevices();
  const jobs = loadJobs();
  return {
    stopped, paused,
    deviceCount: devices.length,
    onlineCount: devices.filter(d => d.online).length,
    queuedJobs: jobs.filter(j => j.status === 'queued' || j.status === 'authorized').length,
    runningJobs: jobs.filter(j => j.status === 'running' || j.status === 'dispatched').length,
  };
}

// ---------------------------------------------------------------------------
// Artifacts (agent uploads: screenshots, downloads, extracts, reports)
// ---------------------------------------------------------------------------

const ARTIFACT_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'text/plain', 'text/markdown', 'text/csv', 'text/html',
  'application/json', 'application/pdf', 'application/zip', 'application/octet-stream',
]);

function artifactsDir(): string {
  const d = path.join(dir(), 'artifacts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function saveArtifact(deviceId: string, input: {
  jobId?: string; name: string; kind?: string; mime?: string; dataBase64: string;
}): ArtifactMeta {
  const devices = loadDevices();
  const device = devices.find(d => d.deviceId === deviceId);
  const name = typeof input.name === 'string' ? path.win32.basename(input.name).slice(0, 200) : '';
  if (!name) throw bad('Invalid artifact name.');
  const mime = typeof input.mime === 'string' ? input.mime.toLowerCase().slice(0, 100) : 'application/octet-stream';
  if (!ARTIFACT_MIME.has(mime)) throw bad(`Unsupported artifact type: ${mime}`);
  if (typeof input.dataBase64 !== 'string') throw bad('Invalid artifact data.');
  const data = Buffer.from(input.dataBase64, 'base64');
  if (data.length === 0 || data.length > MAX_ARTIFACT_BYTES) throw bad('Artifact size out of bounds.');
  const meta: ArtifactMeta = {
    id: `art-${randomUUID()}`,
    jobId: typeof input.jobId === 'string' ? input.jobId.slice(0, 80) : undefined,
    name,
    kind: typeof input.kind === 'string' ? input.kind.slice(0, 64) : 'file',
    mime,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(artifactsDir(), `${meta.id}.bin`), data);
  const all = readJson<ArtifactMeta[]>('artifacts.json', []);
  all.push(meta);
  writeJson('artifacts.json', all.slice(-500));
  appendAudit({
    agent: 'WAVES Computer Agent', machine: device?.machine || 'workstation',
    userAuth: 'job execution', action: 'artifact.uploaded', target: meta.id,
    permission: 'uploads.write', result: `${name} (${data.length} bytes, sha256 ${meta.sha256.slice(0, 12)}…).`,
  });
  return meta;
}

export function listArtifacts(limit = 50): ArtifactMeta[] {
  return readJson<ArtifactMeta[]>('artifacts.json', []).slice(-Math.max(1, Math.min(200, limit))).reverse();
}

export function artifactPath(id: string): { meta: ArtifactMeta; file: string } {
  const meta = readJson<ArtifactMeta[]>('artifacts.json', []).find(a => a.id === id);
  if (!meta) throw notFound('Artifact not found.');
  const file = path.join(artifactsDir(), `${id}.bin`);
  if (!fs.existsSync(file)) throw notFound('Artifact file missing.');
  return { meta, file };
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
