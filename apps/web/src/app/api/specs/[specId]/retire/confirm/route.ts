import { NextRequest, NextResponse } from 'next/server';
import { confirmSpecStatusChange } from '@/lib/specs/retire';
import { dashboardCaller } from '@/lib/specs/caller';

type Ctx = { params: Promise<{ specId: string }> };

/**
 * POST /api/specs/[specId]/retire/confirm { request }: a person confirms a
 * retire or restore asked for from an OAuth session (lib/specs/retire.ts
 * confirmSpecStatusChange; Living Spec b7fc9316 R-11, R-12). A dashboard
 * session only: any Authorization header is a 403. A spec whose version or
 * status moved since the link was made is a 409 with code `request_stale`,
 * and nothing changes. presence: the passkey assertion a team that requires
 * one asks for (R-20).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { specId } = await params;
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => null)) as { request?: unknown; presence?: unknown } | null;
  const r = await confirmSpecStatusChange(who.caller, specId, body?.request, { presence: body?.presence });
  if (r.ok) return NextResponse.json({ spec: r.spec });
  return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}), ...(r.presence ? { presence: r.presence } : {}) }, { status: r.status });
}
