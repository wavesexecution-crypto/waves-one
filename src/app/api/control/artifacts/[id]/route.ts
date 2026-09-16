import fs from 'fs';
import { artifactPath, errorResponse } from '@/lib/control-plane';
import { guardControl } from '@/lib/api-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const blocked = guardControl(req);
  if (blocked) return blocked;
  try {
    const { id } = await context.params;
    const { meta, file } = artifactPath(id);
    const data = fs.readFileSync(file);
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
