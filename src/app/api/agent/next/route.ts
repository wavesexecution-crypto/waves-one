import { NextResponse } from 'next/server';
import { errorResponse, nextJob, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Agent job poll. Authenticated outbound-style polling: the agent asks,
// the control plane answers. No inbound workstation ports.
export async function GET(req: Request) {
  try {
    const device = await verifyDevice(req.headers.get('authorization'));
    const blocked = await guardAgentDevice(device.deviceId);
    if (blocked) return blocked;
    return NextResponse.json(await nextJob(device.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
