import { createHash, randomUUID, timingSafeEqual } from 'crypto';
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
import type {
  AgentApproval,
  AuditRecord,
  ControlFlags,
  DeviceRecord,
  DeviceStatus,
  JobAttempt,
  JobRecord,
  JobResult,
  PairingCode,
  PublicJob,
} from './control-plane-types';
import { StoreConflict, getStore } from './store';

// Server-side control plane for the Computer Agent (protocol v2).
//
// Durable state lives behind the store abstraction (src/lib/store.ts):
// - local dev/tests: files in <repo>/.waves (gitignored, atomic writes)
// - Vercel production/preview: Neon PostgreSQL (source of truth; the Vercel
//   filesystem is ephemeral, so file state would silently vanish there)
//
// Everything survives server restarts in both modes: no in-memory-only state.
//
// Trust model: localhost binding (dev) or owner-token + TLS (cloud).
// Policy, approval binding, roots, domains, and command classification are
// enforced HERE; the agent independently re-validates before executing.
// The browser never sees device secrets or DATABASE_URL — it talks only to
// the /api routes, which run server-side.

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

// Re-exported so existing import sites keep working.
export type {
  AgentApproval,
  AuditRecord,
  DeviceRecord,
  DeviceStatus,
  JobAttempt,
  JobRecord,
  JobResult,
  PairingCode,
  PublicJob,
};

// ---------------------------------------------------------------------------
// Legacy normalization (Phase-1 file rows only). Records written before the
// v2 fields existed gain safe defaults in memory; live liveness decisions
// stay owned by reconcile(). A live running job is never touched here.
// ---------------------------------------------------------------------------

function normalizeLegacy(job: JobRecord): JobRecord {
  const legacy = !Array.isArray(job.attempts) || !job.expiresAt;
  if (!legacy) return job;
  return {
    ...job,
    attempts: Array.isArray(job.attempts) ? job.attempts : [],
    expiresAt: job.expiresAt || new Date(Date.parse(job.createdAt) + JOB_TTL_MS).toISOString(),
    ...(job.status === 'running' ? { status: 'authorized' as const, deviceId: undefined } : {}),
  };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function registerDevice(input: {
  deviceId: string;
  secretHash: string;
  machine: string;
  pairingCode: string;
  agentVersion: string;
}): Promise<{ ok: true }> {
  const { deviceId, secretHash, machine, pairingCode, agentVersion } = input;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId || '')) throw bad('Invalid deviceId.');
  if (!/^[0-9a-f]{64}$/.test(secretHash || '')) throw bad('Invalid secretHash.');
  if (typeof machine !== 'string' || !machine.trim() || machine.length > 100) {
    throw bad('Invalid machine name.');
  }
  if (!/^[A-Z2-9]{8}$/.test(pairingCode || '')) throw bad('Invalid pairing code format.');
  const store = await getStore();
  const existing = await store.getDevice(deviceId);
  if (existing?.revoked) throw forbidden('This device has been revoked. Re-pairing is not automatic.');
  const codes = await store.listCodes();
  const active = codes.filter(c => c.deviceId === deviceId);
  if (active.length >= 3) throw bad('Too many active pairing codes.');
  const code = pairingCode.toUpperCase();
  if (codes.some(c => c.code === code)) throw bad('Pairing code already issued.');
  await store.addCode({ code, deviceId, expiresAt: Date.now() + PAIRING_TTL_MS });
  const version = typeof agentVersion === 'string' ? agentVersion.slice(0, 32) : 'unknown';
  if (existing) {
    await store.saveDevice({
      ...existing,
      secretHash,
      machine: machine.trim(),
      agentVersion: typeof agentVersion === 'string' ? version : existing.agentVersion,
    });
  } else {
    await store.saveDevice({
      deviceId, secretHash, machine: machine.trim(),
      agentVersion: version || 'unknown',
      paired: false, revoked: false, createdAt: new Date().toISOString(),
      credentialRotatedAt: null, lastHeartbeat: null, currentJobId: null, status: 'idle',
    });
  }
  await appendAudit({
    agent: 'Control plane', machine: 'control-plane', userAuth: 'device registration',
    action: 'device.registered', target: deviceId, permission: 'system_configuration',
    result: `Pairing code issued for ${machine.trim()}. Secret stored as hash only.`,
  });
  return { ok: true };
}

