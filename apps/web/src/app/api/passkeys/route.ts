import { NextRequest, NextResponse } from 'next/server';
import { dashboardCaller } from '@/lib/specs/caller';
import { listPasskeys } from '@/lib/passkeys/presence';

/**
 * GET /api/passkeys: the signed-in person's passkeys (lib/passkeys/presence.ts;
 * Living Spec b7fc9316 R-20). A dashboard session only: any Authorization
 * header is a 403, so no token reads or changes a person's passkeys.
 */
export async function GET(req: NextRequest) {
  const who = await dashboardCaller(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  return NextResponse.json({ passkeys: await listPasskeys(who.caller.userId) });
}
