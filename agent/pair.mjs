#!/usr/bin/env node
// Pair this device with the WAVES ONE control plane. Generates the device
// identity if missing, then registers (deviceId + secret hash + pairing code).
// The secret itself is never transmitted or printed.
import { createHash } from 'node:crypto';
import os from 'node:os';
import { loadOrCreateIdentity, AGENT_VERSION } from './src/secret.mjs';
import { generatePairingCode } from './src/policy.mjs';

const DEFAULT_SERVER = 'http://127.0.0.1:3100';

function parseArgs(argv) {
  let server = DEFAULT_SERVER;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) server = argv[++i];
    else if (argv[i] === '--help') {
      console.log('Usage: node agent/pair.mjs [--server http://127.0.0.1:3100]');
      process.exit(0);
    }
  }
  return { server: server.replace(/\/+$/, '') };
}

const { server } = parseArgs(process.argv);
const identity = await loadOrCreateIdentity();
const pairingCode = generatePairingCode();
const secretHash = createHash('sha256').update(identity.secret, 'utf8').digest('hex');
const machine = os.hostname();

let res;
try {
  res = await fetch(`${server}/api/agent/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: identity.deviceId,
      secretHash,
      machine,
      pairingCode,
      agentVersion: AGENT_VERSION,
    }),
  });
} catch (err) {
  console.error(`Pairing failed: cannot reach server at ${server}: ${err.message}`);
  process.exit(1);
}

let body = null;
try {
  body = await res.json();
} catch {
  // handled below
}
if (!res.ok || !body?.ok) {
  console.error(`Pairing failed (HTTP ${res.status}): ${body?.error ?? res.statusText}`);
  process.exit(1);
}

console.log('');
console.log(`  Pairing code: ${pairingCode}`);
console.log('');
console.log('  Next step: open the WAVES ONE control plane and enter the pairing');
console.log('  code above to approve this device (device ID shown in the log line).');
console.log('  The code is single-use. Then start the agent with:');
console.log(`    node agent/src/index.mjs --server ${server}`);
console.log('');
