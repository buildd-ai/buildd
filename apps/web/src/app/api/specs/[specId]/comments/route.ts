import { NextRequest, NextResponse } from 'next/server';
import { addSpecComment, listSpecComments } from '@/lib/specs/comments';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * GET /api/specs/[specId]/comments?revision=N: the comments readable on that
 * revision (default the head), each open, outdated or resolved
 * (lib/specs/comments.ts, living-specs.md §16).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const raw = req.nextUrl.searchParams.get('revision');
  const n = raw === null ? undefined : Number(raw);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1)) return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
  const r = await listSpecComments(caller, specId, n === undefined ? {} : { revision: n });
  return r.ok ? NextResponse.json({ revision: r.revision, comments: r.comments }) : NextResponse.json({ error: r.error }, { status: r.status });
}

/**
 * POST /api/specs/[specId]/comments { revision?, anchor: { section | heading | criterion }, body, replyTo? }:
 * comment on one section or criterion of a revision. Never changes the spec.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const r = await addSpecComment(caller, specId, { revision: body.revision, anchor: body.anchor, body: body.body, replyTo: body.replyTo });
  return r.ok ? NextResponse.json({ comment: r.comment }, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
}
