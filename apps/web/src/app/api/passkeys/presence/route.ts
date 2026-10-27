import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { issuePresenceChallenge } from '@/lib/passkeys/presence';
import { parsePresencePin } from '@/lib/passkeys/binding';

/**
 * POST /api/passkeys/presence { pin }: the WebAuthn options for one presence
 * assertion, over a single-use challenge bound to `pin` (lib/passkeys/binding.ts)
 * and the signed-in person. `pin` is what a guarded act's 403 named. The act
 * then recomputes its pin from what it is about to write, so an assertion
 * made here counts for that act and no other. A dashboard session only; any
 * Authorization header is a 403.
 */
export async function POST(req: NextRequest) {
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = parsePresencePin(body?.pin);
  if (!pin) return NextResponse.json({ error: 'pin names no act a passkey is asked for' }, { status: 400 });
  const r = await issuePresenceChallenge(who.caller.userId, pin);
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code, ...(r.presence ? { presence: r.presence } : {}) }, { status: r.status });
  return NextResponse.json({ options: r.options });
}
