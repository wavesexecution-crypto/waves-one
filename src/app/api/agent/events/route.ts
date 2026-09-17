import { NextResponse } from 'next/server';
import { errorResponse, pushEvents, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Streaming progress log lines from a running job. Audited, redacted.
export async function POST(req: Request) {
  try {
    const device = await verifyDevice(req.headers.get('authorization'));
    const blocked = await guardAgentDevice(device.deviceId);
    if (blocked) return blocked;
    const body = await req.json();
    return NextResponse.json(await pushEvents(device.deviceId, body.events));
  } catch (error) {
    return errorResponse(error);
  }
}
