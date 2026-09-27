import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
// The real presence module's export, driven per test: proves the default dep is wired to it.
let presenceNow: 'present' | 'away' = 'away';
const presenceCalls: string[] = [];
mock.module('@/lib/presence', () => ({
  getPresence: async (userId: string) => {
    presenceCalls.push(userId);
    return presenceNow === 'present' ? { state: 'present', conversationId: null } : { state: 'away', reason: 'no_beat' };
  },
}));
mock.module('@/lib/pusher', () => ({ channels: { conversation: (id: string) => `conversation-${id}` }, events: {}, triggerEvent: async () => {} }));
const { deliverWatchesToConversation, postWatchEvent, watchEventParts } = await import('./watch-delivery');

const USER = '44444444-4444-4444-8444-444444444444';
const CONV = '66666666-6666-4666-8666-666666666666';
const OTHER_CONV = '77777777-7777-4777-8777-777777777777';
const TASK = '11111111-1111-4111-8111-111111111111';

type Row = {
  id: string; subscriptionId: string; eventType: string; dedupeKey: string; payload: Record<string, unknown>;
  urgency: 'normal'; createdAt: string; conversationId: string | null; subjectKind: 'task' | 'pr';
  subjectRef: Record<string, unknown>; lifetime: 'one_shot' | 'standing'; status: string;
};

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, subscriptionId: `sub-${id}`, eventType: 'pr.merged', dedupeKey: `k-${id}`,
  payload: { repo: 'acme/widgets', prNumber: 123 }, urgency: 'normal', createdAt: '2026-09-27T12:00:00.000Z',
  conversationId: CONV, subjectKind: 'pr', subjectRef: { type: 'pr', repo: 'acme/widgets', number: 123 },
  lifetime: 'one_shot', status: 'pending', ...over,
});

/**
 * A fake ledger + conversation with the foundation's semantics: listUndelivered
 * returns pending rows of live watches; markDelivered on a one-shot ends the
 * watch and coalesces its siblings, and only one caller wins. The record list
 * is every pending-or-delivered row of this conversation (a one-shot's first
 * only) whose message is not posted yet.
 */
function world(rows: Row[], presence: 'present' | 'away' = 'present') {
  const ended = new Set<string>();
  const posted = new Map<string, { conversationId: string; parts: unknown; createdAt: Date }>();
  const marks: Array<{ id: string; route: string }> = [];
  const firstOf = (sub: string) => rows.filter(r => r.subscriptionId === sub && (r.status === 'pending' || r.status === 'delivered'))
    .sort((a, b) => Number(b.status === 'delivered') - Number(a.status === 'delivered') || a.createdAt.localeCompare(b.createdAt))[0];
  const deps = {
    listUnposted: mock(async (_o: unknown, conv: string) => rows.filter(r => r.conversationId === conv
      && (r.status === 'pending' || r.status === 'delivered')
      && (r.lifetime === 'standing' || firstOf(r.subscriptionId)?.id === r.id)
      && !posted.has(r.id)).map(r => ({ ...r }))),
    listUndelivered: mock(async () => rows.filter(r => r.status === 'pending' && !ended.has(r.subscriptionId)).map(r => ({ ...r }))),
    markDelivered: mock(async (_owner: unknown, id: string, opts: { route: string }) => {
      const r = rows.find(x => x.id === id);
      if (!r || r.status !== 'pending' || ended.has(r.subscriptionId)) return { marked: false, subscriptionEnded: false };
      r.status = 'delivered';
      marks.push({ id, route: opts.route });
      if (r.lifetime === 'one_shot') {
        ended.add(r.subscriptionId);
        for (const s of rows) if (s.subscriptionId === r.subscriptionId && s.status === 'pending') s.status = 'coalesced';
      }
      return { marked: true, subscriptionEnded: r.lifetime === 'one_shot' };
    }),
    getPresence: mock(async () => (presence === 'present' ? { state: 'present' as const, conversationId: CONV } : { state: 'away' as const, reason: 'no_beat' })),
    insertEvent: mock(async (conversationId: string, id: string, parts: unknown, createdAt: Date) => {
      if (posted.has(id)) return false;
      posted.set(id, { conversationId, parts, createdAt });
      return true;
    }),
    ping: mock(async () => {}),
  };
  return { rows, marks, posted, deps };
}

const drain = (w: ReturnType<typeof world>) => deliverWatchesToConversation({ userId: USER, conversationId: CONV }, w.deps as any);

