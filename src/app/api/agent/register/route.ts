import { NextResponse } from 'next/server';
import { errorResponse, registerDevice } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Agent registration (localhost, Phase 1). Carries the device credential
// HASH, never the secret. Returns nothing sensitive.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json(registerDevice(body));
  } catch (error) {
    return errorResponse(error);
  }
}
