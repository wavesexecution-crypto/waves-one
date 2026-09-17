import { NextResponse } from 'next/server';
import { agentFlags, errorResponse, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Lightweight stop/cancel flags the agent checks during long executions.
export async function GET(req: Request) {
  try {
    const device = await verifyDevice(req.headers.get('authorization'));
    const blocked = await guardAgentDevice(device.deviceId);
    if (blocked) return blocked;
    return NextResponse.json(await agentFlags(device.deviceId));
  } catch (error) {
    return errorResponse(error);
  }
}
