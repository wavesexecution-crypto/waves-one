import { NextResponse } from 'next/server';
import { completeJob, errorResponse, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    const blocked = guardAgentDevice(device.deviceId);
    if (blocked) return blocked;
    const body = await req.json();
    return NextResponse.json(completeJob(device.deviceId, body));
  } catch (error) {
    return errorResponse(error);
  }
}
