#!/usr/bin/env node
// Rotate the device credential: POST /api/agent/rotate with the current
// Bearer credential, persist the returned { secret }, and confirm without
// ever printing the secret itself.
import { loadIdentity, saveIdentity } from './src/secret.mjs';

const DEFAULT_SERVER = 'http://127.0.0.1:3100';

function parseArgs(argv) {
  let server = DEFAULT_SERVER;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) server = argv[++i];
    else if (argv[i] === '--help') {
      console.log('Usage: node agent/src/rotate.mjs [--server http://127.0.0.1:3100]');
      process.exit(0);
    }
  }
  return { server: server.replace(/\/+$/, '') };
}

const { server } = parseArgs(process.argv);
let identity;
try {
  identity = await loadIdentity();
} catch (err) {
  console.error(`Rotation failed: ${err.message}`);
  process.exit(1);
}

let res;
try {
  res = await fetch(`${server}/api/agent/rotate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${identity.deviceId}.${identity.secret}`,
    },
  });
} catch (err) {
  console.error(`Rotation failed: cannot reach server at ${server}: ${err.message}`);
  process.exit(1);
}

let body = null;
try {
  body = await res.json();
} catch {
  // handled below
}

if (res.status === 401) {
  console.error('Rotation failed (HTTP 401): credential rejected by the control plane (revoked?). Delete the identity and re-pair, then retry.');
  process.exit(1);
}
if (!res.ok || !body?.secret) {
  console.error(`Rotation failed (HTTP ${res.status}): ${body?.error ?? res.statusText ?? 'unknown error'}`);
  process.exit(1);
}
if (typeof body.secret !== 'string' || !/^[0-9a-f]{32,}$/i.test(body.secret)) {
  console.error('Rotation failed: server returned an invalid secret.');
  process.exit(1);
}

try {
  await saveIdentity(identity.deviceId, body.secret);
} catch (err) {
  console.error(`Rotation failed: could not save the new credential: ${err.message}`);
  process.exit(1);
}

console.log(`Secret rotated for device ${identity.deviceId}. Restart the agent to use the new credential.`);
