import { NextResponse } from 'next/server';
import { completeJob, errorResponse, verifyDevice } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    const body = await req.json();
    return NextResponse.json(completeJob(device.deviceId, body));
  } catch (error) {
    return errorResponse(error);
  }
}
