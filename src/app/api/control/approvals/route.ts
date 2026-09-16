import { NextResponse } from 'next/server';
import { createApproval, errorResponse, listApprovals } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ approvals: listApprovals() });
}

// Request CEO approval for a gated computer action. An approval binds to
// exactly one job (kind + params); approving enqueues that job only.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json({ approval: createApproval(body) });
  } catch (error) {
    return errorResponse(error);
  }
}
