// Mirror of src/lib/agent-protocol.ts (v2) — enforcement tables duplicated here so the
// agent enforces the same policy locally (defense in depth, even though the
// server pre-validates). Any change to the source of truth must be ported here;
// src/lib/agent-parity.test.ts asserts parity between the two.
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const CAPABILITIES = [
  'filesystem.read', 'filesystem.write', 'filesystem.move', 'filesystem.rename',
  'filesystem.delete', 'filesystem.execute',
  'terminal.read', 'terminal.execute', 'terminal.admin',
  'applications.open', 'applications.close', 'applications.inspect', 'applications.control',
  'browser.read', 'browser.control',
  'downloads.read', 'downloads.write',
  'uploads.read', 'uploads.write',
  'git.read', 'git.write', 'github.read', 'github.write',
  'deployment.execute', 'credentials.use',
  'external_communication', 'financial_actions', 'system_configuration',
];

export const CAPABILITY_RISK = {
  'filesystem.read': 'low',
  'terminal.read': 'low',
  'applications.inspect': 'low',
  'browser.read': 'low',
  'downloads.read': 'low',
  'uploads.read': 'low',
  'git.read': 'low',
  'github.read': 'low',
  'filesystem.write': 'medium',
  'filesystem.move': 'medium',
  'filesystem.rename': 'medium',
  'terminal.execute': 'medium',
  'applications.open': 'medium',
  'applications.close': 'medium',
  'applications.control': 'medium',
  'browser.control': 'medium',
  'downloads.write': 'medium',
  'uploads.write': 'medium',
  'git.write': 'medium',
  'github.write': 'medium',
  'filesystem.delete': 'high',
  'filesystem.execute': 'high',
  'terminal.admin': 'high',
  'deployment.execute': 'high',
  'credentials.use': 'high',
  'external_communication': 'high',
  'financial_actions': 'high',
  'system_configuration': 'high',
};

export const JOB_KINDS = [
  'fs.list', 'fs.read', 'fs.write', 'fs.mkdir', 'fs.move', 'fs.rename',
  'fs.copy', 'fs.delete', 'fs.hash', 'fs.search', 'fs.meta',
  'term.exec',
  'proc.list', 'proc.start', 'proc.stop',
  'browser.open', 'browser.navigate', 'browser.inspect', 'browser.click',
  'browser.type', 'browser.select', 'browser.scroll', 'browser.download',
  'browser.upload', 'browser.screenshot', 'browser.wait', 'browser.extract',
  'browser.close',
  'git.status', 'git.log', 'git.diff', 'git.commit', 'git.push',
  'git.pull', 'git.branch', 'git.checkout',
  'github.issue', 'github.pr',
  'net.download', 'upload.artifact',
];

export const TERMINAL_STATUSES = [
  'completed', 'failed', 'cancelled', 'denied', 'expired', 'stopped',
];

const JOB_CAPABILITY = {
  'fs.list': 'filesystem.read',
  'fs.read': 'filesystem.read',
  'fs.hash': 'filesystem.read',
  'fs.search': 'filesystem.read',
  'fs.meta': 'filesystem.read',
  'fs.write': 'filesystem.write',
  'fs.mkdir': 'filesystem.write',
  'fs.copy': 'filesystem.write',
  'fs.move': 'filesystem.move',
  'fs.rename': 'filesystem.rename',
  'fs.delete': 'filesystem.delete',
  'term.exec': 'terminal.execute',
  'proc.list': 'applications.inspect',
  'proc.start': 'applications.open',
  'proc.stop': 'applications.close',
  'browser.open': 'browser.read',
  'browser.inspect': 'browser.read',
  'browser.extract': 'browser.read',
  'browser.screenshot': 'browser.read',
  'browser.navigate': 'browser.control',
  'browser.click': 'browser.control',
  'browser.type': 'browser.control',
  'browser.select': 'browser.control',
  'browser.scroll': 'browser.control',
  'browser.download': 'browser.control',
  'browser.upload': 'browser.control',
  'browser.wait': 'browser.control',
  'browser.close': 'browser.control',
  'git.status': 'git.read',
  'git.log': 'git.read',
  'git.diff': 'git.read',
  'git.commit': 'git.write',
  'git.push': 'git.write',
  'git.pull': 'git.write',
  'git.branch': 'git.write',
  'git.checkout': 'git.write',
  'github.issue': 'github.write',
  'github.pr': 'github.write',
  'net.download': 'downloads.write',
  'upload.artifact': 'uploads.write',
};

