import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireOwner } from './owner-auth';

describe('owner gate', () => {
  const saved = process.env.WAVES_OWNER_TOKEN;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (saved === undefined) delete process.env.WAVES_OWNER_TOKEN;
    else process.env.WAVES_OWNER_TOKEN = saved;
  });
  it('passes through when no token is configured (localhost trust)', () => {
    delete process.env.WAVES_OWNER_TOKEN;
    expect(requireOwner(new Request('http://localhost/x'))).toBeNull();
  });
  it('fails closed in production when the owner token is missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.WAVES_OWNER_TOKEN;
    expect(requireOwner(new Request('https://one.wavesco.in/api/control/jobs'))?.status).toBe(401);
  });
  it('fails closed on Vercel regardless of NODE_ENV', () => {
    vi.stubEnv('VERCEL', '1');
    delete process.env.WAVES_OWNER_TOKEN;
    expect(requireOwner(new Request('https://one.wavesco.in/api/control/jobs'))?.status).toBe(401);
  });
  it('rejects missing and wrong tokens when enforced', () => {
    process.env.WAVES_OWNER_TOKEN = 'owner-secret';
    expect(requireOwner(new Request('http://x/'))?.status).toBe(401);
    expect(requireOwner(new Request('http://x/', { headers: { authorization: 'Bearer wrong' } }))?.status).toBe(401);
    expect(requireOwner(new Request('http://x/', { headers: { authorization: 'Bearer owner-secret' } }))).toBeNull();
  });
});
