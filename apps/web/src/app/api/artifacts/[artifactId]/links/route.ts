import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { linkArtifact, linksOfArtifact, unlinkArtifact } from '@/lib/artifact-links';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { bearerOf, linkCaller } from '@/lib/artifact-link-caller';

type Ctx = { params: Promise<{ artifactId: string }> };

/** GET /api/artifacts/[artifactId]/links: this artifact's links to subjects the caller can reach. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { artifactId } = await params;
  // A per-task token is confined to its own workspace (enforced in lib/artifact-links.ts).
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isUuid(artifactId)) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  const r = await linksOfArtifact(caller, artifactId);
  return r.ok ? NextResponse.json({ links: r.links }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/artifacts/[artifactId]/links { subjectKind, subjectId, relation, revision? }:
 * link the artifact to a message, conversation, task, mission or plan of its
 * own team, without copying it. `normative_reference` pins a revision (the
 * current one when none is given).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { artifactId } = await params;
  // A per-task token is confined to its own workspace (enforced in lib/artifact-links.ts).
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isUuid(artifactId)) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await linkArtifact(caller, artifactId, body);
  return r.ok ? NextResponse.json({ link: r.link }, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/** DELETE /api/artifacts/[artifactId]/links?linkId=...: remove one link. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { artifactId } = await params;
  // A per-task token is confined to its own workspace (enforced in lib/artifact-links.ts).
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const linkId = req.nextUrl.searchParams.get('linkId') ?? '';
  if (!isUuid(artifactId)) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  const r = await unlinkArtifact(caller, artifactId, linkId);
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
}
