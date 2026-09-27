import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/secrets', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  getSecretsProvider: () => ({}),
}));

const {
  deliverAwayNotifications, pendingPersonRowsSql, recentPushesSql, renderAwayMessage,
  COALESCE_MS, PUSHES_PER_HOUR, URGENT_PUSHES_PER_HOUR,
} = await import('./away-delivery');
type AwayRow = import('./away-delivery').AwayRow;
type AwayDeps = import('./away-delivery').AwayDeps;
const { personalPushoverKeySql, loadPersonalPushoverKey, PERSONAL_PUSHOVER_PURPOSE } = await import('./personal-pushover');

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const text = (q: SQL) => render(q).sql.replace(/\s+/g, ' ');

const now = new Date('2026-09-27T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ALICE_KEY = 'uAliceKeyAliceKeyAliceKeyAlice';
const BOB_KEY = 'uBobKeyBobKeyBobKeyBobKeyBobKe';

let n = 0;
function row(over: Partial<AwayRow> = {}): AwayRow {
  n++;
  return {
    id: `row-${n}`, eventType: 'task.completed', payload: { taskId: `t-${n}`, title: `Task ${n}` },
    urgency: 'normal', createdAt: ago(COALESCE_MS * 2), ownerUserId: ALICE, teamId: TEAM, ...over,
  };
}

/** A tick harness: every dependency recorded, sensible defaults (away, has a key, under the rate). */
function harness(rows: AwayRow[], over: Partial<AwayDeps> & { sentLastHour?: number; urgentLastHour?: number } = {}) {
  const sends: Array<{ user: string; title: string; message: string; priority?: number }> = [];
  const marks: Array<[unknown, string, string]> = [];
  const requeued: Array<[string[], number]> = [];
  const rejected: string[] = [];
  const statements: SQL[] = [];
  const keys: Record<string, string> = { [ALICE]: ALICE_KEY, [BOB]: BOB_KEY };
  const deps: AwayDeps = {
    now: () => now,
    appUrl: 'https://app.example',
    exec: async (q) => {
      statements.push(q);
      const t = text(q);
      if (t.includes('count(distinct')) return { rows: [{ sent: over.sentLastHour ?? 0, urgent: over.urgentLastHour ?? 0 }] };
      if (t.includes('from "notification_deliveries" d')) return { rows };
      return { rows: [] };
    },
    presence: async () => ({ state: 'away', reason: 'no_beat' }),
    loadKey: async (userId) => keys[userId] ?? null,
    send: async (m) => { sends.push(m); return 'sent'; },
    senderToken: () => 'app-token',
    markDelivered: (async (owner: unknown, id: string, opts: { route: string }) => {
      marks.push([owner, id, opts.route]);
      return { marked: true, subscriptionEnded: true };
    }) as AwayDeps['markDelivered'],
    heldNoticeOnce: async () => true,
    markKeyRejected: async (userId) => { rejected.push(userId); },
    queue: { clearThrough: async () => {}, requeue: async (ids, at) => { requeued.push([ids, at]); } },
    ...over,
  };
  return { deps, sends, marks, requeued, rejected, statements, run: () => deliverAwayNotifications(deps) };
}

describe('present vs away routing', () => {
  it('away: one push to their own key, every row marked delivered via pushover', async () => {
    const r = row();
    const h = harness([r]);
    const s = await h.run();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].user).toBe(ALICE_KEY);
    expect(h.sends[0].title).toBe('Task completed');
    expect(h.marks).toEqual([[{ userId: ALICE }, r.id, 'pushover']]);
    expect(s).toMatchObject({ sent: 1, delivered: 1 });
  });

  it('present: nothing is sent and nothing is marked; the row stays pending', async () => {
    const h = harness([row()], { presence: async () => ({ state: 'present', conversationId: null }) });
    const s = await h.run();
    expect(h.sends).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(s.present).toBe(1);
  });

  it('Redis missing (presence unavailable) is away: it pushes', async () => {
    const h = harness([row()], { presence: async () => ({ state: 'away', reason: 'unavailable' }) });
    await h.run();
    expect(h.sends).toHaveLength(1);
  });

  it('each person gets their own key, never another person\'s', async () => {
    const h = harness([row({ ownerUserId: ALICE }), row({ ownerUserId: BOB })]);
    await h.run();
    expect(h.sends.map(m => m.user).sort()).toEqual([ALICE_KEY, BOB_KEY].sort());
    expect(h.marks.map(m => m[0])).toEqual([{ userId: ALICE }, { userId: BOB }]);
  });

  it('marks after a successful send only; a failed send marks nothing and retries later', async () => {
    const h = harness([row()], { send: async () => 'failed' });
    const s = await h.run();
    expect(h.marks).toEqual([]);
    expect(h.requeued).toHaveLength(1);
    expect(s.failed).toBe(1);
  });

  it('a key Pushover rejects is flagged and nothing is marked', async () => {
    const h = harness([row()], { send: async () => 'rejected' });
    await h.run();
    expect(h.rejected).toEqual([ALICE]);
    expect(h.marks).toEqual([]);
  });

  it('with no sender token configured the ledger is not even read', async () => {
    const h = harness([row()], { senderToken: () => null });
    const s = await h.run();
    expect(s.gated).toBe('no_sender');
    expect(h.statements).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('only live, pending, person-owned, recent rows are picked', () => {
    const q = text(pendingPersonRowsSql(now));
    expect(q).toContain(`d."status" = 'pending'`);
    expect(q).toContain('s."owner_user_id" is not null');
    expect(q).toContain('s."ended_at" is null');
    expect(q).toContain('d."created_at" >');
  });
});

describe('never the team key', () => {
  it('no personal key: no push, even though a team Pushover channel may exist', async () => {
    const h = harness([row()], { loadKey: async () => null });
    const s = await h.run();
    expect(h.sends).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(s.noKey).toBe(1);
  });

  it('the key query is the personal purpose, this person, this team: no team-row branch', () => {
    const q = render(personalPushoverKeySql(ALICE, TEAM));
    const sqlText = q.sql.replace(/\s+/g, ' ');
    expect(sqlText).toContain('s."purpose" = $1');
    expect(q.params[0]).toBe(PERSONAL_PUSHOVER_PURPOSE);
    expect(PERSONAL_PUSHOVER_PURPOSE).toBe('pushover_personal');
    expect(sqlText).toContain('s."user_id" = $2::uuid');
    expect(q.params[1]).toBe(ALICE);
    expect(sqlText).toContain('s."team_id" = $3::uuid');
    expect(q.params[2]).toBe(TEAM);
    // No OR anywhere, no NULL-user (team) row, no team `pushover` purpose.
    expect(sqlText).not.toMatch(/\bor\b/i);
    expect(sqlText).not.toContain('user_id" is null');
    expect(q.params).not.toContain('pushover');
  });

  it('the default loader issues exactly that query and decrypts the value', async () => {
    const seen: SQL[] = [];
    const key = await loadPersonalPushoverKey(ALICE, TEAM, async (q) => { seen.push(q); return { rows: [{ encryptedValue: `enc:${ALICE_KEY}` }] }; });
    expect(key).toBe(ALICE_KEY);
    expect(render(seen[0]).params.slice(0, 3)).toEqual(['pushover_personal', ALICE, TEAM]);
  });

  it('the away path does not import the team channel reader', () => {
    for (const f of ['away-delivery.ts', 'personal-pushover.ts']) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8');
      expect(src).not.toContain('getTeamChannel');
      expect(src).not.toContain("from './notify'");
      expect(src).not.toMatch(/purpose[^\n]*['"]pushover['"]/);
    }
  });
});

describe('coalescing and rate limits', () => {
  it('a burst for one person becomes one message listing each event', async () => {
    const rows = [
      row(),
      row({ eventType: 'pr.merged', payload: { repo: 'acme/widgets', prNumber: 42, url: 'https://github.example/pr/42' } }),
      row({ eventType: 'task.failed' }),
    ];
    const h = harness(rows);
    await h.run();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].title).toBe('3 updates');
    expect(h.sends[0].message).toContain('PR merged: acme/widgets#42');
    expect(h.sends[0].message).toContain('Task failed:');
    expect(h.marks).toHaveLength(3);
  });

  it('waits until the burst is a window old before sending', async () => {
    const h = harness([row({ createdAt: ago(COALESCE_MS / 2) })]);
    const s = await h.run();
    expect(h.sends).toEqual([]);
    expect(s.notReady).toBe(1);
  });

  it('an urgent row does not wait for the window, and gets high priority', async () => {
    const h = harness([row({ urgency: 'urgent', createdAt: ago(1000) })]);
    await h.run();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].priority).toBe(1);
  });

  it(`past ${URGENT_PUSHES_PER_HOUR} urgent pushes an hour, urgent goes out at normal priority`, async () => {
    const h = harness([row({ urgency: 'urgent' })], { urgentLastHour: URGENT_PUSHES_PER_HOUR });
    await h.run();
    expect(h.sends[0].priority).toBe(0);
  });

  it(`at ${PUSHES_PER_HOUR} pushes in the hour: rows are held, one notice says so, and they are retried later`, async () => {
    const rows = [row(), row()];
    const h = harness(rows, { sentLastHour: PUSHES_PER_HOUR });
    const s = await h.run();
    expect(s.held).toBe(1);
    expect(h.marks).toEqual([]);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].message).toContain('2 more updates are held');
    expect(h.requeued[0][0]).toEqual(rows.map(r => r.id));
    expect(h.requeued[0][1]).toBeGreaterThan(now.getTime());
  });

  it('the held notice goes out once per hour, not every tick', async () => {
    const h = harness([row()], { sentLastHour: PUSHES_PER_HOUR, heldNoticeOnce: async () => false });
    await h.run();
    expect(h.sends).toEqual([]);
  });

  it('the rate is counted per person, from pushover deliveries in the last hour, one per message', () => {
    const q = render(recentPushesSql(ALICE, now));
    const t = q.sql.replace(/\s+/g, ' ');
    expect(t).toContain('count(distinct d."delivered_at")');
    expect(t).toContain(`d."route" = 'pushover'`);
    expect(t).toContain('s."owner_user_id" = $1::uuid');
    expect(q.params[0]).toBe(ALICE);
  });

  it('long bursts are truncated with a count of the rest', () => {
    const rows = Array.from({ length: 11 }, () => row());
    const m = renderAwayMessage(rows, { appUrl: 'https://app.example', urgentAllowed: true });
    expect(m.message.split('\n')).toHaveLength(9);
    expect(m.message).toContain('and 3 more');
  });
});