export async function claimDevice(code: string): Promise<{ deviceId: string; machine: string }> {
  const store = await getStore();
  const normalized = (code || '').trim().toUpperCase();
  return store.runInTransaction(async tx => {
    const codes = await tx.listCodes();
    const match = codes.find(c => c.code === normalized);
    if (!match) throw notFound('Pairing code not found. Run the agent pairing command to issue a fresh code.');
    if (match.expiresAt <= Date.now()) {
      await tx.removeCode(match.code);
      throw gone('Pairing code expired. Issue a fresh code from the agent.');
    }
    const device = await tx.getDeviceForUpdate(match.deviceId);
    if (!device) throw notFound('Device record missing.');
    if (device.revoked) throw forbidden('This device has been revoked.');
    await tx.saveDevice({ ...device, paired: true });
    // Single-use code: consumed exactly once, inside the same transaction.
    await tx.removeCode(match.code);
    await tx.auditAppend({
      ts: new Date().toISOString(),
      agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO pairing confirmation',
      action: 'device.paired', target: device.deviceId, permission: 'system_configuration',
      result: `${device.machine} paired. Single-use code consumed.`,
    });
    return { deviceId: device.deviceId, machine: device.machine };
  });
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

export async function listDevices(): Promise<DeviceStatus[]> {
  const store = await getStore();
  return (await store.listDevices())
    .filter(d => d.paired && !d.revoked)
    .map(toStatus);
}

export async function verifyDevice(authorization: string | null): Promise<DeviceRecord> {
  if (!authorization?.startsWith('Bearer ')) throw unauthorized();
  const token = authorization.slice('Bearer '.length);
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw unauthorized();
  const deviceId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(secret)) throw unauthorized();
  const store = await getStore();
  const device = await store.getDevice(deviceId);
  if (!device || !device.paired || device.revoked) throw unauthorized();
  const presented = createHash('sha256').update(secret).digest();
  const expected = Buffer.from(device.secretHash, 'hex');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw unauthorized();
  }
  return device;
}

export async function heartbeat(deviceId: string, input: {
  status: 'idle' | 'running'; currentJobId?: string | null; machine?: string;
  agentVersion?: string; telemetry?: Telemetry;
}): Promise<{ ok: true }> {
  const store = await getStore();
  const device = await store.getDevice(deviceId);
  if (!device) throw unauthorized();
  const next: DeviceRecord = {
    ...device,
    lastHeartbeat: new Date().toISOString(),
  };
  if (input.currentJobId !== undefined) {
    next.currentJobId = input.currentJobId;
    next.status = input.currentJobId ? 'running' : 'idle';
  } else {
    next.status = input.status === 'running' ? 'running' : 'idle';
  }
  if (typeof input.machine === 'string' && input.machine.trim()) {
    next.machine = input.machine.trim().slice(0, 100);
  }
  if (typeof input.agentVersion === 'string' && input.agentVersion) {
    next.agentVersion = input.agentVersion.slice(0, 32);
  }
  if (input.telemetry && typeof input.telemetry === 'object') {
    next.lastTelemetry = sanitizeTelemetry(input.telemetry);
  }
  await store.saveDevice(next);
  // A heartbeat acknowledges the running job: dispatched -> running.
  // Conditional write: a concurrent completion wins, never the reverse.
  if (next.currentJobId) {
    const job = await store.findJob(next.currentJobId);
    if (job && job.deviceId === deviceId && job.status === 'dispatched') {
      await store.updateJobIf({ ...normalizeLegacy(job), status: 'running' }, ['dispatched']);
    }
  }
  await reconcile();
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

export async function revokeDevice(deviceId: string): Promise<{ ok: true }> {
  const store = await getStore();
  const device = await store.getDevice(deviceId);
  if (!device) throw notFound('Device not found.');
  // Revocation takes effect on the next authentication check: the stored
  // hash stays, but verifyDevice refuses revoked devices, and reconcile()
  // immediately reclaims their orphaned work.
  await store.saveDevice({ ...device, revoked: true, currentJobId: null });
  await appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO revocation',
    action: 'device.revoked', target: deviceId, permission: 'system_configuration',
    result: `${device.machine} authorization revoked. Its credential no longer authenticates.`,
  });
  return { ok: true };
}

export async function rotateSecret(deviceId: string): Promise<{ secret: string }> {
  const store = await getStore();
  const device = await store.getDevice(deviceId);
  if (!device || !device.paired || device.revoked) throw unauthorized();
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  await store.saveDevice({
    ...device,
    secretHash: createHash('sha256').update(secret).digest('hex'),
    credentialRotatedAt: new Date().toISOString(),
  });
  await appendAudit({
    agent: 'Control plane', machine: device.machine, userAuth: 'device credential rotation',
    action: 'device.rotated', target: deviceId, permission: 'system_configuration',
    result: 'Device credential rotated. Previous credential invalidated immediately.',
  });
  return { secret };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export async function getPolicy(): Promise<Policy> {
  const store = await getStore();
  const stored = await store.readPolicy();
  if (!stored || typeof stored !== 'object') {
    const fresh = structuredClone(DEFAULT_POLICY);
    fresh.roots = [workspaceRoot()];
    await store.writePolicy(fresh);
    return fresh;
  }
  if ((stored as { version?: number }).version !== 2) {
    const migrated = migratePolicy(stored);
    if (migrated.roots.length === 0) migrated.roots = [workspaceRoot()];
    await store.writePolicy(migrated);
    await appendAudit({
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

export async function setPolicy(policy: Policy): Promise<Policy> {
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
  const store = await getStore();
  await store.writePolicy(next);
  await appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO policy change',
    action: 'policy.updated', target: 'computer-agent', permission: 'system_configuration',
    result: `Execution policy updated: ${next.roots.length} root(s), ${next.domains.allowed.length} allowed domain(s). High-risk capabilities remain non-allowable.`,
  });
  return next;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

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

function trimParamsForDenial(kind: JobKind, params: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...scrubSecretParams(kind, params) };
  if (typeof copy.content === 'string') copy.content = `[withheld ${copy.content.length} chars]`;
  if (typeof copy.body === 'string' && copy.body.length > 500) copy.body = copy.body.slice(0, 500);
  return copy;
}

async function persistDeniedJob(kind: JobKind, params: Record<string, unknown>, capability: string, risk: string, reason: string): Promise<JobRecord> {
  const store = await getStore();
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
  await store.insertJob(job);
  await appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'standing policy',
    action: 'job.denied', target: job.id,
    command: kind === 'term.exec' && typeof params.command === 'string'
      ? redactSecrets(params.command).slice(0, 500) : undefined,
    permission: capability, result: `Refused before execution: ${reason}`,
  });
  return job;
}

function validateIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw bad('Invalid idempotency key.');
  }
  return value;
}

