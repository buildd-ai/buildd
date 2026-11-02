import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { applyPresenceEvent, type PusherWebhookEvent } from '@/lib/runner-membership';
import { getPusher } from '@/lib/pusher';

/**
 * POST /api/webhooks/pusher: Pusher's presence webhooks (member_added /
 * member_removed on `presence-runner-<accountId>`), the only writer of
 * `worker_heartbeats.presence_connected`. docs/specs/runner-heartbeat.md.
 *
 * The HMAC-SHA256 signature over the raw body is checked before anything is
 * parsed; a bad one is a 401 that writes nothing. Pusher batches events in one
 * POST and may redeliver or reorder them: each is applied by a conditional
 * update that writes only on a state change newer than the stored one.
 * Under /api/webhooks, so the read rate limit never counts it.
 */
function validSignature(raw: string, key: string | null, signature: string | null): boolean {
  const appKey = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  if (!appKey || !secret || !key || !signature || key !== appKey) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function isMember(channel: string, userId: string): Promise<boolean | undefined> {
  const client = getPusher();
  if (!client) return undefined;
  try {
    const res = await client.get({ path: `/channels/${encodeURIComponent(channel)}/users` });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { users?: Array<{ id: string }> };
    return (data.users ?? []).some(u => u.id === userId);
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!validSignature(raw, req.headers.get('x-pusher-key'), req.headers.get('x-pusher-signature'))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  let payload: { time_ms?: number; events?: PusherWebhookEvent[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  const outcomes: string[] = [];
  for (const ev of events) {
    outcomes.push(await applyPresenceEvent({ ...ev, time_ms: ev.time_ms ?? payload.time_ms }, { isMember }));
  }
  return NextResponse.json({ received: true, outcomes });
}
