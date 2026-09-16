#!/usr/bin/env node
// WAVES ONE Computer Agent: poll the control plane, validate every job
// (defense in depth), execute one job at a time, report results.
// Windows-first, zero npm dependencies. Never logs the device secret.
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadIdentity, AGENT_VERSION } from './secret.mjs';
import {
  JOB_KINDS,
  jobCapability,
  jobRisk,
  validatePolicy,
  classifyCommand,
  resolveSandboxPath,
  redactSecrets,
} from './policy.mjs';
import { executeJob } from './exec/index.mjs';

const POLL_MS = 2000;
const HEARTBEAT_MS = 10000;
const BACKOFFS_MS = [2000, 5000, 15000, 30000];
const DEFAULT_SERVER = 'http://127.0.0.1:3100';
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || 'D:\\waves-one\\workspace';
const PATH_FIELDS = ['path', 'from', 'to', 'cwd'];

function parseArgs(argv) {
  let server = DEFAULT_SERVER;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) server = argv[++i];
    else if (argv[i] === '--help') {
      console.log('Usage: node agent/src/index.mjs [--server http://127.0.0.1:3100]');
      process.exit(0);
    }
  }
  return { server: server.replace(/\/+$/, '') };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  console.log(
    new Date().toISOString(),
    ...args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a)),
  );
}

