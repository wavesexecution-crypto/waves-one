import { NextResponse } from 'next/server';
import { errorResponse, getPolicy, setPolicy } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = await guardControl(req);
  if (blocked) return blocked;
  return NextResponse.json({ policy: await getPolicy() });
}

// High-risk capabilities can never be set to allowed; the server rejects it.
export async function PUT(req: Request) {
  const blocked = await guardControl(req, 30);
  if (blocked) return blocked;
  try {
    const body = await req.json();
    return NextResponse.json({ policy: await setPolicy(body.policy) });
  } catch (error) {
    return errorResponse(error);
  }
}
