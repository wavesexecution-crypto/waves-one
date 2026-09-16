import { NextResponse } from 'next/server';
import { errorResponse, nextJob, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Agent job poll. Authenticated outbound-style polling: the agent asks,
// the control plane answers. No inbound workstation ports.
export async function GET(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    const blocked = guardAgentDevice(device.deviceId);
    if (blocked) return blocked;
    return NextResponse.json(nextJob(device.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
