/**
 * Settings → Budgets: each person's spend split into Interactive (server-side,
 * metered per turn) and Agent runs (runner work), today and this month, in the
 * team's timezone. Admins also get the per-person table. Fixtures are
 * illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { foldSpend, startOfLocalMonth, interactiveSpendSql, agentSpendSql } = await import('./spend-summary');

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const r = new PgDialect().sqlToQuery(q);
  return { text: r.sql.replace(/\s+/g, ' '), params: r.params };
};

describe('startOfLocalMonth', () => {
  it('is midnight on the 1st in the team zone', () => {
    const now = new Date('2026-09-26T21:30:00.000Z');
    expect(startOfLocalMonth(now, 'UTC').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // Auckland is UTC+12 in September: its September 1st starts on August 31st UTC.
    expect(startOfLocalMonth(now, 'Pacific/Auckland').toISOString()).toBe('2026-08-31T12:00:00.000Z');
  });

  it('rolls into the next month once the local date does', () => {
    // 2026-09-30T13:00Z is already October 1st in Auckland (UTC+13 after its DST change).
    expect(startOfLocalMonth(new Date('2026-09-30T13:00:00.000Z'), 'Pacific/Auckland').toISOString()).toBe('2026-09-30T11:00:00.000Z');
  });
});

describe('spend queries', () => {
  const dayStart = new Date('2026-09-26T00:00:00.000Z');
  const monthStart = new Date('2026-09-01T00:00:00.000Z');

  it('meters interactive spend from the team\'s conversations, grouped by person', () => {
    const { text, params } = render(interactiveSpendSql({ teamId: 'team-1', dayStart, monthStart }));
    expect(text).toMatch(/from "conversation_messages" m join "conversations" c on c\."id" = m\."conversation_id"/);
    expect(text).toMatch(/c\."team_id" = \$\d/);
    expect(text).toMatch(/m\."role" in \('user', 'assistant'\)/);
    expect(text).toMatch(/group by c\."created_by_user_id"/);
    expect(params).toEqual(expect.arrayContaining(['team-1', dayStart.toISOString(), monthStart.toISOString()]));
  });

  it('meters agent runs on the team\'s workspaces, attributed to the mission\'s creator', () => {
    const { text, params } = render(agentSpendSql({ teamId: 'team-1', dayStart, monthStart }));
    expect(text).toMatch(/from "workers" w join "workspaces" ws on ws\."id" = w\."workspace_id"/);
    expect(text).toMatch(/left join "tasks" t on t\."id" = w\."task_id" left join "missions" ms on ms\."id" = t\."mission_id"/);
    expect(text).toMatch(/ws\."team_id" = \$\d/);
    expect(text).toMatch(/group by ms\."created_by_user_id"/);
    expect(params).toContain('team-1');
  });
});

describe('foldSpend', () => {
  const members = [
    { userId: 'u-me', name: 'Me', email: 'me@example.com' },
    { userId: 'u-other', name: null, email: 'other@example.com' },
  ];

  it("splits the viewer's own spend into Interactive and Agent runs", () => {
    const s = foldSpend({
      userId: 'u-me',
      interactive: [{ user_id: 'u-me', today: '0.25', month: '3.5' }, { user_id: 'u-other', today: '1', month: '1' }],
      agent: [{ user_id: 'u-me', today: '2', month: '10' }, { user_id: null, today: '4', month: '40' }],
      members,
    });
    expect(s.me).toEqual({ interactive: { today: 0.25, month: 3.5 }, agent: { today: 2, month: 10 } });
  });

  it('lists every member for admins, most spend first, with unattributed runs last', () => {
    const s = foldSpend({
      userId: 'u-me',
      interactive: [{ user_id: 'u-other', today: '1', month: '20' }],
      agent: [{ user_id: 'u-me', today: '0', month: '5' }, { user_id: null, today: '4', month: '40' }],
      members,
    });
    expect(s.people.map((p) => p.label)).toEqual(['other@example.com', 'Me']);
    expect(s.people[0]).toMatchObject({ interactive: { today: 1, month: 20 }, agent: { today: 0, month: 0 } });
    expect(s.unattributedAgent).toEqual({ today: 4, month: 40 });
  });

  it('reads nothing as zero', () => {
    const s = foldSpend({ userId: 'u-me', interactive: [], agent: [], members: [] });
    expect(s.me).toEqual({ interactive: { today: 0, month: 0 }, agent: { today: 0, month: 0 } });
    expect(s.people).toEqual([]);
    expect(s.unattributedAgent).toEqual({ today: 0, month: 0 });
  });
});
