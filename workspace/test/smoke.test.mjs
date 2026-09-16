import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

test('sandbox checklist exists', () => {
  assert.ok(existsSync(join(root, 'notes', 'launch-checklist.md')));
});

test('sandbox readme describes the boundary', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /sandbox/i);
});
