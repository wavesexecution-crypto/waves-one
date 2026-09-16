import { NextResponse } from 'next/server';
import { errorResponse, getPolicy, setPolicy } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ policy: getPolicy() });
}

// High-risk capabilities can never be set to allowed; the server rejects it.
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json({ policy: setPolicy(body.policy) });
  } catch (error) {
    return errorResponse(error);
  }
}