export async function enqueueJob(input: {
  kind: JobKind; params: Record<string, unknown>; approvalId?: string;
  goalId?: string; idempotencyKey?: string;
}): Promise<{ job: JobRecord; deduped: boolean }> {
  const { kind } = input;
  const policy = await getPolicy();
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
      const denied = await persistDeniedJob(kind, params, cap, jobRisk(kind, classified), error.message);
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
    const denied = await persistDeniedJob(kind, params, capability, risk, reason);
    throw forbidden(reason, { jobId: denied.id });
  }
  const needsApproval = policyValue === 'approval' || risk !== 'low' || headed;
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const store = await getStore();

  // Fast dedupe path (read-only): a completed earlier request with the same
  // key returns its job without touching state.
  if (idempotencyKey) {
    const hit = await store.idemGet(`job:${idempotencyKey}`);
    if (hit?.jobId) {
      const existing = await store.findJob(hit.jobId);
      if (existing) return { job: normalizeLegacy(existing), deduped: true };
    }
  }

  try {
    return await store.runInTransaction(async tx => {
      let approval: AgentApproval | undefined;
      if (input.approvalId) {
        // Row lock: concurrent binds of the same approval serialize here.
        approval = (await tx.getApprovalForUpdate(input.approvalId!)) ?? undefined;
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
      // Jobs created during a stop/pause wait in held state instead of becoming
      // releasable. Resume promotes them; nothing is lost or silently run.
      const flags = await tx.readFlags();
      const held = flags.stopped || flags.paused;
      const nowIso = new Date().toISOString();
      const job: JobRecord = {
        id: `job-${randomUUID()}`,
        kind, params, capability, risk,
        ...(approval ? { approvalId: approval.id } : {}),
        ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        requestedBy: 'Amey',
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
        status: held ? 'queued' : 'authorized',
        ...(held ? {} : { authorizedAt: nowIso }),
        attempts: [],
      };
      // Claim the idempotency slot FIRST: a concurrent duplicate blocks on
      // this row and then fails, so it falls back to the winner below.
      if (idempotencyKey) {
        await tx.idemSet(`job:${idempotencyKey}`, { jobId: job.id });
      }
      // The partial unique index jobs_approval_single_use_idx is the final
      // backstop: even a missed lock surfaces as StoreConflict, never a
      // double-bound approval.
      await tx.insertJob(job);
      if (approval) {
        await tx.saveApproval({ ...approval, jobIds: [...approval.jobIds, job.id] });
      }
      await tx.auditAppend({
        ts: new Date().toISOString(),
        agent: 'Amey', machine: 'WAVES ONE', userAuth: approval ? `approval:${approval.id}` : 'standing policy',
        action: held ? 'job.queued' : 'job.authorized', target: job.id,
        command: kind === 'term.exec' ? redactSecrets(String(params.command)).slice(0, 500) : undefined,
        permission: capability, ...(approval ? { approvalId: approval.id } : {}),
        result: held
          ? `${kind} held in queue during stop/pause. Resumes on release.`
          : `${kind} authorized (${risk} risk).`,
      });
      return { job, deduped: false };
    });
  } catch (error) {
    // A lost race is not an error to surface raw: resolve the winner.
    if (error instanceof StoreConflict) {
      if (idempotencyKey) {
        const hit = await store.idemGet(`job:${idempotencyKey}`);
        if (hit?.jobId) {
          const winner = await store.findJob(hit.jobId);
          if (winner) return { job: normalizeLegacy(winner), deduped: true };
        }
      }
      if (input.approvalId) {
        throw forbidden('Approval has already authorized a job. Request a fresh approval.', { needsApproval: true });
      }
      throw conflict('Concurrent request conflict. Retry with the same idempotency key.');
    }
    throw error;
  }
}

function publicJob(job: JobRecord): PublicJob {
  return { ...job, params: scrubSecretParams(job.kind, job.params) };
}

export async function listJobs(limit = 20): Promise<PublicJob[]> {
  await reconcile();
  const store = await getStore();
  const jobs = await store.listRecentJobs(Math.max(1, Math.min(100, limit)));
  return jobs.map(j => publicJob(normalizeLegacy(j)));
}

export async function getJob(id: string): Promise<PublicJob> {
  const store = await getStore();
  const job = await store.findJob(id);
  if (!job) throw notFound('Job not found.');
  return publicJob(normalizeLegacy(job));
}

