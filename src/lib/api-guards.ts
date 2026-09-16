import { NextResponse } from 'next/server';
import { requireOwner } from './owner-auth';
import { checkRateLimit, clientIp } from './rate-limit';

// Shared gates for Route Handlers. Control routes (UI/phone) require the
// owner token when enforced and are rate-limited per client. Agent routes
// authenticate per device and are rate-limited per device.

export function guardControl(req: Request, limit = 300, windowMs = 60_000): NextResponse | null {
  const owner = requireOwner(req);
  if (owner) return owner;
  // Keyed per endpoint: limits must never bleed across routes.
  const route = new URL(req.url).pathname;
  const hit = checkRateLimit(`control:${clientIp(req)}:${req.method}:${route}`, limit, windowMs);
  if (!hit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Slow down.' }, { status: 429 });
  }
  return null;
}

export function guardAgentRegister(req: Request): NextResponse | null {
  const hit = checkRateLimit(`agent-register:${clientIp(req)}`, 10, 3_600_000);
  if (!hit.allowed) {
    return NextResponse.json({ error: 'Too many registration attempts.' }, { status: 429 });
  }
  return null;
}

export function guardAgentDevice(deviceId: string, limit = 600, scope = 'default'): NextResponse | null {
  const hit = checkRateLimit(`agent:${scope}:${deviceId}`, limit, 60_000);
  if (!hit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  }
  return null;
}
