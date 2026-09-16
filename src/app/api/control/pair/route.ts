import { NextResponse } from 'next/server';
import { claimDevice, errorResponse } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Claim a workstation with the single-use pairing code shown in the agent
// terminal. The long-term device credential never touches the browser.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json(claimDevice(body.code));
  } catch (error) {
    return errorResponse(error);
  }
}
