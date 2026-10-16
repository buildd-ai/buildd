import { NextRequest, NextResponse } from 'next/server';
import { openSpecAttachment, removeSpecAttachment } from '@/lib/specs/attachments';
import { specCaller } from '@/lib/specs/caller';
import { finalizeArtifactUpload } from '@/lib/artifact-upload';
import { generateDownloadUrl, isStorageConfigured } from '@/lib/storage';

type Ctx = { params: Promise<{ specId: string; name: string }> };

/**
 * GET /api/specs/[specId]/attachments/[name]?revision=N: the lasting link a
 * spec body's `attachment:<name>` renders to (living-specs.md §21). It checks
 * read access to the spec's workspace on every request, then redirects to a
 * fresh short-lived download URL, so no expiring URL is ever written into a
 * spec. A file not yet verified is finalized here first, as the artifact
 * download route does; a body artifact (no file) opens its artifact page.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId, name } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const raw = req.nextUrl.searchParams.get('revision');
  const n = raw === null ? undefined : Number(raw);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1)) return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
  const r = await openSpecAttachment(caller, specId, name, n === undefined ? {} : { revision: n });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  if (!r.storageKey) return NextResponse.redirect(new URL(`/app/artifacts/${r.artifactId}`, req.url));
  if (!isStorageConfigured()) return NextResponse.json({ error: 'Storage not configured' }, { status: 503 });
  if (r.uploadState === 'pending' || r.uploadState === 'failed') {
    const up = await finalizeArtifactUpload(r.artifactId);
    if (up.state !== 'ready') {
      return NextResponse.json({ error: up.state === 'failed' ? `Upload failed: ${up.reason}` : 'Upload not finished: the file has not arrived yet', uploadState: up.state }, { status: 409 });
    }
  }
  return NextResponse.redirect(await generateDownloadUrl(r.storageKey), {
    headers: { 'Cache-Control': 'private, max-age=300' },
  });
}

/** DELETE: stop the attachment applying from the next revision it can; older revisions keep it. Write access. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { specId, name } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const r = await removeSpecAttachment(caller, specId, name);
  return r.ok ? NextResponse.json({ removedFromRevision: r.removedFromRevision }) : NextResponse.json({ error: r.error }, { status: r.status });
}
