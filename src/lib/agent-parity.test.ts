import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, CAPABILITY_RISK, DEFAULT_POLICY, JOB_KINDS,
  classifyCommand as tsClassify,
  jobCapability as tsCapability,
  redactSecrets as tsRedact,
  resolveSandboxPath as tsResolve,
  resolveAcrossRoots as tsRoots,
  isUrlAllowed as tsDomains,
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
      'runas /user:admin cmd', 'schtasks /create /tn t', 'reg add HKLM\\Sw\\x /v y',
      'node scripts/build.mjs', '',
    ];
    for (const command of samples) {
      expect(agentPolicy.classifyCommand(command)).toBe(tsClassify(command));
    }
  });
  it('confines sandbox paths identically', () => {
    const root = 'D:\\waves-one\\workspace';
    for (const target of ['notes/a.md', '..\\x', 'C:\\Windows', '..', 'a\\..\\b', 'notes:secret', 'a\\b:c']) {
      expect(agentPolicy.resolveSandboxPath(root, target)).toBe(tsResolve(root, target));
    }
  });
  it('resolves roots and domains identically', () => {
    const roots = ['D:\\waves-one', 'D:\\seai'];
    for (const [target, pin] of [['a\\x', undefined], ['a\\x', 'D:\\seai'], ['..\\x', undefined], ['a', 'C:\\evil']] as const) {
      expect(agentPolicy.resolveAcrossRoots(roots, target, pin)).toEqual(tsRoots(roots, target, pin));
    }
    const domains = { allowed: ['github.com', '*.vercel.com'], blocked: ['evil.github.com'] };
    for (const url of ['https://github.com/o', 'https://evilgithub.com/', 'https://evil.github.com/', 'https://a.vercel.com/', 'https://vercel.com/', 'data:text/html,x', 'file:///C:/x']) {
      expect(agentPolicy.isUrlAllowed(url, domains)).toBe(tsDomains(url, domains));
    }
  });
  it('redacts the same secret shapes', () => {
    const sample = 'token=abc123XYZ789abc123XYZ789 password: hunter2-hunter2-hunter2';
    expect(tsRedact(sample)).not.toContain('abc123XYZ789');
    expect(agentPolicy.redactSecrets(sample)).not.toContain('abc123XYZ789');
  });
});