export function jobCapability(kind) {
  return JOB_CAPABILITY[kind];
}

// Terminal capability depends on the classified command: read-only inspection
// is terminal.read, privilege escalation is terminal.admin, the rest is
// terminal.execute. Unknown classification is treated as execute (conservative).
export function effectiveCapability(kind, commandClass) {
  if (kind === 'term.exec') {
    if (commandClass === 'readonly') return 'terminal.read';
    if (commandClass === 'admin') return 'terminal.admin';
    return 'terminal.execute';
  }
  return JOB_CAPABILITY[kind];
}

export function jobRisk(kind, commandClass) {
  return CAPABILITY_RISK[effectiveCapability(kind, commandClass)];
}

export const DEFAULT_DOMAINS = {
  allowed: ['github.com', 'vercel.com', 'google.com'],
  blocked: [],
};

export const DEFAULT_POLICY = {
  version: 2,
  capabilities: {
    'filesystem.read': 'allowed',
    'terminal.read': 'allowed',
    'applications.inspect': 'allowed',
    'browser.read': 'allowed',
    'downloads.read': 'allowed',
    'uploads.read': 'allowed',
    'git.read': 'allowed',
    'github.read': 'allowed',
    'filesystem.write': 'approval',
    'filesystem.move': 'approval',
    'filesystem.rename': 'approval',
    'filesystem.delete': 'approval',
    'terminal.execute': 'approval',
    'applications.open': 'approval',
    'applications.close': 'approval',
    'applications.control': 'approval',
    'browser.control': 'approval',
    'downloads.write': 'approval',
    'uploads.write': 'approval',
    'git.write': 'approval',
    'github.write': 'approval',
    'filesystem.execute': 'denied',
    'terminal.admin': 'denied',
    'deployment.execute': 'denied',
    'credentials.use': 'denied',
    'external_communication': 'denied',
    'financial_actions': 'denied',
    'system_configuration': 'denied',
  },
  roots: [],
  domains: { allowed: [...DEFAULT_DOMAINS.allowed], blocked: [] },
};

// Migrate a Phase-1 (v1, 18-capability) policy to v2 without weakening it:
// every preserved value carries over; split capabilities inherit the closest
// ancestor's value; new high-risk capabilities default to denied.
export function migratePolicy(stored) {
  const next = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  if (!stored || typeof stored !== 'object') return next;
  const old = (stored.capabilities) || {};
  const take = (key) => {
    const value = old[key];
    return value === 'allowed' || value === 'approval' || value === 'denied' ? value : undefined;
  };
  for (const capability of CAPABILITIES) {
    const direct = take(capability);
    if (direct) {
      next.capabilities[capability] = direct;
      continue;
    }
  }
  // Splits inherit from their Phase-1 ancestor.
  const write = take('filesystem.write');
  if (write) {
    next.capabilities['filesystem.move'] = write;
    next.capabilities['filesystem.rename'] = write;
  }
  const termExec = take('terminal.execute');
  if (termExec) {
    next.capabilities['terminal.read'] = termExec === 'denied' ? 'denied' : 'allowed';
  }
  const appOpen = take('applications.open');
  if (appOpen) {
    next.capabilities['applications.inspect'] = appOpen === 'denied' ? 'denied' : 'allowed';
    next.capabilities['applications.close'] = appOpen;
  }
  const githubAccess = take('github.access');
  if (githubAccess) {
    next.capabilities['github.write'] = githubAccess;
    next.capabilities['github.read'] = githubAccess === 'denied' ? 'denied' : 'allowed';
  }
  const downloadsWrite = take('downloads.write');
  if (downloadsWrite) {
    next.capabilities['uploads.write'] = downloadsWrite;
  }
  return next;
}

