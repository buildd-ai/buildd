import { NextRequest, NextResponse } from 'next/server';
import { confirmSpecApproval } from '@/lib/specs/approval';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/approve/confirm { request, retire? }: a person confirms an
 * approval asked for over MCP or chat (lib/specs/approval.ts
 * confirmSpecApproval). Only a dashboard session confirms; any bearer, even
 * the person's own OAuth session, is a 403. The quality gate runs again; a
 * refusal stands unless the body carries an `overrideReason`, which is
 * recorded on the approval. A stale or expired request is
 * refused and writes nothing. retire: the person's choice of replaced specs
 * to supersede (R-77); omitted, the one the link carries.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { request?: unknown; retire?: unknown; overrideReason?: unknown } | null;
  const r = await confirmSpecApproval(caller, specId, body?.request, { overrideReason: body?.overrideReason, retire: body?.retire });
  if (r.ok) return NextResponse.json({ spec: r.spec, revision: r.revision, already: r.already, retirements: r.retirements });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.gate ? { gate: r.gate } : {}), ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}) }, { status: r.status });
}
