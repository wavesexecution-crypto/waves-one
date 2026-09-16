import { NextResponse } from 'next/server';
import { listDevices } from '@/lib/control-plane';

export const dynamic = 'force-dynamic';

// Device inventory. Contains status only — never credentials or hashes.
export async function GET() {
  return NextResponse.json({ devices: listDevices() });
}
