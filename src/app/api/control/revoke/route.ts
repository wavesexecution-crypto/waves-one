import { NextResponse } from 'next/server';
import { errorResponse, revokeDevice } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Revoke a workstation's authorization. Its credential stops authenticating
// immediately; re-pairing requires physical terminal access.
export async function POST(req: Request) {
  const blocked = guardControl(req, 60);
  if (blocked) return blocked;
  try {
    const body = await req.json();
    return NextResponse.json(revokeDevice(body.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
