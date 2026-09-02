import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { recordUserTimezone } from '@/lib/team-timezone';

/**
 * PUT /api/me/timezone — record the zone the browser detected for this user.
 *
 * Called by `<TimezoneSync />` on the protected layout, not by a settings form:
 * nobody should have to tell buildd where they are. Idempotent and cheap, so it
 * is safe to fire whenever the detected zone differs from the stored one (travel,
 * a DST-less move, a new laptop).
 */
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let timezone: unknown;
  try {
    ({ timezone } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof timezone !== 'string' || timezone.length === 0) {
    return NextResponse.json({ error: 'timezone must be a non-empty IANA zone name' }, { status: 400 });
  }

  const result = await recordUserTimezone(user.id, timezone);
  if (!result) {
    return NextResponse.json({ error: `Unrecognised timezone: ${timezone}` }, { status: 400 });
  }

  return NextResponse.json(result);
}
