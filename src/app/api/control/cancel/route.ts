import { NextResponse } from 'next/server';
import { cancelJob, errorResponse } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardControl(req, 60);
  if (blocked) return blocked;
  try {
    const body = await req.json();
    return NextResponse.json(cancelJob(body.jobId));
  } catch (error) {
    return errorResponse(error);
  }
}
