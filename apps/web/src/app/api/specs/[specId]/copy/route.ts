import { NextRequest, NextResponse } from 'next/server';
import { copySpecToWorkspace } from '@/lib/specs/copy';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/copy { targetWorkspaceId, revision?, expectedContentHash? }:
 * copy one revision of a spec into another workspace as a draft there
 * (lib/specs/copy.ts). The caller must read the source and write specs in the
 * destination; the copy is never approved by copying. 200 with the verified
 * destination spec id, revision and hash, or the precise refusal.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { targetWorkspaceId?: unknown; revision?: unknown; expectedContentHash?: unknown } | null;
  const r = await copySpecToWorkspace(caller, specId, {
    targetWorkspaceId: body?.targetWorkspaceId, revision: body?.revision, expectedContentHash: body?.expectedContentHash,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
  return NextResponse.json({ reused: r.reused, verified: r.verified, source: r.source, destination: r.destination, notCarried: r.notCarried });
}
