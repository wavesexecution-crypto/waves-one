import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, CAPABILITY_RISK, DEFAULT_POLICY, JOB_KINDS,
  classifyCommand as tsClassify,
  jobCapability as tsCapability,
  redactSecrets as tsRedact,
  resolveSandboxPath as tsResolve,
} from './agent-protocol';
import * as agentPolicy from '../../agent/src/policy.mjs';

// The agent service mirrors the enforcement tables in plain .mjs.
// Any drift between the two is a security defect: fail loudly.
describe('agent policy parity', () => {
  it('mirrors capabilities, risks, and default policy', () => {
    expect([...agentPolicy.CAPABILITIES].sort()).toEqual([...CAPABILITIES].sort());
    expect(agentPolicy.CAPABILITY_RISK).toEqual(CAPABILITY_RISK);
    expect([...agentPolicy.JOB_KINDS].sort()).toEqual([...JOB_KINDS].sort());
    for (const kind of JOB_KINDS) {
      expect(agentPolicy.jobCapability(kind)).toBe(tsCapability(kind));
    }
    expect(agentPolicy.DEFAULT_POLICY).toEqual(DEFAULT_POLICY);
  });
  it('classifies commands identically', () => {
    const samples = [
      'git status', 'dir', 'npm test', 'git commit -m "fix"',
      'Remove-Item C:\\Windows -Recurse', 'rm -rf /', 'shutdown /s',
      'node scripts/build.mjs', '',
    ];
    for (const command of samples) {
      expect(agentPolicy.classifyCommand(command)).toBe(tsClassify(command));
    }
  });
  it('confines sandbox paths identically', () => {
    const root = 'D:\\waves-one\\workspace';
    for (const target of ['notes/a.md', '..\\x', 'C:\\Windows', '..', 'a\\..\\b']) {
      expect(agentPolicy.resolveSandboxPath(root, target)).toBe(tsResolve(root, target));
    }
  });
  it('redacts the same secret shapes', () => {
    const sample = 'token=abc123XYZ789abc123XYZ789 password: hunter2-hunter2-hunter2';
    expect(tsRedact(sample)).not.toContain('abc123XYZ789');
    expect(agentPolicy.redactSecrets(sample)).not.toContain('abc123XYZ789');
  });
});
