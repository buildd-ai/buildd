import { NextRequest, NextResponse } from 'next/server';
import { confirmSpecApproval } from '@/lib/specs/approval';
import { dashboardCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/approve/confirm { request }: a person confirms an
 * approval asked for over MCP or chat (lib/specs/approval.ts
 * confirmSpecApproval). Only a dashboard session confirms; any request that
 * carries an Authorization header, even the person's own OAuth session, is a
 * 403 (lib/specs/caller.ts dashboardCaller). The quality gate runs again; a
 * refusal stands unless the body carries an `overrideReason`, which is
 * recorded on the approval. A stale or expired request is
 * refused and writes nothing.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const caller = who.caller;
  const body = (await req.json().catch(() => null)) as { request?: unknown; overrideReason?: unknown } | null;
  const r = await confirmSpecApproval(caller, specId, body?.request, { overrideReason: body?.overrideReason });
  if (r.ok) return NextResponse.json({ spec: r.spec, revision: r.revision, already: r.already });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.gate ? { gate: r.gate } : {}), ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}) }, { status: r.status });
}
