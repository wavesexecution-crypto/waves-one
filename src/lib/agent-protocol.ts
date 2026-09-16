import { randomBytes } from 'crypto';
import path from 'path';

// Single source of truth for the Computer Agent security model.
// The agent service mirrors the enforcement tables in agent/src/policy.mjs;
// src/lib/agent-protocol.test.ts asserts parity between the two.

export const CAPABILITIES = [
  'filesystem.read', 'filesystem.write', 'filesystem.delete',
  'terminal.execute',
  'applications.open', 'applications.control',
  'browser.read', 'browser.control',
  'downloads.read', 'downloads.write',
  'git.read', 'git.write', 'github.access',
  'deployment.execute', 'credentials.use',
  'external_communication', 'financial_actions', 'system_configuration',
] as const;
export type CapabilityId = (typeof CAPABILITIES)[number];
export type Risk = 'low' | 'medium' | 'high';

export const CAPABILITY_RISK: Record<CapabilityId, Risk> = {
  'filesystem.read': 'low',
  'terminal.execute': 'low', // terminal jobs are additionally classified per-command
  'applications.open': 'low',
  'browser.read': 'low',
  'downloads.read': 'low',
  'git.read': 'low',
  'filesystem.write': 'medium',
  'applications.control': 'medium',
  'browser.control': 'medium',
  'downloads.write': 'medium',
  'git.write': 'medium',
  'github.access': 'medium',
  'filesystem.delete': 'high',
  'deployment.execute': 'high',
  'credentials.use': 'high',
  'external_communication': 'high',
  'financial_actions': 'high',
  'system_configuration': 'high',
};

export const JOB_KINDS = [
  'fs.list', 'fs.read', 'fs.write', 'fs.mkdir', 'fs.move', 'fs.delete',
  'term.exec',
  'proc.list', 'proc.start', 'proc.stop',
  'browser.open',
  'git.status', 'git.log', 'git.diff', 'git.commit', 'git.push',
  'net.download',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';

const JOB_CAPABILITY: Record<JobKind, CapabilityId> = {
  'fs.list': 'filesystem.read',
  'fs.read': 'filesystem.read',
  'fs.write': 'filesystem.write',
  'fs.mkdir': 'filesystem.write',
  'fs.move': 'filesystem.write',
  'fs.delete': 'filesystem.delete',
  'term.exec': 'terminal.execute',
  'proc.list': 'applications.open',
  'proc.start': 'applications.control',
  'proc.stop': 'applications.control',
  'browser.open': 'applications.open',
  'git.status': 'git.read',
  'git.log': 'git.read',
  'git.diff': 'git.read',
  'git.commit': 'git.write',
  'git.push': 'github.access',
  'net.download': 'downloads.write',
};

export function jobCapability(kind: JobKind): CapabilityId {
  return JOB_CAPABILITY[kind];
}

// Intrinsic risk per job kind. terminal jobs are re-classified per command
// (readonly commands stay low; anything else is at least medium).
export function jobRisk(kind: JobKind, commandClass?: CommandClass): Risk {
  if (kind === 'term.exec') {
    if (commandClass === 'readonly') return 'low';
    return 'medium';
  }
  return CAPABILITY_RISK[JOB_CAPABILITY[kind]];
}

export type PolicyValue = 'allowed' | 'approval' | 'denied';
export interface Policy {
  version: number;
  capabilities: Record<CapabilityId, PolicyValue>;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  capabilities: {
    'filesystem.read': 'allowed',
    'terminal.execute': 'allowed',
    'applications.open': 'allowed',
    'browser.read': 'allowed',
    'downloads.read': 'allowed',
    'git.read': 'allowed',
    'filesystem.write': 'approval',
    'applications.control': 'approval',
    'browser.control': 'denied',
    'downloads.write': 'approval',
    'git.write': 'approval',
    'github.access': 'approval',
    'filesystem.delete': 'approval',
    'deployment.execute': 'denied',
    'credentials.use': 'denied',
    'external_communication': 'denied',
    'financial_actions': 'denied',
    'system_configuration': 'denied',
  },
};

// High-risk capabilities must never be silently grantable. The UI hides the
// option and the server rejects it; the agent re-validates on execution.
export function validatePolicy(policy: Policy): void {
  if (!policy || typeof policy.version !== 'number' || !policy.capabilities) {
    throw new Error('Policy must include a version and capabilities.');
  }
  for (const capability of CAPABILITIES) {
    const value = policy.capabilities[capability];
    if (value !== 'allowed' && value !== 'approval' && value !== 'denied') {
      throw new Error(`Unknown policy value for ${capability}.`);
    }
    if (CAPABILITY_RISK[capability] === 'high' && value === 'allowed') {
      throw new Error(`High-risk capability ${capability} cannot be set to allowed.`);
    }
  }
}

export type CommandClass = 'readonly' | 'gated' | 'denied';

// Read-only commands may run under terminal.execute without an approval.
// Keep this list narrow: anything that writes, installs, transmits, or
// evaluates code is gated; destructive patterns are denied outright.
const READONLY_PATTERNS: RegExp[] = [
  /^(dir|ls|type|cat|more)\b/i,
  /^git\s+(status|log|diff|branch|remote\s+-v|rev-parse)\b/i,
  /^(node|npm|git)\s+--version$/i,
  /^tasklist\b/i,
  /^echo\b/i,
];

const DENIED_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+(\/|~|C:\\)/i,
  /\b(Remove-Item|Format-|Clear-Disk|Reset-Computer)\b/i,
  /\bshutdown\b|\brestart-computer\b/i,
  /\breg\s+(delete|add)\s+HKLM\b/i,
  /\b(Invoke-Expression|iex)\b/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b.*\|\s*(Invoke-Expression|iex)/i,
  /\b(format|diskpart|bcdedit|takeown|icacls)\b/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\b(set-executionpolicy)\b.*\b(unrestricted|bypass)\b/i,
  /__COMPAT_LAYER|\\Windows\\(System32|SYSWOW64)\b.*(del|erase|move|ren)/i,
];

export function classifyCommand(command: string): CommandClass {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized) return 'denied';
  if (DENIED_PATTERNS.some(pattern => pattern.test(normalized))) return 'denied';
  if (READONLY_PATTERNS.some(pattern => pattern.test(normalized))) return 'readonly';
  return 'gated';
}

// Sandbox confinement. Returns the absolute path inside root, or null when
// the target escapes the sandbox (traversal, absolute path outside root).
export function resolveSandboxPath(root: string, target: string): string | null {
  const normalizedRoot = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
  // Absolute targets are resolved directly so `C:\Windows\...` cannot be
  // smuggled in by joining; relative targets resolve against the root.
  const resolved = path.win32.isAbsolute(target)
    ? path.win32.normalize(target)
    : path.win32.normalize(path.win32.join(root, target));
  const lowered = resolved.toLowerCase();
  if (lowered !== normalizedRoot && !lowered.startsWith(normalizedRoot + '\\')) return null;
  return resolved;
}

// Never transmit raw secrets. Agent and server both redact command output,
// logs, and audit fields before storage or display.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]{8,})\b/g,
  /\b[A-Za-z0-9_-]{24,}\b/g,
  /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)([^"'\s;,}]{4,})/gi,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return redacted;
}

// Pairing codes are short-lived, single-use claim tokens shown in the agent
// terminal and typed into WAVES ONE. They are NOT the device credential.
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

// Long-term device credential. Stored only in the agent's OS profile and as
// a hash on the control plane. Never sent to the browser.
export function generateDeviceSecret(): string {
  return randomBytes(32).toString('hex');
}
