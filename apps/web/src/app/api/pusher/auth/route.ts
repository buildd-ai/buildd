import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { authenticateApiKey } from '@/lib/api-auth';
import { channels, getPusher } from '@/lib/pusher';
import { MAX_RUNNERS_PER_PRESENCE_CHANNEL } from '@/lib/runner-membership';

/**
 * POST /api/pusher/auth: Pusher channel authorization for runner presence
 * (docs/specs/runner-heartbeat.md). Accepts only the caller's own account's
 * `presence-runner-<accountId>` and signs nothing else. The member `user_id` is
 * the runner's `localUiUrl`, sent as `local_ui_url` beside Pusher's form fields.
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const form = await req.formData().catch(() => null);
  const socketId = form?.get('socket_id');
  const channel = form?.get('channel_name');
  const localUiUrl = form?.get('local_ui_url');
  if (typeof socketId !== 'string' || typeof channel !== 'string') {
    return NextResponse.json({ error: 'socket_id and channel_name required' }, { status: 400 });
  }
  if (channel !== channels.runnerPresence(account.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (typeof localUiUrl !== 'string' || !localUiUrl) {
    return NextResponse.json({ error: 'local_ui_url required' }, { status: 400 });
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(workerHeartbeats).where(and(eq(workerHeartbeats.accountId, account.id), eq(workerHeartbeats.presenceConnected, true)));
  if (n >= MAX_RUNNERS_PER_PRESENCE_CHANNEL) {
    return NextResponse.json({ error: 'Too many runners on this account' }, { status: 403 });
  }

  const pusher = getPusher();
  if (!pusher) return NextResponse.json({ error: 'Pusher not configured' }, { status: 503 });
  return NextResponse.json(pusher.authorizeChannel(socketId, channel, { user_id: localUiUrl }));
}
