import { NextResponse } from 'next/server';
import { decideApproval, errorResponse } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const blocked = guardControl(req, 60);
  if (blocked) return blocked;
  try {
    const { id } = await context.params;
    const body = await req.json();
    return NextResponse.json(decideApproval(id, body.decision, body.note));
  } catch (error) {
    return errorResponse(error);
  }
}
