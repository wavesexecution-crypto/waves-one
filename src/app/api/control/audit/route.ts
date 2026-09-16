import { NextResponse } from 'next/server';
import { listAudit } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get('limit') || 100);
  return NextResponse.json({ events: listAudit(limit) });
}
