import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Liveness probe: never touches the database, never leaks secrets, never
// throws stacks. Vercel, uptime checkers, and the load balancer use this to
// know the process is alive.
export async function GET() {
  return NextResponse.json(
    { status: 'ok', service: 'waves-one', ts: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
