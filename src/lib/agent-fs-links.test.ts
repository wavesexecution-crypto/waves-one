import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { refuseOutsideRoot, resolveReal } from '../../agent/src/exec/fs.mjs';

// Real filesystem link-escape tests (not just pure-function cases): build an
// actual junction (no privilege required on Windows) pointing outside the
// roots and prove the agent refuses to write through it.
describe('agent link-escape protection', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-links-'));
  const roots = [path.join(base, 'sandbox')];
  const outside = path.join(base, 'outside');
  fs.mkdirSync(roots[0], { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'do not touch');

  it('refuses writes through a real junction pointing outside the roots', () => {
    const link = path.join(roots[0], 'evil-link');
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, outside], { stdio: 'pipe' });
    } catch {
      console.log('junction creation unavailable; skipping');
      return;
    }
    return (async () => {
      const target = path.join(link, 'victim.txt');
      const real = await resolveReal(roots[0], target);
      expect(real).not.toBeNull();
      expect(real!.toLowerCase().startsWith(outside.toLowerCase())).toBe(true);
      const refusal = await refuseOutsideRoot(roots[0], target, 'fs.write target');
      expect(refusal).toMatch(/escapes the sandbox/i);
    })();
  });

  it('refuses alternate data stream paths even when lexically inside', async () => {
    const refusal = await refuseOutsideRoot(roots[0], path.join(roots[0], 'notes:secret'), 'fs.write target');
    expect(typeof refusal).toBe('string');
    expect(refusal).toMatch(/alternate data streams|escapes the sandbox/i);
  });

  it('allows ordinary in-roots writes', async () => {
    const refusal = await refuseOutsideRoot(roots[0], path.join(roots[0], 'notes', 'todo.md'), 'fs.write target');
    expect(refusal).toBeNull();
  });
});
