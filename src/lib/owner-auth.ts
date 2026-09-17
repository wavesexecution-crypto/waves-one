import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

// Owner gate for control-plane endpoints. When WAVES_OWNER_TOKEN is set
// (cloud/hardened deployments, phone access over the internet), every
// /api/control/* request must bear it. When unset (local dev loop), the
// localhost binding is the boundary and requests pass through.
// Device endpoints (/api/agent/*) always use per-device credentials instead.
export function ownerTokenEnforced(): boolean {
  return !!process.env.WAVES_OWNER_TOKEN;
}

export function requireOwner(req: Request): NextResponse | null {
  const token = process.env.WAVES_OWNER_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') {
      return NextResponse.json({ error: 'Owner authorization required.' }, { status: 401 });
    }
    return null;
  }
  const header = req.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Owner authorization required.' }, { status: 401 });
  }
  return null;
}
