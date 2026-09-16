// In-memory sliding-window rate limiter for API routes.
// Single-process and localhost-first: sufficient for Phase 2 (one control
// plane per workstation/cloud instance). A multi-instance deployment would
// move this to Redis; the call shape is already key-based for that.

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

const buckets = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  let hits = buckets.get(key) || [];
  hits = hits.filter(timestamp => now - timestamp < windowMs);
  if (hits.length >= limit) {
    return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - hits[0])) };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function resetRateLimits(): void {
  buckets.clear();
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || 'local';
}
