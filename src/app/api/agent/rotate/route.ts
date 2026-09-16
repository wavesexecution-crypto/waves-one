import { NextResponse } from 'next/server';
import { errorResponse, rotateSecret, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Credential rotation. Returns the new secret EXACTLY ONCE — the caller
// (the agent's rotate command on the workstation) must persist it. The old
// credential is invalidated immediately. Never exposed to the browser UI.
export async function POST(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    const blocked = guardAgentDevice(device.deviceId, 10, 'rotate');
    if (blocked) return blocked;
    return NextResponse.json(rotateSecret(device.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
