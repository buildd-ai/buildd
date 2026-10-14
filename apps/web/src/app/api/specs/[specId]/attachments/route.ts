import { NextRequest, NextResponse } from 'next/server';
import { attachToSpec, listSpecAttachments } from '@/lib/specs/attachments';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * GET /api/specs/[specId]/attachments?revision=N: the attachments that apply
 * to that revision (default the head), each with its lasting link and, for a
 * binding one, how it stands against the approval record (living-specs.md §21).
 * Read access to the spec's workspace.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const raw = req.nextUrl.searchParams.get('revision');
  const n = raw === null ? undefined : Number(raw);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1)) return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
  const r = await listSpecAttachments(caller, specId, n === undefined ? {} : { revision: n });
  return r.ok ? NextResponse.json({ revision: r.revision, attachments: r.attachments }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/specs/[specId]/attachments { name, kind: binding|reference, caption?, replace?,
 *   artifactId? | filename + mimeType + sizeBytes }:
 * attach an artifact in the spec's workspace, or start an upload (the reply's
 * `upload.uploadUrl` takes one PUT of exactly sizeBytes). Write access.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await attachToSpec(caller, specId, {
    name: body.name, kind: body.kind, caption: body.caption, artifactId: body.artifactId, replace: body.replace,
    filename: body.filename, mimeType: body.mimeType, sizeBytes: body.sizeBytes,
  });
  return r.ok
    ? NextResponse.json({ attachment: r.attachment, upload: r.upload }, { status: 201 })
    : NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
}
