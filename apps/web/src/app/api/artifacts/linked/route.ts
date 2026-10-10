import { NextRequest, NextResponse } from 'next/server';
import { ARTIFACT_LINK_RELATIONS, ARTIFACT_LINK_SUBJECTS, type ArtifactLinkRelation, type ArtifactLinkSubject } from '@buildd/core/db/schema';
import { isUuid } from '@/lib/uuid';
import { artifactsLinkedTo } from '@/lib/artifact-links';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { bearerOf, linkCaller } from '@/lib/artifact-link-caller';

/**
 * GET /api/artifacts/linked?subjectKind=&subjectId=[&relation=a,b]: what is
 * linked to a subject, as a reference manifest (id, title, type, relation, pin,
 * hash). Never the bodies: read one with GET /api/artifacts/[id].
 */
export async function GET(req: NextRequest) {
  // A per-task token is confined to its own workspace (enforced in lib/artifact-links.ts).
  const account = await authenticateTaskScopedCaller(bearerOf(req), req);
  const caller = await linkCaller(account, account?.taskScope ?? null);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const kind = sp.get('subjectKind') as ArtifactLinkSubject | null;
  const id = sp.get('subjectId') ?? '';
  if (!kind || !ARTIFACT_LINK_SUBJECTS.includes(kind)) return NextResponse.json({ error: `subjectKind must be one of: ${ARTIFACT_LINK_SUBJECTS.join(', ')}` }, { status: 400 });
  if (!isUuid(id)) return NextResponse.json({ error: 'subjectId must be a UUID' }, { status: 400 });
  const relations = (sp.get('relation') ?? '').split(',').filter(Boolean) as ArtifactLinkRelation[];
  if (relations.some((r) => !ARTIFACT_LINK_RELATIONS.includes(r))) return NextResponse.json({ error: `relation must be among: ${ARTIFACT_LINK_RELATIONS.join(', ')}` }, { status: 400 });
  const r = await artifactsLinkedTo(kind, id, { caller, relations });
  return Array.isArray(r) ? NextResponse.json({ artifacts: r }) : NextResponse.json({ error: r.error }, { status: r.status });
}
