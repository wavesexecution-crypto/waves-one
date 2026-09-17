import { NextResponse } from 'next/server';
import { createApproval, errorResponse, listApprovals } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = await guardControl(req);
  if (blocked) return blocked;
  return NextResponse.json({ approvals: await listApprovals() });
}

// Request CEO approval for a gated computer action. An approval binds to
// exactly one job (kind + params); approving authorizes that job only.
export async function POST(req: Request) {
  const blocked = await guardControl(req, 60);
  if (blocked) return blocked;
  try {
    const body = await req.json();
    return NextResponse.json({ approval: await createApproval(body) });
  } catch (error) {
    return errorResponse(error);
  }
}
