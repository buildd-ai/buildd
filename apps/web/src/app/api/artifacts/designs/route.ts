import { NextRequest, NextResponse } from 'next/server';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { bearerOf, linkCaller } from '@/lib/artifact-link-caller';
import { listDesigns, storeDesign } from '@/lib/designs/service';
import { attachFrom } from '@/lib/designs/request';
import { MAX_DESIGN_BYTES } from '@/lib/designs/upload';


/**
 * POST /api/artifacts/designs: store one HTML export of a design canvas as a
 * design, optionally attached to a mission, task or spec in the same call.
 * No worker and no task claim is needed: an owner session, an account key or a
 * worker's per-task token (confined to its own workspace) all work.
 *
 * Body: JSON { html, title?, screens?, source?, designId?, workspaceId?,
 * attachTo?: { kind, id, revision? }, pin? }, or the raw HTML as
 * `text/html` with the same fields as query parameters (title, designId,
 * workspaceId, attachKind, attachId, attachRevision, pin, source):
 *   curl -X POST -H 'Content-Type: text/html' --data-binary @export.html '.../api/artifacts/designs?attachKind=mission&attachId=...'
 * Without `designId` it is a new design (revision 1); with it, that design's
 * next revision.
 */
export async function POST(req: NextRequest) {
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Refuse an oversized body before reading it.
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DESIGN_BYTES * 1.1) {
    return NextResponse.json({ error: `Design exceeds ${MAX_DESIGN_BYTES / (1024 * 1024)} MB limit` }, { status: 413 });
  }

  const contentType = req.headers.get('content-type');
  const mediaType = contentType?.split(';')[0]!.trim().toLowerCase() ?? '';
  const q = req.nextUrl.searchParams;
  let fields: Record<string, unknown>;
  if (mediaType === 'application/json') {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
    fields = body as Record<string, unknown>;
  } else if (mediaType === 'text/html') {
    const num = q.get('pin');
    fields = {
      html: await req.text(),
      title: q.get('title') ?? undefined, designId: q.get('designId') ?? undefined, workspaceId: q.get('workspaceId') ?? undefined,
      source: q.get('source') ?? undefined, pin: num ? Number(num) : undefined,
      attachTo: attachFrom(q.get('attachKind'), q.get('attachId'), q.get('attachRevision')),
    };
  } else {
    return NextResponse.json({ error: 'Send application/json { html, ... } or the raw export as text/html' }, { status: 415 });
  }

  const attachTo = fields.attachTo === undefined ? undefined
    : (fields.attachTo && typeof fields.attachTo === 'object' && !('error' in fields.attachTo))
      ? attachFrom((fields.attachTo as Record<string, unknown>).kind, (fields.attachTo as Record<string, unknown>).id, (fields.attachTo as Record<string, unknown>).revision)
      : { error: 'attachTo must be { kind, id, revision? }' };
  if (attachTo && 'error' in attachTo) return NextResponse.json({ error: attachTo.error, field: 'attachTo' }, { status: 400 });
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (fields.pin !== undefined && (!Number.isInteger(fields.pin) || (fields.pin as number) < 1)) {
    return NextResponse.json({ error: 'pin must be a positive integer', field: 'pin' }, { status: 400 });
  }

  const r = await storeDesign(caller, {
    html: fields.html, declaredType: mediaType === 'text/html' ? 'text/html' : null,
    title: fields.title as string | undefined, screens: fields.screens, source: str(fields.source),
    designId: str(fields.designId), workspaceId: str(fields.workspaceId),
    ...(attachTo ? { attachTo } : {}), ...(fields.pin !== undefined ? { pin: fields.pin as number } : {}),
  });
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.field ? { field: r.field } : {}) }, { status: r.status });
  return NextResponse.json({ design: r.design, attached: r.attached, ...(r.attachError ? { attachError: r.attachError } : {}) }, { status: r.design.revision > 1 ? 200 : 201 });
}

/** GET /api/artifacts/designs?missionId= | taskId= | specId=[&revision=] | workspaceId=: the designs attached there, no bodies. */
export async function GET(req: NextRequest) {
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const named = (['mission', 'task', 'spec'] as const).filter(k => q.get(`${k}Id`));
  if (named.length > 1) return NextResponse.json({ error: 'Name one of missionId, taskId, specId' }, { status: 400 });
  if (named.length === 0 && !q.get('workspaceId')) return NextResponse.json({ error: 'missionId, taskId, specId or workspaceId is required' }, { status: 400 });
  const attachTo = named[0] ? attachFrom(named[0], q.get(`${named[0]}Id`), q.get('revision')) : undefined;
  if (attachTo && 'error' in attachTo) return NextResponse.json({ error: attachTo.error }, { status: 400 });
  const r = await listDesigns(caller, attachTo ? { attachTo } : { workspaceId: q.get('workspaceId')! });
  return r.ok ? NextResponse.json({ designs: r.designs }) : NextResponse.json({ error: r.error }, { status: r.status });
}
