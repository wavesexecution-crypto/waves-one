// Device identity: load-or-create { deviceId, secret } persisted under
// %APPDATA%/waves-one-agent/identity.json. The secret is never logged.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';

export const AGENT_VERSION = '1.0.0';

export function agentDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'waves-one-agent');
}

export function identityPath() {
  return path.join(agentDir(), 'identity.json');
}

function newIdentity() {
  const deviceId = typeof randomUUID === 'function' ? randomUUID() : randomBytes(16).toString('hex');
  return { deviceId, secret: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
}

function validIdentity(value) {
  return (
    value &&
    typeof value.deviceId === 'string' && value.deviceId.length > 0 &&
    typeof value.secret === 'string' && value.secret.length >= 32
  );
}

export async function loadOrCreateIdentity() {
  await fs.mkdir(agentDir(), { recursive: true });
  try {
    const raw = await fs.readFile(identityPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (validIdentity(parsed)) return { deviceId: parsed.deviceId, secret: parsed.secret };
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  const identity = newIdentity();
  await fs.writeFile(identityPath(), JSON.stringify(identity, null, 2));
  return { deviceId: identity.deviceId, secret: identity.secret };
}

export async function loadIdentity() {
  let raw;
  try {
    raw = await fs.readFile(identityPath(), 'utf8');
  } catch {
    throw new Error(`No agent identity found. Run 'node agent/pair.mjs --server <url>' first.`);
  }
  const parsed = JSON.parse(raw);
  if (!validIdentity(parsed)) {
    throw new Error(`Agent identity is corrupt. Delete ${identityPath()} and re-pair.`);
  }
  return { deviceId: parsed.deviceId, secret: parsed.secret };
}

export async function saveIdentity(deviceId, secret) {
  if (typeof deviceId !== 'string' || !deviceId) {
    throw new Error('saveIdentity requires a deviceId string.');
  }
  if (typeof secret !== 'string' || !/^[0-9a-f]{32,}$/i.test(secret)) {
    throw new Error('saveIdentity requires a valid secret string.');
  }
  await fs.mkdir(agentDir(), { recursive: true });
  let createdAt = new Date().toISOString();
  try {
    const raw = await fs.readFile(identityPath(), 'utf8');
    const existing = JSON.parse(raw);
    if (typeof existing?.createdAt === 'string' && existing.createdAt) {
      createdAt = existing.createdAt;
    }
  } catch {
    // No usable existing identity; fresh timestamps apply.
  }
  const next = { deviceId, secret, createdAt, rotatedAt: new Date().toISOString() };
  await fs.writeFile(identityPath(), JSON.stringify(next, null, 2));
  return { deviceId };
}