describe('the record: a fired watch is appended to its conversation once per row', () => {
  it('posts the event message keyed by the ledger row id, at the event\'s own time', async () => {
    const w = world([row('d1')]);
    expect((await drain(w)).delivered).toBe(1);
    expect([...w.posted.keys()]).toEqual(['d1']);
    expect(w.posted.get('d1')!.conversationId).toBe(CONV);
    expect(w.posted.get('d1')!.createdAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(w.deps.ping).toHaveBeenCalledTimes(1);
  });

  it('a reload or a second tab posts nothing again', async () => {
    const w = world([row('d1')], 'away');
    await drain(w);
    const again = await drain(w);
    expect(again.delivered).toBe(0);
    expect(w.posted.size).toBe(1);
    expect(w.deps.ping).toHaveBeenCalledTimes(1);
  });

  it('two paths posting the same row land one message', async () => {
    const w = world([row('d1')], 'away');
    const [a, b] = await Promise.all([drain(w), postWatchEvent(CONV, row('d1') as any, w.deps as any)]);
    expect(w.posted.size).toBe(1);
    expect(a.delivered + Number(b)).toBe(1);
  });

  it('a row the away job already delivered by Pushover still gets its record here', async () => {
    const w = world([row('d1', { status: 'delivered' })], 'present');
    expect((await drain(w)).delivered).toBe(1);
    expect(w.marks).toEqual([]);
  });

  it('a one-shot with two pending rows records only the first', async () => {
    const w = world([
      row('d1', { subscriptionId: 's', eventType: 'task.failed', subjectKind: 'task', payload: { taskId: TASK, title: 'A' } }),
      row('d2', { subscriptionId: 's', eventType: 'task.completed', subjectKind: 'task', payload: { taskId: TASK, title: 'A' }, createdAt: '2026-09-27T12:05:00.000Z' }),
    ], 'away');
    await drain(w);
    await drain(w);
    expect([...w.posted.keys()]).toEqual(['d1']);
  });

  it('leaves rows of another conversation alone', async () => {
    const w = world([row('mine'), row('elsewhere', { conversationId: OTHER_CONV })]);
    await drain(w);
    expect([...w.posted.keys()]).toEqual(['mine']);
    expect(w.marks.map(m => m.id)).toEqual(['mine']);
    expect(w.rows.find(r => r.id === 'elsewhere')?.status).toBe('pending');
  });
});

describe('the delivery: marked only when the owner is present', () => {
  it('away: posted, not marked, so the row stays pending for the away job', async () => {
    const w = world([row('d1')], 'away');
    const out = await drain(w);
    expect(out).toEqual({ delivered: 1, marked: 0 });
    expect(w.deps.markDelivered).not.toHaveBeenCalled();
    expect(w.rows[0].status).toBe('pending');
  });

  it('present: marked delivered via the conversation, once', async () => {
    const w = world([row('d1')], 'present');
    expect(await drain(w)).toEqual({ delivered: 1, marked: 1 });
    expect(w.marks).toEqual([{ id: 'd1', route: 'conversation' }]);
    await drain(w);
    expect(w.marks).toHaveLength(1);
  });

  it('posted while away, marked on the next poll once the owner is back', async () => {
    const w = world([row('d1')], 'away');
    await drain(w);
    w.deps.getPresence.mockImplementation(async () => ({ state: 'present' as const, conversationId: CONV }));
    expect(await drain(w)).toEqual({ delivered: 0, marked: 1 });
    expect(w.posted.size).toBe(1);
  });

  it('a one-shot marks its first row; the claim coalesces the other', async () => {
    const w = world([
      row('d1', { subscriptionId: 's' }),
      row('d2', { subscriptionId: 's', createdAt: '2026-09-27T12:05:00.000Z' }),
    ], 'present');
    await drain(w);
    expect(w.marks).toEqual([{ id: 'd1', route: 'conversation' }]);
    expect(w.rows.find(r => r.id === 'd2')?.status).toBe('coalesced');
  });

  it('a presence error reads as away; a ledger error reads as nothing done. Never throws', async () => {
    const w = world([row('d1')], 'present');
    w.deps.getPresence.mockImplementation(async () => { throw new Error('redis'); });
    expect((await drain(w)).marked).toBe(0);
    const broken = { ...w.deps, listUnposted: async () => { throw new Error('db down'); } };
    expect(await deliverWatchesToConversation({ userId: USER, conversationId: CONV }, broken as any)).toEqual({ delivered: 0, marked: 0 });
  });
});

describe('watchEventParts', () => {
  it('is one data-buildd-event part: event "watch", the sentence, and the notice chrome', () => {
    const parts = watchEventParts(row('d1', { payload: { repo: 'acme/widgets', prNumber: 123, title: 'Round it' } }) as any);
    expect(parts).toEqual([{
      type: 'data-buildd-event',
      data: {
        event: 'watch', objects: [], text: '#123 merged.',
        watch: expect.objectContaining({ eventType: 'pr.merged', label: 'PR #123 · acme/widgets', detail: 'Round it', tone: 'ok' }),
      },
    }]);
  });
});

describe('wired to lib/presence getPresence (no injected presence)', () => {
  const noPresenceDep = (w: ReturnType<typeof world>) => {
    const { getPresence: _g, ...rest } = w.deps;
    return deliverWatchesToConversation({ userId: USER, conversationId: CONV }, rest as any);
  };

  it('a present owner\'s row is posted and marked delivered via the conversation', async () => {
    presenceNow = 'present';
    presenceCalls.length = 0;
    const w = world([row('d1')]);
    expect(await noPresenceDep(w)).toEqual({ delivered: 1, marked: 1 });
    expect(presenceCalls).toEqual([USER]);
    expect(w.marks).toEqual([{ id: 'd1', route: 'conversation' }]);
  });

  it('an away owner\'s row is posted but stays pending for Pushover', async () => {
    presenceNow = 'away';
    const w = world([row('d1')]);
    expect(await noPresenceDep(w)).toEqual({ delivered: 1, marked: 0 });
    expect(w.rows[0].status).toBe('pending');
    expect(w.deps.markDelivered).not.toHaveBeenCalled();
  });
});