function authHeaders(identity) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${identity.deviceId}.${identity.secret}`,
  };
}

async function api(server, identity, method, route, body) {
  const res = await fetch(`${server}${route}`, {
    method,
    headers: authHeaders(identity),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${res.status}: invalid JSON response`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.error ?? text ?? res.statusText}`);
  return json;
}

// --- events (batched, max 50 per POST) ---
const eventQueue = [];

function queueEvent(level, message, jobId) {
  eventQueue.push({
    level,
    message: redactSecrets(String(message)).slice(0, 2000),
    ...(jobId ? { jobId } : {}),
  });
  if (eventQueue.length > 200) eventQueue.splice(0, eventQueue.length - 200);
}

async function flushEvents(server, identity) {
  if (!eventQueue.length) return;
  const batch = eventQueue.splice(0, 50);
  try {
    await api(server, identity, 'POST', '/api/agent/events', { events: batch });
  } catch (err) {
    log(`events flush failed: ${err.message}`);
    eventQueue.unshift(...batch);
    eventQueue.splice(200);
  }
}

async function sendHeartbeat(server, identity, status, currentJobId) {
  const body = { status, machine: os.hostname(), agentVersion: AGENT_VERSION };
  if (currentJobId) body.currentJobId = currentJobId;
  await api(server, identity, 'POST', '/api/agent/heartbeat', body);
}

async function postResult(server, identity, payload) {
  const body = { ...payload };
  if (typeof body.output === 'string') body.output = redactSecrets(body.output);
  if (typeof body.error === 'string') body.error = redactSecrets(body.error);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api(server, identity, 'POST', '/api/agent/result', body);
      return true;
    } catch (err) {
      log(`result post failed (attempt ${attempt}/3): ${err.message}`);
      if (attempt < 3) await sleep(2000);
    }
  }
  return false;
}

// --- job validation (defense in depth; server pre-validates too) ---
function validateJob(job, policy, workspaceRoot) {
  if (!job || typeof job.kind !== 'string' || !JOB_KINDS.includes(job.kind)) {
    return { valid: false, error: `Refused: unknown or unsupported job kind '${job?.kind}'` };
  }
  const params = job.params && typeof job.params === 'object' ? job.params : {};
  let policyValue;
  try {
    if (!policy) throw new Error('missing policy');
    validatePolicy(policy);
    policyValue = policy.capabilities[jobCapability(job.kind)];
  } catch (err) {
    return { valid: false, error: `Refused: invalid policy in poll response (${err.message})` };
  }
  if (policyValue !== 'allowed' && policyValue !== 'approval') {
    return { valid: false, error: `Refused: capability '${jobCapability(job.kind)}' is denied by policy` };
  }
  let commandClass;
  if (job.kind === 'term.exec') {
    if (typeof params.command !== 'string' || !params.command.trim()) {
      return { valid: false, error: 'Refused: term.exec requires a command' };
    }
    commandClass = classifyCommand(params.command);
    if (commandClass === 'denied') {
      return { valid: false, error: 'Refused: command denied by policy', audit: true };
    }
  }
  const risk = jobRisk(job.kind, commandClass);
  if (policyValue === 'approval' || risk !== 'low') {
    if (typeof job.approvalId !== 'string' || !job.approvalId) {
      return { valid: false, error: `Refused: ${job.kind} requires an approved approvalId` };
    }
  }
  for (const field of PATH_FIELDS) {
    if (params[field] !== undefined) {
      if (typeof params[field] !== 'string' || resolveSandboxPath(workspaceRoot, params[field]) === null) {
        return { valid: false, error: `Refused: ${field} escapes sandbox` };
      }
    }
  }
  return { valid: true, params };
}

async function runJob(server, identity, job, policy) {
  const startedAt = Date.now();
  try {
    await sendHeartbeat(server, identity, 'running', job.id);
  } catch (err) {
    log(`heartbeat failed: ${err.message}`);
  }

  const check = validateJob(job, policy, WORKSPACE_ROOT);
  if (!check.valid) {
    queueEvent('warning', `Refused ${job.kind} (${job.id}): ${check.error}`, job.id);
    await flushEvents(server, identity);
    await postResult(server, identity, {
      jobId: job.id,
      ok: false,
      error: check.error,
      durationMs: Date.now() - startedAt,
    });
    try {
      await sendHeartbeat(server, identity, 'idle');
    } catch { /* next loop retries */ }
    return;
  }

  const cancel = { cancelled: false, reason: null, kill: null };
  const ctx = {
    workspaceRoot: WORKSPACE_ROOT,
    approvalId: job.approvalId,
    jobId: job.id,
    onEvent: (level, message) => queueEvent(level, message, job.id),
    isCancelled: () => cancel.cancelled,
    cancelReason: () => cancel.reason,
    registerKill: (fn) => {
      cancel.kill = fn;
    },
  };

  const watcher = setInterval(async () => {
    try {
      const flags = await api(server, identity, 'GET', '/api/agent/flags');
      if ((flags.stop || flags.cancelCurrent) && !cancel.cancelled) {
        cancel.cancelled = true;
        cancel.reason = flags.stop ? 'stop' : 'cancel';
        queueEvent(
          'warning',
          `Cancelling ${job.kind} (${job.id}): ${flags.stop ? 'Stopped by owner' : 'Cancelled by owner'}`,
          job.id,
        );
        try {
          await cancel.kill?.();
        } catch { /* best effort */ }
      }
    } catch (err) {
      log(`flags poll failed: ${err.message}`);
    }
  }, POLL_MS);

  let result;
  try {
    result = await executeJob(job.kind, check.params, ctx);
  } catch (err) {
    result = { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearInterval(watcher);
  }

  if (cancel.cancelled) {
    result = {
      ok: false,
      error: cancel.reason === 'stop' ? 'Stopped by owner' : 'Job cancelled by owner',
      output: result?.output,
    };
  }
  await postResult(server, identity, {
    jobId: job.id,
    ok: result.ok,
    output: result.output,
    error: result.error,
    before: result.before,
    after: result.after,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
  });
  await flushEvents(server, identity);
  try {
    await sendHeartbeat(server, identity, 'idle');
  } catch (err) {
    log(`heartbeat failed: ${err.message}`);
  }
}

async function main() {
  const { server } = parseArgs(process.argv);
  let identity;
  try {
    identity = await loadIdentity();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  log(`agent starting (device ${identity.deviceId}, server ${server}, workspace ${WORKSPACE_ROOT})`);

  let failCount = 0;
  let lastHeartbeat = 0;
  let lastHeartbeatStatus = '';

  for (;;) {
    let poll = null;
    try {
      poll = await api(server, identity, 'GET', '/api/agent/next');
      failCount = 0;
    } catch (err) {
      failCount += 1;
      // 401 means the credential is invalid (revoked). Retrying is pointless
      // and noisy — exit so the owner re-pairs deliberately.
      if (/^HTTP 401/.test(err.message)) {
        log('credential rejected by control plane (revoked?). Delete the identity and re-pair. Exiting.');
        process.exit(2);
      }
      const wait = BACKOFFS_MS[Math.min(failCount - 1, BACKOFFS_MS.length - 1)];
      log(`poll failed: ${err.message} (retry in ${wait / 1000}s)`);
      await sleep(wait);
      continue;
    }

    const { job = null, policy = null, stop = false, paused = false } = poll ?? {};
    await flushEvents(server, identity);

    if (Date.now() - lastHeartbeat > HEARTBEAT_MS || lastHeartbeatStatus !== 'idle') {
      try {
        await sendHeartbeat(server, identity, 'idle');
        lastHeartbeat = Date.now();
        lastHeartbeatStatus = 'idle';
      } catch (err) {
        log(`heartbeat failed: ${err.message}`);
      }
    }

    // stop: idle without picking jobs. paused: don't pick new jobs.
    if (stop || paused || !job) {
      await sleep(POLL_MS);
      continue;
    }
    await runJob(server, identity, job, policy);
    lastHeartbeat = 0;
    lastHeartbeatStatus = '';
  }
}

process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err?.message ?? err}`);
});

await main();
