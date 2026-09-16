import { NextResponse } from 'next/server';
import { errorResponse, pushEvents, verifyDevice } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Streaming progress log lines from a running job. Audited, redacted.
export async function POST(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    const body = await req.json();
    return NextResponse.json(pushEvents(device.deviceId, body.events));
  } catch (error) {
    return errorResponse(error);
  }
}