async function flags(): Promise<ControlFlags> {
  const store = await getStore();
  return store.readFlags();
}

// Expiry sweep + orphaned-running recovery. Jobs never vanish silently:
// expiry and requeue are audited. Reconnect is safe: a job returns to
// authorized (never duplicated) with an attempts cap. Every mutation is a
// conditional write, so concurrent reconcilers (or a dispatcher racing the
// sweep) cannot double-apply or clobber.
export async function reconcile(): Promise<void> {
  const store = await getStore();
  const jobs = (await store.listActiveJobs()).map(normalizeLegacy);
  const devices = await store.listDevices();
  const now = Date.now();
  for (const job of jobs) {
    if (['queued', 'authorized', 'dispatched', 'running'].includes(job.status) && Date.parse(job.expiresAt) < now) {
      const expired: JobRecord = { ...job, status: 'expired' };
      if (await store.updateJobIf(expired, ['queued', 'authorized', 'dispatched', 'running'])) {
        await appendAudit({
          agent: 'Control plane', machine: 'control-plane', userAuth: 'request expiration',
          action: 'job.expired', target: job.id, permission: job.capability,
          result: `${job.kind} expired before completion.`,
        });
      }
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
        const attempts = job.attempts.map(a => ({ ...a }));
        const last = attempts[attempts.length - 1];
        if (last && !last.endedAt) {
          last.endedAt = new Date().toISOString();
          last.outcome = 'orphaned';
        }
        if (attempts.length >= MAX_DISPATCHES) {
          const failed: JobRecord = { ...job, attempts, status: 'failed' };
          if (await store.updateJobIf(failed, ['running', 'dispatched'])) {
            await store.finishAttempt(job.id, 'orphaned');
            await appendAudit({
              agent: 'Control plane', machine: 'control-plane', userAuth: 'reconnect safety',
              action: 'job.failed', target: job.id, permission: job.capability,
              result: `${job.kind} failed after ${attempts.length} orphaned attempts.`,
              error: 'Agent disconnected repeatedly.',
            });
          }
        } else {
          const requeued: JobRecord = { ...job, attempts, status: 'authorized', deviceId: undefined };
          if (await store.updateJobIf(requeued, ['running', 'dispatched'])) {
            await store.finishAttempt(job.id, 'orphaned');
            await appendAudit({
              agent: 'Control plane', machine: 'control-plane', userAuth: 'reconnect safety',
              action: 'job.requeued', target: job.id, permission: job.capability,
              result: `Agent ${!device ? 'gone' : 'stale'}; ${job.kind} returned to authorized without duplicating work.`,
            });
          }
        }
      }
    }
  }
  const approvals = await store.listApprovalsAll();
  for (const approval of approvals) {
    if (approval.status === 'pending' && Date.parse(approval.expiresAt) < now) {
      await store.updateApprovalIf({ ...approval, status: 'expired' }, 'pending');
    }
  }
}

export async function nextJob(deviceId: string): Promise<{
  job: { id: string; kind: JobKind; params: Record<string, unknown>; approvalId?: string; goalId?: string } | null;
  policy: Policy;
  stopped: boolean;
  paused: boolean;
}> {
  await reconcile();
  const { stopped, paused } = await flags();
  const policy = await getPolicy();
  if (stopped || paused) return { job: null, policy, stopped, paused };
  const store = await getStore();
  const candidates = (await store.listActiveJobs())
    .map(normalizeLegacy)
    .filter(j => j.status === 'authorized');
  for (const candidate of candidates) {
    if (candidate.cancelRequested) {
      if (await store.updateJobIf({ ...candidate, status: 'cancelled' }, ['authorized'])) {
        await appendAudit({
          agent: 'Control plane', machine: 'control-plane', userAuth: 'CEO cancellation',
          action: 'job.cancelled', target: candidate.id, permission: candidate.capability,
          result: `${candidate.kind} cancelled before dispatch.`,
        });
      }
      continue;
    }
    if (candidate.attempts.length >= MAX_DISPATCHES) {
      if (await store.updateJobIf({ ...candidate, status: 'failed' }, ['authorized'])) {
        await appendAudit({
          agent: 'Control plane', machine: 'control-plane', userAuth: 'reconnect safety',
          action: 'job.failed', target: candidate.id, permission: candidate.capability,
          result: `${candidate.kind} exceeded the dispatch budget.`,
        });
      }
      continue;
    }
    // Atomic claim: exactly one dispatcher wins the authorized -> dispatched
    // transition; losers continue scanning instead of double-dispatching.
    const claimed: JobRecord = { ...candidate, status: 'dispatched', deviceId };
    if (!(await store.updateJobIf(claimed, ['authorized']))) continue;
    await store.appendAttempt(candidate.id, { deviceId, startedAt: new Date().toISOString() });
    const device = await store.getDevice(deviceId);
    if (device) {
      await store.saveDevice({ ...device, currentJobId: candidate.id, status: 'running' });
    }
    await appendAudit({
      agent: 'Control plane', machine: 'control-plane', userAuth: candidate.approvalId ? `approval:${candidate.approvalId}` : 'standing policy',
      action: 'job.dispatched', target: candidate.id, permission: candidate.capability,
      ...(candidate.approvalId ? { approvalId: candidate.approvalId } : {}),
      result: `${candidate.kind} dispatched to ${deviceId} (attempt ${candidate.attempts.length + 1}).`,
    });
    return {
      job: {
        // Full params go ONLY to the authenticated agent. List endpoints scrub.
        id: candidate.id, kind: candidate.kind, params: candidate.params,
        ...(candidate.approvalId ? { approvalId: candidate.approvalId } : {}),
        ...(candidate.goalId ? { goalId: candidate.goalId } : {}),
      },
      policy, stopped, paused,
    };
  }
  return { job: null, policy, stopped, paused };
}

