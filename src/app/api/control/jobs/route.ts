import { NextResponse } from 'next/server';
import { appendAudit, enqueueJob, errorResponse, listJobs } from '@/lib/control-plane';
import { redactSecrets } from '@/lib/agent-protocol';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get('limit') || 20);
  return NextResponse.json({ jobs: listJobs(limit) });
}

// Enqueue a supervised job. Policy, approval binding, sandbox containment,
// and command classification are enforced before anything is queued.
export async function POST(req: Request) {
  let body: { kind?: string; params?: Record<string, unknown> } = {};
  try {
    body = await req.json();
    return NextResponse.json({ job: enqueueJob(body as never) });
  } catch (error) {
    // Rejected commands are audited too — nothing is hidden.
    if (body?.kind) {
      appendAudit({
        agent: 'Amey', machine: 'WAVES ONE', userAuth: 'standing policy',
        action: 'job.rejected', target: String(body.kind),
        command: typeof body.params?.command === 'string'
          ? redactSecrets(body.params.command).slice(0, 500) : undefined,
        permission: 'control-plane',
        result: 'Job refused before execution.',
        error: error instanceof Error ? error.message : 'Rejected.',
      });
    }
    return errorResponse(error);
  }
}
