import { NextRequest, NextResponse } from 'next/server';
import { approveSpecRevision } from '@/lib/specs/approval';
import { specCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/approve { revision, expectedVersion, retire? }: a person
 * approves the head revision (lib/specs/approval.ts). An agent run or API key
 * is a 403; a stale version or a revision that is not the head is a 409 naming
 * the current version. From an OAuth bearer session (MCP or chat) nothing is
 * approved: the reply is a 202 with the link the person opens on buildd.dev to
 * confirm it (POST ./confirm), after the quality gate (approval-gate.ts) has
 * passed and the person has been sent a notification; a revision the gate
 * refuses is a 409 with code gate_refused and the reasons, and no link. The
 * link carries the retire choice.
 *
 * retire (R-77): which of the specs the revision replaces to supersede with
 * the approval, ids or { specId, expectedVersion }; omitted, all of them; []
 * approves only. `retirements` says per spec superseded or stale (it moved
 * since it was read: the approval stands, that spec is left as it is).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { revision?: unknown; expectedVersion?: unknown; retire?: unknown; via?: unknown } | null;
  const r = await approveSpecRevision(caller, specId, { revision: body?.revision, expectedVersion: body?.expectedVersion, retire: body?.retire, via: body?.via });
  if (r.ok && 'pending' in r) return NextResponse.json({ spec: r.spec, pending: r.pending }, { status: 202 });
  if (r.ok) return NextResponse.json({ spec: r.spec, revision: r.revision, retirements: r.retirements });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.gate ? { gate: r.gate } : {}), ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}) }, { status: r.status });
}