const ROOT_PATTERN = /^([A-Za-z]:[\\/]|\\\\)/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeHost(value) {
  const host = String(value).trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !HOST_PATTERN.test(host)) return null;
  return host;
}

// High-risk capabilities must never be silently grantable. The UI hides the
// option and the server rejects it; the agent re-validates on execution.
export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || policy.version !== 2) {
    throw new Error('Policy must be a version-2 policy.');
  }
  if (!policy.capabilities || typeof policy.capabilities !== 'object') {
    throw new Error('Policy must include capabilities.');
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
  if (!Array.isArray(policy.roots) || policy.roots.length > 10) {
    throw new Error('Policy roots must be an array of at most 10 absolute paths.');
  }
  for (const root of policy.roots) {
    if (typeof root !== 'string' || !ROOT_PATTERN.test(root.trim())) {
      throw new Error(`Invalid authorized root: ${String(root).slice(0, 120)}`);
    }
  }
  const domains = policy.domains;
  if (!domains || !Array.isArray(domains.allowed) || !Array.isArray(domains.blocked)) {
    throw new Error('Policy must include domain allow/block lists.');
  }
  if (domains.allowed.length + domains.blocked.length > 200) {
    throw new Error('Domain lists are limited to 200 entries total.');
  }
  for (const host of [...domains.allowed, ...domains.blocked]) {
    if (!normalizeHost(String(host))) {
      throw new Error(`Invalid domain pattern: ${String(host).slice(0, 120)}`);
    }
  }
}

// Domain enforcement. Blocked wins over allowed. Subdomains match only on a
// dot boundary (evilgithub.com is NOT github.com). Non-navigable automation
// schemes (data:, about:blank) are permitted for blank starts and offline
// tests; file:, chrome:, javascript: and friends are refused.
export function isUrlAllowed(rawUrl, domains) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'data:' || String(rawUrl).toLowerCase().startsWith('about:blank')) return true;
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const matches = (pattern) => {
    const clean = String(pattern).toLowerCase().replace(/\.$/, '');
    if (clean.startsWith('*.')) {
      const base = clean.slice(2);
      return host !== base && host.endsWith(`.${base}`);
    }
    return host === clean || host.endsWith(`.${clean}`);
  };
  if (domains.blocked.some(matches)) return false;
  return domains.allowed.some(matches);
}

// Read-only commands may run under terminal.read without an approval.
// Admin commands need terminal.admin (denied by default: not implemented).
// Keep the readonly list narrow: anything that writes, installs, transmits,
// or evaluates code is gated; destructive patterns are denied outright.
const READONLY_PATTERNS = [
  /^(dir|ls|type|cat|more)\b/i,
  /^git\s+(status|log|diff|branch|remote\s+-v|rev-parse)\b/i,
  /^(node|npm|git|python|docker|code)\s+--version$/i,
  /^tasklist\b/i,
  /^echo\b/i,
  /^where\b/i,
];

const ADMIN_PATTERNS = [
  /\brunas\b/i,
  /\bpsexec\b/i,
  /\b(gsudo|sudo)\b/i,
  /\b(New-LocalUser|New-LocalGroup|Add-LocalGroupMember|net\s+(user|localgroup))\b/i,
  /\bsc\.exe\b/i,
  /\bschtasks\b/i,
  /\bdism\b/i,
  /\b(Add-WindowsCapability|Enable-WindowsOptionalFeature)\b/i,
  /\bSet-MpPreference\b/i,
  /\bvssadmin\b/i,
  /\bwbadmin\b/i,
  /\bwevtutil\s+cl\b/i,
  /\breg\s+(delete|add)\s+HKLM\b/i,
  /\bSet-Service\b/i,
];

