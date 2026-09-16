import { NextResponse } from 'next/server';
import { controlStatus } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(controlStatus());
}
