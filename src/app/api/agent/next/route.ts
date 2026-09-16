import { NextResponse } from 'next/server';
import { errorResponse, nextJob, verifyDevice } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Agent job poll. Authenticated outbound-style polling: the agent asks,
// the control plane answers. No inbound workstation ports.
export async function GET(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    return NextResponse.json(nextJob(device.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
