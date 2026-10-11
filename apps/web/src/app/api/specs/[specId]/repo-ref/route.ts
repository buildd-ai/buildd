import { NextRequest, NextResponse } from 'next/server';
import { parseReadSelector } from '@buildd/core/artifact-read';
import { readSpecRepoRef } from '@/lib/specs/store';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * GET /api/specs/[specId]/repo-ref?path=&revision=&view=: a repo file the
 * revision cites, read at the exact commit it cites (never the moving branch),
 * in bounded form: view outline | section | range | grep | meta | full, as for
 * artifacts; no view = the whole file when short, its outline when long.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const raw = q.get('revision');
  const revision = raw === null ? undefined : Number(raw);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) return NextResponse.json({ error: 'revision must be a positive integer' }, { status: 400 });
  const r = await readSpecRepoRef(caller, specId, { revision, path: q.get('path'), selector: (text) => parseReadSelector(q, text) });
  return r.ok
    ? NextResponse.json({ path: r.ref.path, commitSha: r.ref.commitSha, revision: r.revision, read: r.read })
    : NextResponse.json({ error: r.error }, { status: r.status });
}