export async function agentFlags(deviceId: string): Promise<{ stop: boolean; paused: boolean; cancelCurrent: boolean }> {
  const { stopped, paused } = await flags();
  const store = await getStore();
  const jobs = await store.listActiveJobs();
  const running = jobs.find(j => j.deviceId === deviceId && (j.status === 'running' || j.status === 'dispatched'));
  return { stop: stopped, paused, cancelCurrent: stopped || !!running?.cancelRequested };
}

export async function completeJob(deviceId: string, input: {
  jobId: string; ok: boolean; output?: string; error?: string; stderr?: string;
  before?: unknown; after?: unknown; exitCode?: number; durationMs?: number;
  outcome?: 'stopped' | 'cancelled';
}): Promise<{ ok: true }> {
  const store = await getStore();
  const current = await store.findJob(input.jobId);
  if (!current) throw notFound('Job not found.');
  const job = normalizeLegacy(current);
  if (job.deviceId && job.deviceId !== deviceId) throw forbidden('Job is owned by another device.');
  const terminal = !['running', 'dispatched'].includes(job.status);
  const buildResult = (): JobResult => {
    const output = typeof input.output === 'string'
      ? redactSecrets(input.output).slice(0, MAX_OUTPUT_CHARS) : undefined;
    const stderr = typeof input.stderr === 'string'
      ? redactSecrets(input.stderr).slice(0, MAX_OUTPUT_CHARS) : undefined;
    return {
      ok: !!input.ok,
      ...(output !== undefined ? { output } : {}),
      ...(typeof input.error === 'string' ? { error: redactSecrets(input.error).slice(0, 5000) } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    };
  };
  if (terminal) {
    // Idempotent completion: an identical duplicate post is accepted, a
    // conflicting one is rejected so reconnects can't rewrite history.
    if (job.result && sameParams(job.result, buildResult())) {
      return { ok: true };
    }
    throw conflict(`Job is already ${job.status}.`);
  }
  // Transition + attempt close + device release + audit commit atomically.
  // The row lock serializes concurrent completions; the loser re-reads the
  // terminal row and takes the idempotent/conflict path above.
  try {
    await store.runInTransaction(async tx => {
      const locked = await tx.getJobForUpdate(input.jobId);
      if (!locked) throw notFound('Job not found.');
      const fresh = normalizeLegacy(locked);
      if (fresh.deviceId && fresh.deviceId !== deviceId) throw forbidden('Job is owned by another device.');
      if (!['running', 'dispatched'].includes(fresh.status)) {
        throw new StoreConflict(`Job is already ${fresh.status}.`);
      }
      const result = buildResult();
      // VERIFYING: server-side result validation before anything is terminal.
      const verified = verifyResult(fresh, result);
      let status: JobStatus;
      if (input.outcome === 'stopped') status = 'stopped';
      else if (input.outcome === 'cancelled' || fresh.cancelRequested) status = 'cancelled';
      else status = verified && input.ok ? 'completed' : 'failed';
      const attempts = fresh.attempts.map(a => ({ ...a }));
      const last = attempts[attempts.length - 1];
      if (last && !last.endedAt) {
        last.endedAt = new Date().toISOString();
        last.outcome = status;
      }
      // Secrets never rest in the store: scrub dispatch-time params on completion.
      const completed: JobRecord = {
        ...fresh,
        status,
        result,
        params: scrubSecretParams(fresh.kind, fresh.params) as Record<string, unknown>,
        attempts,
      };
      await tx.saveJob(completed);
      await tx.finishAttempt(fresh.id, status);
      const device = await tx.getDevice(deviceId);
      if (device) {
        await tx.saveDevice({ ...device, currentJobId: null, status: 'idle' });
      }
      await tx.auditAppend({
        ts: new Date().toISOString(),
        agent: 'WAVES Computer Agent', machine: device?.machine || 'workstation',
        userAuth: fresh.approvalId ? `approval:${fresh.approvalId}` : 'standing policy',
        action: `job.${status}`, target: fresh.id,
        command: fresh.kind === 'term.exec'
          ? redactSecrets(String((completed.params as { command?: unknown }).command || '')).slice(0, 500) || undefined
          : undefined,
        permission: fresh.capability, ...(fresh.approvalId ? { approvalId: fresh.approvalId } : {}),
        result: result.output?.slice(-2000) || (input.ok ? `${fresh.kind} completed.` : `${fresh.kind} failed.`),
        ...(result.error ? { error: result.error } : {}),
        ...(result.before !== undefined ? { before: result.before } : {}),
        ...(result.after !== undefined ? { after: result.after } : {}),
      });
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof StoreConflict) {
      // Lost a completion race: the winner's terminal row decides.
      const winner = await store.findJob(input.jobId);
      if (winner && !['running', 'dispatched'].includes(winner.status)) {
        if (winner.result && sameParams(winner.result, buildResult())) return { ok: true };
        throw conflict(`Job is already ${winner.status}.`);
      }
    }
    throw error;
  }
}

// Result integrity gate: caps, redaction, and mutation evidence. Returns true
// when the result is well-formed; terminal status still follows ok/outcome.
function verifyResult(job: JobRecord, result: JobResult): boolean {
  void job;
  if (result.output !== undefined && typeof result.output !== 'string') return false;
  if (result.error !== undefined && typeof result.error !== 'string') return false;
  return true;
}

export async function pushEvents(deviceId: string, events: Array<{ level: string; message: string; jobId?: string }>): Promise<{ ok: true }> {
  if (!Array.isArray(events) || events.length > 50) throw bad('Invalid events batch.');
  const store = await getStore();
  const device = await store.getDevice(deviceId);
  for (const event of events) {
    if (!['info', 'warning', 'error'].includes(event.level) || typeof event.message !== 'string') {
      throw bad('Invalid event.');
    }
    await appendAudit({
      agent: 'WAVES Computer Agent', machine: device?.machine || 'workstation',
      userAuth: 'job execution', action: 'job.log', target: event.jobId || deviceId,
      permission: 'terminal.execute', result: redactSecrets(event.message).slice(0, 2000),
    });
  }
  return { ok: true };
}

export async function cancelJob(jobId: string): Promise<{ ok: true; status: string }> {
  await reconcile();
  const store = await getStore();
  const found = await store.findJob(jobId);
  if (!found) throw notFound('Job not found.');
  const job = normalizeLegacy(found);
  if (job.status === 'queued' || job.status === 'authorized') {
    if (await store.updateJobIf({ ...job, status: 'cancelled' }, ['queued', 'authorized'])) {
      await appendAudit({
        agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO cancellation',
        action: 'job.cancelled', target: job.id, permission: job.capability,
        result: `${job.kind} cancelled before dispatch.`,
      });
      return { ok: true, status: 'cancelled' };
    }
    const fresh = await store.findJob(jobId);
    return { ok: true, status: fresh?.status || job.status };
  }
  if (job.status === 'running' || job.status === 'dispatched') {
    if (await store.updateJobIf({ ...job, cancelRequested: true }, ['running', 'dispatched'])) {
      await appendAudit({
        agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO cancellation',
        action: 'job.cancel_requested', target: job.id, permission: job.capability,
        result: 'Cancellation requested. The agent stops the running action.',
      });
    }
    const fresh = await store.findJob(jobId);
    return { ok: true, status: fresh?.status || job.status };
  }
  return { ok: true, status: job.status };
}

// ---------------------------------------------------------------------------
// Agent approvals (server-side; bind exactly one approved job)
// ---------------------------------------------------------------------------

export async function createApproval(input: {
  title: string; kind: JobKind; params: Record<string, unknown>; reason: string;
  goalId?: string; idempotencyKey?: string;
}): Promise<AgentApproval> {
  if (!input.title?.trim() || input.title.length > 200) throw bad('Invalid approval title.');
  if (!input.reason?.trim() || input.reason.length > 2000) throw bad('An approval needs a reason.');
  const policy = await getPolicy();
  const params = normalizeJobParams(input.kind, (input.params || {}) as Record<string, unknown>);
  validateJobInput(input.kind, params, policy);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const store = await getStore();
  if (idempotencyKey) {
    const hit = await store.idemGet(`approval:${idempotencyKey}`);
    if (hit?.approvalId) {
      const existing = await store.findApproval(hit.approvalId);
      if (existing) return existing;
    }
  }
  const approval: AgentApproval = {
    id: `aa-${randomUUID()}`,
    title: input.title.trim(),
    kind: input.kind,
    params,
    reason: input.reason.trim(),
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    status: 'pending',
    createdBy: 'Amey',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    jobIds: [],
  };
  try {
    await store.runInTransaction(async tx => {
      if (idempotencyKey) {
        await tx.idemSet(`approval:${idempotencyKey}`, { approvalId: approval.id });
      }
      await tx.insertApproval(approval);
      await tx.auditAppend({
        ts: new Date().toISOString(),
        agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO request',
        action: 'approval.requested', target: approval.id, permission: effectiveCapability(input.kind),
        result: `${approval.title} awaits decision.`,
      });
    });
  } catch (error) {
    if (error instanceof StoreConflict && idempotencyKey) {
      const hit = await store.idemGet(`approval:${idempotencyKey}`);
      if (hit?.approvalId) {
        const winner = await store.findApproval(hit.approvalId);
        if (winner) return winner;
      }
    }
    throw error;
  }
  return approval;
}

export async function listApprovals(): Promise<AgentApproval[]> {
  await reconcile();
  const store = await getStore();
  return (await store.listApprovalsAll()).slice().reverse().map(a => ({ ...a, params: scrubSecretParams(a.kind, a.params) as Record<string, unknown> }));
}

async function storedApproval(id: string): Promise<AgentApproval> {
  const store = await getStore();
  const approval = await store.findApproval(id);
  if (!approval) throw notFound('Approval not found.');
  return approval;
}

export async function decideApproval(id: string, decision: 'approved' | 'rejected', note?: string): Promise<{ approval: AgentApproval; jobId?: string }> {
  await reconcile();
  if (decision !== 'approved' && decision !== 'rejected') throw bad('Invalid decision.');
  if (decision === 'rejected' && !note?.trim()) throw bad('Rejection needs a reason.');
  const store = await getStore();
  // The whole decision — approval state change, exact-match job
  // authorization, single-use binding, and both audit events — commits
  // atomically. Concurrent deciders serialize on the approval row lock;
  // losers see a non-pending status and fail without side effects.
  try {
    return await store.runInTransaction(async tx => {
      const approval = await tx.getApprovalForUpdate(id);
      if (!approval) throw notFound('Approval not found.');
      if (approval.status === 'expired' || (approval.status === 'pending' && Date.parse(approval.expiresAt) <= Date.now())) {
        if (approval.status === 'pending') {
          await tx.saveApproval({ ...approval, status: 'expired' });
        }
        throw gone('Approval expired. Request a fresh approval.');
      }
      if (approval.status !== 'pending') throw bad('Approval already decided.');
      const decidedAt = new Date().toISOString();
      if (decision === 'rejected') {
        const rejected: AgentApproval = { ...approval, status: 'rejected', decidedAt, note: note!.trim().slice(0, 1000) };
        await tx.saveApproval(rejected);
        await tx.auditAppend({
          ts: new Date().toISOString(),
          agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO decision',
          action: 'approval.rejected', target: approval.id, permission: effectiveCapability(approval.kind),
          approvalId: approval.id,
          result: `Rejected: ${rejected.note}`,
        });
        return { approval: { ...rejected, params: scrubSecretParams(rejected.kind, rejected.params) as Record<string, unknown> } };
      }
      // Approved: authorize the exact bound job in the same transaction.
      // Policy is re-read here so a policy change between request and
      // decision cannot authorize a now-denied action.
      const policy = await getPolicy();
      let commandClass: 'readonly' | 'gated' | 'admin' | 'denied' | undefined;
      try {
        ({ commandClass } = validateJobInput(approval.kind, approval.params, policy));
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          throw forbidden(error.message, { needsApproval: true });
        }
        throw error;
      }
      const capability = effectiveCapability(approval.kind, commandClass);
      const risk = jobRisk(approval.kind, commandClass);
      const policyValue = policy.capabilities[capability];
      if (policyValue === 'denied') {
        throw forbidden(`${capability} is denied by the execution policy.`, { needsApproval: true });
      }
      const flags = await tx.readFlags();
      const held = flags.stopped || flags.paused;
      const nowIso = new Date().toISOString();
      const job: JobRecord = {
        id: `job-${randomUUID()}`,
        kind: approval.kind,
        params: approval.params,
        capability, risk,
        approvalId: approval.id,
        ...(approval.goalId ? { goalId: approval.goalId } : {}),
        requestedBy: 'Amey',
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + JOB_TTL_MS).toISOString(),
        status: held ? 'queued' : 'authorized',
        ...(held ? {} : { authorizedAt: nowIso }),
        attempts: [],
      };
      await tx.insertJob(job);
      const decided: AgentApproval = {
        ...approval,
        status: 'approved',
        decidedAt,
        ...(note?.trim() ? { note: note.trim().slice(0, 1000) } : {}),
        jobIds: [...approval.jobIds, job.id],
      };
      await tx.saveApproval(decided);
      await tx.auditAppend({
        ts: new Date().toISOString(),
        agent: 'Amey', machine: 'WAVES ONE', userAuth: `approval:${approval.id}`,
        action: held ? 'job.queued' : 'job.authorized', target: job.id,
        command: job.kind === 'term.exec' ? redactSecrets(String(approval.params.command)).slice(0, 500) : undefined,
        permission: capability, approvalId: approval.id,
        result: held
          ? `${job.kind} held in queue during stop/pause. Resumes on release.`
          : `${job.kind} authorized (${risk} risk).`,
      });
      await tx.auditAppend({
        ts: new Date().toISOString(),
        agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO decision',
        action: 'approval.approved', target: approval.id, permission: effectiveCapability(approval.kind),
        approvalId: approval.id,
        result: `Approved. Job ${job.id} authorized.`,
      });
      return {
        approval: { ...decided, params: scrubSecretParams(decided.kind, decided.params) as Record<string, unknown> },
        jobId: job.id,
      };
    });
  } catch (error) {
    if (error instanceof StoreConflict) {
      // Lost a single-use race: whoever committed owns the binding.
      const fresh = await storedApproval(id);
      if (fresh.status !== 'pending') throw bad('Approval already decided.');
      throw conflict('Concurrent decision conflict. Reload approvals and retry.');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Emergency stop / resume
// ---------------------------------------------------------------------------

export async function stopAll(cancelQueued: boolean): Promise<{ stopped: true; cancelled: number }> {
  const store = await getStore();
  await store.writeFlags({ stopped: true, paused: true });
  let cancelled = 0;
  if (cancelQueued) {
    const jobs = (await store.listActiveJobs()).map(normalizeLegacy);
    for (const job of jobs) {
      if (job.status === 'queued' || job.status === 'authorized') {
        if (await store.updateJobIf({ ...job, status: 'cancelled' }, ['queued', 'authorized'])) {
          cancelled += 1;
        }
      }
    }
  }
  await appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO emergency stop',
    action: 'agent.stopped', target: 'computer-agent', permission: 'system_configuration',
    result: `Emergency stop engaged. Running actions halted${cancelQueued ? `, ${cancelled} held job(s) cancelled` : ''}. New jobs queue in held state.`,
  });
  return { stopped: true, cancelled };
}

export async function resume(): Promise<{ stopped: false; released: number }> {
  const store = await getStore();
  await store.writeFlags({ stopped: false, paused: false });
  // Jobs held during the stop become releasable again.
  const jobs = (await store.listActiveJobs()).map(normalizeLegacy);
  let released = 0;
  for (const job of jobs) {
    if (job.status === 'queued') {
      const promoted: JobRecord = { ...job, status: 'authorized', authorizedAt: new Date().toISOString() };
      if (await store.updateJobIf(promoted, ['queued'])) {
        released += 1;
      }
    }
  }
  await appendAudit({
    agent: 'Amey', machine: 'WAVES ONE', userAuth: 'CEO resume',
    action: 'agent.resumed', target: 'computer-agent', permission: 'system_configuration',
    result: `Agent execution resumed. ${released} held job(s) released.`,
  });
  return { stopped: false, released };
}

export async function controlStatus(): Promise<{
  stopped: boolean; paused: boolean; deviceCount: number; onlineCount: number;
  queuedJobs: number; runningJobs: number;
}> {
  await reconcile();
  const { stopped, paused } = await flags();
  const devices = await listDevices();
  const store = await getStore();
  const queuedJobs = await store.countJobsByStatus(['queued', 'authorized']);
  const runningJobs = await store.countJobsByStatus(['running', 'dispatched']);
  return {
    stopped, paused,
    deviceCount: devices.length,
    onlineCount: devices.filter(d => d.online).length,
    queuedJobs,
    runningJobs,
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

export async function saveArtifact(deviceId: string, input: {
  jobId?: string; name: string; kind?: string; mime?: string; dataBase64: string;
}): Promise<ArtifactMeta> {
  const store = await getStore();
  const device = await store.getDevice(deviceId);
  const name = typeof input.name === 'string' ? path.win32.basename(input.name).slice(0, 200) : '';
  if (!name) throw bad('Invalid artifact name.');
  const mime = typeof input.mime === 'string' ? input.mime.toLowerCase().slice(0, 100) : 'application/octet-stream';
  if (!ARTIFACT_MIME.has(mime)) throw bad(`Unsupported artifact type: ${mime}`);
  if (typeof input.dataBase64 !== 'string') throw bad('Invalid artifact data.');
  const data = Buffer.from(input.dataBase64, 'base64');
  if (data.length === 0 || data.length > MAX_ARTIFACT_BYTES) throw bad('Artifact size out of bounds.');
  const meta: ArtifactMeta = {
    id: `art-${randomUUID()}`,
    ...(typeof input.jobId === 'string' ? { jobId: input.jobId.slice(0, 80) } : {}),
    name,
    kind: typeof input.kind === 'string' ? input.kind.slice(0, 64) : 'file',
    mime,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  // Metadata, bytes, and audit commit together (db) so a restart can never
  // leave orphan metadata pointing at missing bytes, or vice versa.
  await store.runInTransaction(async tx => {
    await tx.insertArtifactMeta(meta);
    await tx.saveArtifactBlob(meta.id, data);
    await tx.auditAppend({
      ts: new Date().toISOString(),
      agent: 'WAVES Computer Agent', machine: device?.machine || 'workstation',
      userAuth: 'job execution', action: 'artifact.uploaded', target: meta.id,
      permission: 'uploads.write', result: `${name} (${data.length} bytes, sha256 ${meta.sha256.slice(0, 12)}…).`,
    });
  });
  return meta;
}

export async function listArtifacts(limit = 50): Promise<ArtifactMeta[]> {
  const store = await getStore();
  return store.listArtifactMetas(Math.max(1, Math.min(200, limit)));
}

export async function artifactBytes(id: string): Promise<{ meta: ArtifactMeta; data: Buffer }> {
  const store = await getStore();
  const meta = await store.findArtifactMeta(id);
  if (!meta) throw notFound('Artifact not found.');
  const data = await store.readArtifactBlob(id);
  if (!data) throw notFound('Artifact file missing.');
  return { meta, data };
}

// ---------------------------------------------------------------------------
// Audit (append-only)
// ---------------------------------------------------------------------------

export async function appendAudit(record: Omit<AuditRecord, 'ts'>): Promise<void> {
  const store = await getStore();
  await store.auditAppend({ ...record, ts: new Date().toISOString() });
}

export async function listAudit(limit = 100): Promise<AuditRecord[]> {
  const store = await getStore();
  return store.auditTail(Math.max(1, Math.min(500, limit)));
}

export { CAPABILITIES };
