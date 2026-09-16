import { NextResponse } from 'next/server';
import { errorResponse, stopAll } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Emergency STOP: halts dispatch immediately. The agent kills any running
// action on its next flags check and reports it as stopped. Jobs created
// during the stop wait in held state until resume.
export async function POST(req: Request) {
  const blocked = guardControl(req, 60);
  if (blocked) return blocked;
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(stopAll(body.cancelQueued !== false));
  } catch (error) {
    return errorResponse(error);
  }
}
