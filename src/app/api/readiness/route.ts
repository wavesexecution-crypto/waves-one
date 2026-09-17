import { NextResponse } from 'next/server';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Readiness probe: verifies critical dependencies (Neon PostgreSQL via the
// active store). Returns 200 when ready, 503 when not. Never leaks
// credentials, connection strings, or stack traces.
export async function GET() {
  const started = Date.now();
  try {
    const store = await getStore();
    // Lightweight store check: read flags (single-row table) exercises the
    // pooled DB connection without mutating state.
    await store.readFlags();
    return NextResponse.json(
      {
        status: 'ready',
        service: 'waves-one',
        store: store.kind,
        latencyMs: Date.now() - started,
        ts: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    // Intentionally opaque: log internally, expose only a stable error shape.
    // Never include error.message that might contain a DATABASE_URL fragment.
    return NextResponse.json(
      {
        status: 'not_ready',
        service: 'waves-one',
        reason: 'dependency_unavailable',
        ts: new Date().toISOString(),
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
