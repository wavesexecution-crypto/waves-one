import { NextResponse } from 'next/server';
import { controlStatus } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardControl(req);
  if (blocked) return blocked;
  return NextResponse.json(controlStatus());
}
