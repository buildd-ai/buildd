import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { issueRegistrationChallenge } from '@/lib/passkeys/guard';

/**
 * POST /api/passkeys/register/options: the WebAuthn options to create a
 * passkey for the signed-in person, over a single-use challenge. A dashboard
 * session only; any Authorization header is a 403.
 */
export async function POST(req: NextRequest) {
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const r = await issueRegistrationChallenge(who.caller.userId);
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json({ options: r.options });
}
