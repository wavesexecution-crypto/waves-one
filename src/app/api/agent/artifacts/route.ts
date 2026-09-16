import { NextResponse } from 'next/server';
import { errorResponse, saveArtifact, verifyDevice } from '@/lib/control-plane';
import { guardAgentDevice } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Agent artifact upload (screenshots, downloads, extracts, reports).
// Size-capped, type-restricted, hashed, and bound to the uploading device.
export async function POST(req: Request) {
  try {
    const device = verifyDevice(req.headers.get('authorization'));
    const blocked = guardAgentDevice(device.deviceId, 60);
    if (blocked) return blocked;
    const body = await req.json();
    return NextResponse.json({ artifact: saveArtifact(device.deviceId, body) });
  } catch (error) {
    return errorResponse(error);
  }
}
