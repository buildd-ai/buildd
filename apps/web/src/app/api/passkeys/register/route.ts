import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { registerPasskey } from '@/lib/passkeys/presence';

/**
 * POST /api/passkeys/register { response, name?, presence? }: store the
 * passkey the browser just created (lib/passkeys/presence.ts registerPasskey).
 * A dashboard session only; any Authorization header is a 403. A person who
 * already has a passkey and belongs to a team that requires one must also send
 * `presence`, an assertion by an existing passkey: without it the reply is a
 * 403 with code `presence_required` and the pin to ask one for.
 */
export async function POST(req: NextRequest) {
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => null)) as { response?: unknown; name?: unknown; presence?: unknown } | null;
  const r = await registerPasskey(who.caller.userId, { response: body?.response, name: body?.name, presence: body?.presence });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, ...(r.presence ? { presence: r.presence } : {}) }, { status: r.status });
  return NextResponse.json({ passkey: r.passkey });
}
