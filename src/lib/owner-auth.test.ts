import { afterEach, describe, expect, it } from 'vitest';
import { requireOwner } from './owner-auth';

describe('owner gate', () => {
  const saved = process.env.WAVES_OWNER_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.WAVES_OWNER_TOKEN;
    else process.env.WAVES_OWNER_TOKEN = saved;
  });
  it('passes through when no token is configured (localhost trust)', () => {
    delete process.env.WAVES_OWNER_TOKEN;
    expect(requireOwner(new Request('http://localhost/x'))).toBeNull();
  });
  it('rejects missing and wrong tokens when enforced', () => {
    process.env.WAVES_OWNER_TOKEN = 'owner-secret';
    expect(requireOwner(new Request('http://x/'))?.status).toBe(401);
    expect(requireOwner(new Request('http://x/', { headers: { authorization: 'Bearer wrong' } }))?.status).toBe(401);
    expect(requireOwner(new Request('http://x/', { headers: { authorization: 'Bearer owner-secret' } }))).toBeNull();
  });
});
