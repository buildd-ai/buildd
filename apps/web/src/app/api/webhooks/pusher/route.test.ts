import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const applied: any[] = [];
mock.module('@/lib/runner-membership', () => ({
  applyPresenceEvent: async (ev: any) => { applied.push(ev); return 'written'; },
}));

process.env.PUSHER_KEY = 'k';
process.env.PUSHER_SECRET = 's3cret';

import { POST } from './route';

function req(body: string, opts: { sig?: string; key?: string } = {}) {
  const sig = opts.sig ?? createHmac('sha256', 's3cret').update(body).digest('hex');
  return new NextRequest('http://localhost/api/webhooks/pusher', {
    method: 'POST',
    headers: { 'x-pusher-key': opts.key ?? 'k', 'x-pusher-signature': sig, 'content-type': 'application/json' },
    body,
  });
}
const body = JSON.stringify({ time_ms: 1, events: [
  { name: 'member_added', channel: 'presence-runner-a', user_id: 'u1' },
  { name: 'member_removed', channel: 'presence-runner-a', user_id: 'u2' },
] });

beforeEach(() => { applied.length = 0; });

describe('POST /api/webhooks/pusher', () => {
  it('rejects a bad signature with 401 and applies nothing', async () => {
    const res = await POST(req(body, { sig: 'deadbeef' }));
    expect(res.status).toBe(401);
    expect(applied).toHaveLength(0);
  });
  it('rejects a wrong key', async () => {
    expect((await POST(req(body, { key: 'other' }))).status).toBe(401);
  });
  it('applies every event in a batch, stamping the batch time when an event has none', async () => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(applied.map(e => e.user_id)).toEqual(['u1', 'u2']);
    expect(applied[0].time_ms).toBe(1);
  });
  it('returns 200 for a valid body with no events', async () => {
    expect((await POST(req(JSON.stringify({ time_ms: 1, events: [] })))).status).toBe(200);
  });
});
