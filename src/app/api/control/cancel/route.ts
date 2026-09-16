import { NextResponse } from 'next/server';
import { cancelJob, errorResponse } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json(cancelJob(body.jobId));
  } catch (error) {
    return errorResponse(error);
  }
}
