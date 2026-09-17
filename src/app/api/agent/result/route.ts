import { NextResponse } from 'next/server';
import { completeJob, errorResponse, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const device = await verifyDevice(req.headers.get('authorization'));
    const blocked = await guardAgentDevice(device.deviceId);
    if (blocked) return blocked;
    const body = await req.json();
    return NextResponse.json(await completeJob(device.deviceId, body));
  } catch (error) {
    return errorResponse(error);
  }
}
