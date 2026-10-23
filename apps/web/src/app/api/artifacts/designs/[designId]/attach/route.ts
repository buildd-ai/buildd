import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { bearerOf, linkCaller } from '@/lib/artifact-link-caller';
import { attachDesign, detachDesign } from '@/lib/designs/service';
import { attachFrom } from '@/lib/designs/request';

type Ctx = { params: Promise<{ designId: string }> };

/**
 * POST /api/artifacts/designs/[designId]/attach { kind: mission|task|spec, id, revision?, pin? }:
 * attach a design to a mission, task or spec (a spec's head revision unless
 * `revision` names one). A spec attachment pins the design's current revision;
 * a mission or task one follows the latest unless `pin` is given.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { designId } = await params;
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isUuid(designId)) return NextResponse.json({ error: 'design not found' }, { status: 404 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const attachTo = attachFrom(body.kind, body.id, body.revision);
  if (!attachTo || 'error' in attachTo) return NextResponse.json({ error: attachTo?.error ?? 'kind and id are required' }, { status: 400 });
  if (body.pin !== undefined && (!Number.isInteger(body.pin) || (body.pin as number) < 1)) return NextResponse.json({ error: 'pin must be a positive integer' }, { status: 400 });
  const r = await attachDesign(caller, designId, { attachTo, ...(body.pin !== undefined ? { pin: body.pin as number } : {}) });
  return r.ok ? NextResponse.json({ link: r.link }, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/** DELETE /api/artifacts/designs/[designId]/attach?linkId=: detach one attachment (listing shows its linkId). */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { designId } = await params;
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const linkId = req.nextUrl.searchParams.get('linkId') ?? '';
  if (!isUuid(designId) || !isUuid(linkId)) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  const r = await detachDesign(caller, designId, linkId);
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
}
