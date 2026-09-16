import { NextResponse } from 'next/server';
import { enqueueJob, errorResponse, listJobs } from '@/lib/control-plane';
import { appendAudit } from '@/lib/control-plane';
import { redactSecrets } from '@/lib/agent-protocol';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = guardControl(req);
  if (blocked) return blocked;
  const limit = Number(new URL(req.url).searchParams.get('limit') || 20);
  return NextResponse.json({ jobs: listJobs(limit) });
}

// Enqueue a supervised job. Policy, approval binding, roots, domains, and
// command classification are enforced before anything becomes releasable.
// 403 may carry needsApproval (request an approval) or jobId (denied record).
export async function POST(req: Request) {
  const blocked = guardControl(req, 60);
  if (blocked) return blocked;
  let body: { kind?: string; params?: Record<string, unknown> } = {};
  try {
    body = await req.json();
    const { job, deduped } = enqueueJob(body as never);
    return NextResponse.json({ job, deduped });
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
