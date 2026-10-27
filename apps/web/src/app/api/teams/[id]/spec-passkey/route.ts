import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { setTeamPasskeyRequired } from '@/lib/passkeys/presence';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/teams/[id]/spec-passkey { required, presence? }: a team owner turns
 * on or off the passkey requirement for spec approve, retire and restore
 * (Living Spec b7fc9316 R-20; permission `require_spec_passkey`). A dashboard
 * session only: any Authorization header is a 403. Either way it needs the
 * owner's own passkey: without it the reply is a 403 with code
 * `presence_required` (or `passkey_missing`) and the pin to ask one for.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => null)) as { required?: unknown; presence?: unknown } | null;
  const r = await setTeamPasskeyRequired(who.caller.userId, id, body?.required, body?.presence);
  if (!r.ok) return NextResponse.json({ error: r.error, ...('code' in r ? { code: r.code } : {}), ...('presence' in r && r.presence ? { presence: r.presence } : {}) }, { status: r.status });
  return NextResponse.json({ required: r.required });
}