const DENIED_PATTERNS = [
  /\brm\s+-rf?\s+(\/|~|C:\\)/i,
  /\b(Remove-Item|Format-|Clear-Disk|Reset-Computer)\b/i,
  /\bshutdown\b|\brestart-computer\b/i,
  /\breg\s+delete\s+HKLM\b/i,
  /\b(Invoke-Expression|iex)\b/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b.*\|\s*(Invoke-Expression|iex)/i,
  /\b(format|diskpart|bcdedit|takeown|icacls)\b/i,
  /\b(set-executionpolicy)\b.*\b(unrestricted|bypass)\b/i,
  /__COMPAT_LAYER|\\Windows\\(System32|SYSWOW64)\b.*(del|erase|move|ren)/i,
];

export function classifyCommand(command) {
  const normalized = String(command).trim().replace(/\s+/g, ' ');
  if (!normalized) return 'denied';
  if (DENIED_PATTERNS.some((pattern) => pattern.test(normalized))) return 'denied';
  if (ADMIN_PATTERNS.some((pattern) => pattern.test(normalized))) return 'admin';
  if (READONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return 'readonly';
  return 'gated';
}

// Sandbox confinement. Returns the absolute path inside root, or null when
// the target escapes (traversal, absolute path outside root, alternate data
// streams, UNC outside an authorized UNC root).
export function resolveSandboxPath(root, target) {
  const normalizedRoot = path.win32.normalize(root).replace(/[\\/]+$/, '').toLowerCase();
  const resolved = path.win32.isAbsolute(target)
    ? path.win32.normalize(target)
    : path.win32.normalize(path.win32.join(root, target));
  const lowered = resolved.toLowerCase();
  if (lowered !== normalizedRoot && !lowered.startsWith(normalizedRoot + '\\')) return null;
  // Alternate data streams (file:stream) are refused segment-wise. The drive
  // letter of an absolute target is exempt; everything else with a colon is.
  const relative = lowered === normalizedRoot ? '' : lowered.slice(normalizedRoot.length + 1);
  for (const segment of relative.split('\\')) {
    if (segment.includes(':')) return null;
  }
  return resolved;
}

// Multi-root resolution. An optional pinned root must itself be configured;
// otherwise the first configured root applies. Null when unresolvable.
export function resolveAcrossRoots(roots, target, pinnedRoot) {
  if (!Array.isArray(roots) || roots.length === 0) return null;
  let base = roots[0];
  if (pinnedRoot !== undefined) {
    const match = roots.find((r) => String(r).toLowerCase() === String(pinnedRoot).toLowerCase());
    if (!match) return null;
    base = match;
  }
  const resolved = resolveSandboxPath(base, target);
  if (!resolved) return null;
  return { path: resolved, root: base };
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Secrets must never reach the browser or the audit log in readable form.
// browser.type text is replaced by a length + hash binding proof; the agent
// receives the real text only inside the authenticated dispatch.
export function scrubSecretParams(kind, params) {
  if (kind === 'browser.type' && typeof params.text === 'string') {
    const { text, ...rest } = params;
    return { ...rest, text: '[REDACTED]', textLength: text.length, textSha256: sha256Hex(text) };
  }
  return params;
}

// Never transmit raw secrets. Agent and server both redact command output,
// logs, and audit fields before storage or display.
const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]{8,})\b/g,
  /\b[A-Za-z0-9_-]{24,}\b/g,
  /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)([^"'\s;,}]{4,})/gi,
];

export function redactSecrets(text) {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix) =>
      typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return redacted;
}

// Pairing codes are short-lived, single-use claim tokens shown in the agent
// terminal and typed into WAVES ONE. They are NOT the device credential.
export function generatePairingCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

// Long-term device credential. Stored only in the agent's OS profile and as
// a hash on the control plane. Never sent to the browser.
export function generateDeviceSecret() {
  return randomBytes(32).toString('hex');
}
