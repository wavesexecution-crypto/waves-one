import { NextResponse } from 'next/server';
import { errorResponse, stopAll } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Emergency STOP: halts dispatch immediately. The agent kills any running
// action on its next flags check and reports it as stopped.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(stopAll(body.cancelQueued !== false));
  } catch (error) {
    return errorResponse(error);
  }
}
