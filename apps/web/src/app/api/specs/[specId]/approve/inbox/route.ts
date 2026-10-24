import { NextRequest, NextResponse } from 'next/server';
import { approveFromInbox } from '@/lib/specs/approval';
import { dashboardCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/approve/inbox { revision, expectedVersion,
 * contentHash, overrideReason? }: one row of the Awaiting your approval inbox
 * (/app/specs/approvals), approved with a click (lib/specs/approval.ts
 * approveFromInbox; Living Spec b7fc9316 R-3 to R-6). A dashboard session
 * only: any Authorization header is a 403 and nothing changes. A pin that no
 * longer matches the spec is a 409 with code `stale`; a gate refusal without
 * a reason of 10+ characters is a 409 with code `gate_refused`. One spec per
 * call: there is no batch form.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => null)) as { revision?: unknown; expectedVersion?: unknown; contentHash?: unknown; overrideReason?: unknown } | null;
  const r = await approveFromInbox(who.caller, specId, {
    revision: body?.revision, expectedVersion: body?.expectedVersion, contentHash: body?.contentHash, overrideReason: body?.overrideReason,
  });
  if (r.ok) return NextResponse.json({ spec: r.spec, revision: r.revision, already: r.already });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.gate ? { gate: r.gate } : {}), ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}) }, { status: r.status });
}
