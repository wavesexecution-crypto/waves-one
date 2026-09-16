import { NextResponse } from 'next/server';
import { agentFlags, errorResponse, verifyDevice } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Lightweight stop/cancel flags the agent checks during long executions.
export async function GET(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    return NextResponse.json(agentFlags(device.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
