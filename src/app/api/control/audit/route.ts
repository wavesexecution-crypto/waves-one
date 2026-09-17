import { NextResponse } from 'next/server';
import { listAudit } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = await guardControl(req);
  if (blocked) return blocked;
  const limit = Number(new URL(req.url).searchParams.get('limit') || 100);
  return NextResponse.json({ events: await listAudit(limit) });
}
