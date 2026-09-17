import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';

async function headers() {
  return await nextConfig.headers!();
}

describe('production response headers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('protects pages and APIs without enabling cross-origin control', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const rules = await headers();
    const global = rules.find(rule => rule.source === '/:path*');
    expect(global?.headers).toEqual(expect.arrayContaining([
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
    ]));
    expect(global?.headers.find(header => header.key === 'Permissions-Policy')?.value).toContain('camera=()');
    expect(rules.flatMap(rule => rule.headers).some(header => header.key.toLowerCase().startsWith('access-control-'))).toBe(false);
    expect(rules.find(rule => rule.source === '/api/:path*')?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' });
  });

  it('does not pin local development to HTTPS', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await headers()).flatMap(rule => rule.headers).some(header => header.key === 'Strict-Transport-Security')).toBe(false);
  });
});
