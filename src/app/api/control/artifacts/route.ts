import { NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardControl(req);
  if (blocked) return blocked;
  const limit = Number(new URL(req.url).searchParams.get('limit') || 50);
  return NextResponse.json({ artifacts: listArtifacts(limit) });
}
