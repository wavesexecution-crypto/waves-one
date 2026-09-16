import { NextResponse } from 'next/server';
import { resume } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardControl(req, 60);
  if (blocked) return blocked;
  return NextResponse.json(resume());
}
