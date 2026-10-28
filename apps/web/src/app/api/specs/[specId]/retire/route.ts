import { NextRequest, NextResponse } from 'next/server';
import { restoreSpec, retireSpec } from '@/lib/specs/retire';
import { specCaller } from '@/lib/specs/caller';
import type { SpecError } from '@/lib/specs/store';

type Ctx = { params: Promise<{ specId: string }> };

const refusal = (r: SpecError) => NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.presence ? { presence: r.presence } : {}) }, { status: r.status });

/**
 * POST /api/specs/[specId]/retire { reason, supersededBy? }: a person retires
 * a spec, or marks it superseded by another live spec in the same workspace
 * (lib/specs/retire.ts, living-specs.md §22). DELETE { reason? } restores it
 * to the status it had. An agent run or API key is a 403 on both. From the
 * person's own OAuth session nothing changes: the reply is a 202 with the
 * confirm link they open on buildd.dev (POST ./confirm; Living Spec b7fc9316
 * R-11). When the team requires a passkey (R-20), a dashboard retire or
 * restore without a valid assertion is a 403 with code `presence_required`
 * and the pin to ask one for; nothing changes.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { reason?: unknown; supersededBy?: unknown; presence?: unknown } | null;
  const r = await retireSpec(caller, specId, { reason: body?.reason, supersededBy: body?.supersededBy, presence: body?.presence });
  if (r.ok && 'pending' in r) return NextResponse.json({ spec: r.spec, pending: r.pending }, { status: 202 });
  if (r.ok) return NextResponse.json({ spec: r.spec });
  return refusal(r);
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const caller = await specCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { reason?: unknown; presence?: unknown } | null;
  const r = await restoreSpec(caller, specId, { reason: body?.reason, presence: body?.presence });
  if (r.ok && 'pending' in r) return NextResponse.json({ spec: r.spec, pending: r.pending }, { status: 202 });
  if (r.ok) return NextResponse.json({ spec: r.spec });
  return refusal(r);
}
