/**
 * Team scoping, asserted on rendered SQL (PgDialect), not on a mocked db that
 * would accept any predicate.
 */
import { describe, expect, it, mock } from 'bun:test';

const captured: { op: string; where: unknown }[] = [];
const chain = (op: string): any => {
  const c: any = {
    from: () => c, leftJoin: () => c, orderBy: () => c, limit: () => Promise.resolve([]), groupBy: () => Promise.resolve([]),
    set: () => c, values: () => Promise.resolve(),
    where: (w: unknown) => { captured.push({ op, where: w }); return c; },
    returning: () => Promise.resolve([{ id: 'a' }, { id: 'b' }]),
    then: (r: any) => Promise.resolve([]).then(r),
  };
  return c;
};
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => chain('select'),
    delete: () => chain('delete'),
    update: () => chain('update'),
    insert: () => chain('insert'),
    query: { teams: { findFirst: async () => null }, tasks: { findFirst: async () => null } },
  },
}));

const { PgDialect } = await import('drizzle-orm/pg-core');
const { clusterWhere, deleteTeamLessons, priorFilingWhere, filedTodayWhere, listRecentLessons, optedInTeamsWhere, pendingConversationsWhere, teamLessonsWhere, writeTeamSettings } = await import('./store');
const dialect = new PgDialect();
const render = (w: unknown) => dialect.sqlToQuery(w as any);

const TEAM = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-29T14:00:00Z');

describe('opt-in: only teams whose stored lessons flag is literally true', () => {
  it('renders a predicate on chat_retro ->> lessons = true', () => {
    const q = render(optedInTeamsWhere());
    expect(q.sql).toContain(`"teams"."chat_retro" ->> 'lessons') = 'true'`);
  });
});

describe('every read and delete is scoped to one team', () => {
  it('lessons', () => {
    const q = render(teamLessonsWhere(TEAM));
    expect(q.sql).toBe('"chat_retros"."team_id" = $1');
    expect(q.params).toEqual([TEAM]);
  });

  it('pending conversations: team, idle, lookback, and a watermark from the same team', () => {
    const q = render(pendingConversationsWhere(TEAM, NOW));
    expect(q.sql).toContain('"conversations"."team_id" = $1');
    expect(q.sql).toContain('"conversations"."last_message_at" <= $2');
    expect(q.sql).toMatch(/"chat_retros"\."team_id" = \$\d/);
    expect(q.params.filter(p => p === TEAM)).toHaveLength(2);
    expect(q.params[1]).toEqual(new Date(NOW.getTime() - 30 * 60_000).toISOString());
  });

  it('clusters: team, judged, signed, last 14 days', () => {
    const q = render(clusterWhere(TEAM, NOW));
    expect(q.sql).toContain('"chat_retros"."team_id" = $1');
    expect(q.sql).toContain('"chat_retros"."status" = $2');
    expect(q.sql).toContain('"chat_retros"."signature" is not null');
    expect(q.params.slice(0, 2)).toEqual([TEAM, 'judged']);
  });

  it('filed-today counts only this team\'s workspaces', () => {
    const q = render(filedTodayWhere(TEAM, NOW));
    expect(q.sql).toContain(`"workspaces"."team_id" = $`);
    expect(q.params).toContain(TEAM);
    expect(q.params).toContain('chat-retro');
  });

  it('delete-on-disable deletes by team and nothing wider', async () => {
    captured.length = 0;
    const n = await deleteTeamLessons(TEAM);
    expect(n).toBe(2);
    const del = captured.find(c => c.op === 'delete')!;
    const q = render(del.where);
    expect(q.sql).toBe('"chat_retros"."team_id" = $1');
    expect(q.params).toEqual([TEAM]);
  });

  it('the admin lesson list is scoped by team', async () => {
    captured.length = 0;
    await listRecentLessons(TEAM);
    expect(render(captured[0].where).params).toEqual([TEAM]);
  });

  it('turning lessons off stores NULL (the default), not a false flag', async () => {
    const sets: unknown[] = [];
    const { db } = await import('@buildd/core/db');
    const orig = db.update;
    (db as any).update = () => ({ set: (v: unknown) => { sets.push(v); return { where: () => Promise.resolve() }; } });
    await writeTeamSettings(TEAM, { lessons: false, proposals: false });
    await writeTeamSettings(TEAM, { lessons: true, proposals: false });
    (db as any).update = orig;
    expect((sets[0] as any).chatRetro).toBeNull();
    expect((sets[1] as any).chatRetro).toEqual({ lessons: true, proposals: false });
  });
});

describe('proposal dedupe: a prior filing is matched in the same workspace by origin and signature', () => {
  it('scopes to the workspace and binds the signature as a parameter', () => {
    const WS = '22222222-2222-4222-8222-222222222222';
    const q = render(priorFilingWhere(WS, 'sig-abc'));
    expect(q.sql).toContain('"tasks"."workspace_id" = $1');
    expect(q.sql).toContain(`->> 'origin' =`);
    expect(q.sql).toContain(`->> 'frictionSignature' =`);
    expect(q.sql).not.toContain('sig-abc');
    expect(q.params).toContain(WS);
    expect(q.params).toContain('sig-abc');
  });
});
