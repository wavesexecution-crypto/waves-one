import { describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimits } from './rate-limit';

describe('rate limiter', () => {
  it('allows bursts up to the limit then refuses', () => {
    resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit('test-key', 5, 60_000, now + i).allowed).toBe(true);
    }
    const refused = checkRateLimit('test-key', 5, 60_000, now + 5);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });
  it('recovers after the window passes', () => {
    resetRateLimits();
    expect(checkRateLimit('window-key', 1, 1000, 0).allowed).toBe(true);
    expect(checkRateLimit('window-key', 1, 1000, 500).allowed).toBe(false);
    expect(checkRateLimit('window-key', 1, 1000, 1001).allowed).toBe(true);
  });
  it('isolates keys from each other', () => {
    resetRateLimits();
    expect(checkRateLimit('a', 1, 60_000, 0).allowed).toBe(true);
    expect(checkRateLimit('b', 1, 60_000, 0).allowed).toBe(true);
    expect(checkRateLimit('a', 1, 60_000, 0).allowed).toBe(false);
  });
});
