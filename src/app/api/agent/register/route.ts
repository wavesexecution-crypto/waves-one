import { NextResponse } from 'next/server';
import { errorResponse, registerDevice } from '@/lib/control-plane';
import { guardAgentRegister } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Agent registration (localhost, Phase 1). Carries the device credential
// HASH, never the secret. Returns nothing sensitive.
export async function POST(req: Request) {
  const blocked = guardAgentRegister(req);
  if (blocked) return blocked;
  try {
    const body = await req.json();
    return NextResponse.json(registerDevice(body));
  } catch (error) {
    return errorResponse(error);
  }
}
