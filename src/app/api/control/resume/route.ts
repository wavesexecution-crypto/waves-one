import { NextResponse } from 'next/server';
import { resume } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(resume());
}
