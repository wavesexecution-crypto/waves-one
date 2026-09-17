import { artifactBytes, errorResponse } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const blocked = await guardControl(req);
  if (blocked) return blocked;
  try {
    const { id } = await context.params;
    // Bytes come from the active store (local disk in dev, Neon in
    // production) — never from a raw filesystem path on the server.
    const { meta, data } = await artifactBytes(id);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': meta.mime,
        'Content-Disposition': `attachment; filename="${meta.name.replace(/"/g, '')}"`,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
