import { NextResponse } from 'next/server';
import { requireOwner } from './owner-auth';
import { getStore } from './store';
import { clientIp } from './rate-limit';

// Shared gates for Route Handlers. Control routes (UI/phone) require the
// owner token when enforced and are rate-limited per client. Agent routes
// authenticate per device and are rate-limited per device.
//
// Rate limits are enforced through the active store: Neon (rate_windows
// table, shared across Vercel instances) in production, process-local
// buckets in local dev. Limits must never bleed across routes — the route
// path is part of every key.

async function hit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const store = await getStore();
  return store.rateHit(key, limit, windowMs, Date.now());
}

export async function guardControl(req: Request, limit = 300, windowMs = 60_000): Promise<NextResponse | null> {
  const owner = requireOwner(req);
  if (owner) return owner;
  // Keyed per endpoint: limits must never bleed across routes.
  const route = new URL(req.url).pathname;
  const result = await hit(`control:${clientIp(req)}:${req.method}:${route}`, limit, windowMs);
  if (!result.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Slow down.' }, { status: 429 });
  }
  return null;
}

export async function guardAgentRegister(req: Request): Promise<NextResponse | null> {
  const result = await hit(`agent-register:${clientIp(req)}`, 10, 3_600_000);
  if (!result.allowed) {
    return NextResponse.json({ error: 'Too many registration attempts.' }, { status: 429 });
  }
  return null;
}

export async function guardAgentDevice(deviceId: string, limit = 600, scope = 'default'): Promise<NextResponse | null> {
  const result = await hit(`agent:${scope}:${deviceId}`, limit, 60_000);
  if (!result.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  }
  return null;
}
