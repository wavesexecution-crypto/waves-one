import { NextResponse } from 'next/server';
import { decideApproval, errorResponse } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await req.json();
    return NextResponse.json(decideApproval(id, body.decision, body.note));
  } catch (error) {
    return errorResponse(error);
  }
}
