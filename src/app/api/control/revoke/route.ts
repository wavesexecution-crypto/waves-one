import { NextResponse } from 'next/server';
import { errorResponse, revokeDevice } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Revoke a workstation's authorization. Its credential stops authenticating
// immediately; re-pairing requires physical terminal access.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json(revokeDevice(body.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
