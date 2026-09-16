import { NextResponse } from 'next/server';
import { listDevices } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

// Device inventory. Contains status and telemetry only — never credentials.
export async function GET(req: Request) {
  const blocked = guardControl(req);
  if (blocked) return blocked;
  return NextResponse.json({ devices: listDevices() });
}
