/**
 * Team scoping, asserted on rendered SQL (PgDialect), not on a mocked db that
 * would accept any predicate.
 */
import { describe, expect, it, mock } from 'bun:test';

const captured: { op: string; table?: string; where: unknown }[] = [];
const setValues: { table?: string; values: any }[] = [];
// Rows a bare awaited select resolves to; [] unless a test sets it.
let selectRows: unknown[] = [];
const tableName = (t: any): string | undefined => t?.[Symbol.for('drizzle:Name')];
const chain = (op: string, table?: string): any => {
  const c: any = {
    from: () => c, leftJoin: () => c, orderBy: () => c, limit: () => Promise.resolve([]), groupBy: () => Promise.resolve([]),
    set: (v: unknown) => { setValues.push({ table, values: v }); return c; }, values: () => Promise.resolve(),
    where: (w: unknown) => { captured.push({ op, table, where: w }); return c; },
    returning: () => Promise.resolve([{ id: 'a' }, { id: 'b' }]),
    then: (r: any) => Promise.resolve(op === 'select' ? selectRows : []).then(r),
  };
  return c;
};
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => chain('select'),
    delete: () => chain('delete'),
    update: (t: unknown) => chain('update', tableName(t)),
    insert: () => chain('insert'),
    query: { teams: { findFirst: async () => null }, tasks: { findFirst: async () => null } },
  },
}));

// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mock(async () => {}),
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));

const { PgDialect } = await import('drizzle-orm/pg-core');
const {
  activateAccountDogfood, dogfoodOwnerExists, dogfoodTeamOwnersWhere, dogfoodUnsyncedWhere, inheritAccountDogfood,
  readTeamRetroState, reconcileAccountDogfood,
} = await import('./store');
const { clusterWhere, dogfoodTeamIds, listOptedInTeams, highConfidenceEvidence, deleteTeamLessons, insertProposalTask, priorFilingWhere, filedTodayWhere, listRecentLessons, optedInTeamsWhere, pendingConversationsWhere, teamLessonsWhere, writeTeamSettings } = await import('./store');
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

describe('account dogfood: an owner keeps every team they own on', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const USER = '33333333-3333-4333-8333-333333333333';
  const reset = () => { captured.length = 0; setValues.length = 0; selectRows = []; };

  it('a team counts as dogfood only through an owner (not an admin or member) with the flag set', () => {
    const q = render(dogfoodOwnerExists()).sql;
    expect(q).toContain(`"team_members"."team_id" = "teams"."id"`);
    expect(q).toContain(`"team_members"."role" = 'owner'`);
    expect(q).toContain(`"users"."chat_retro_dogfood_at" is not null`);
  });

  it('the daily pass picks up opted-in teams or teams with a dogfood owner, nothing else', () => {
    const q = render(optedInTeamsWhere()).sql;
    expect(q).toContain(`("teams"."chat_retro" ->> 'lessons') = 'true' or exists (`);
  });

  it('a dogfood team reads as lessons + proposals whatever is stored; an unrelated team keeps its stored default (off)', async () => {
    reset();
    selectRows = [
      { id: TEAM, chatRetro: null, dogfoodOwner: true },
      { id: OTHER, chatRetro: { lessons: true }, dogfoodOwner: false },
    ];
    try {
      const teams = await listOptedInTeams();
      expect(teams).toEqual([
        { teamId: TEAM, settings: { lessons: true, proposals: true }, dogfood: true },
        { teamId: OTHER, settings: { lessons: true, proposals: false }, dogfood: false },
      ]);
      selectRows = [{ chatRetro: null, dogfoodOwner: false }];
      expect(await readTeamRetroState(OTHER)).toEqual({ settings: { lessons: false, proposals: false }, dogfood: false });
      selectRows = [{ chatRetro: { lessons: false }, dogfoodOwner: true }];
      expect(await readTeamRetroState(TEAM)).toEqual({ settings: { lessons: true, proposals: true }, dogfood: true });
    } finally { reset(); }
  });

  it('activation sets the flag once (first time kept) and backfills only the teams that person owns', async () => {
    reset();
    const out = await activateAccountDogfood(USER, NOW);
    expect(out.syncedTeamIds).toEqual(['a', 'b']);
    const [u, t] = captured;
    expect(u.table).toBe('users');
    expect(render(u.where).sql).toContain(`"users"."chat_retro_dogfood_at" is null`);
    expect(render(u.where).params).toEqual([USER]);
    expect(setValues[0]).toEqual({ table: 'users', values: { chatRetroDogfoodAt: NOW } });
    expect(t.table).toBe('teams');
    const tq = render(t.where);
    expect(tq.sql).toContain(`"teams"."id" in (select "team_members"."team_id" from "team_members" where "team_members"."user_id" = $1 and "team_members"."role" = 'owner')`);
    expect(tq.params).toEqual([USER]);
    expect(setValues[1].values.chatRetro).toEqual({ lessons: true, proposals: true });
    reset();
  });

  it('the sync only rewrites teams not already fully on', () => {
    expect(render(dogfoodUnsyncedWhere()).sql).toContain(`not (coalesce("teams"."chat_retro" ->> 'lessons', '') = 'true' and coalesce("teams"."chat_retro" ->> 'proposals', '') = 'true')`);
  });

  it('reconciliation activates the owners of CHAT_RETRO_DOGFOOD_TEAM_IDS (malformed ids dropped), then syncs every dogfood team', async () => {
    reset();
    const r = await reconcileAccountDogfood({ CHAT_RETRO_DOGFOOD_TEAM_IDS: `${TEAM},not-a-uuid` });
    expect(r).toEqual({ activatedUsers: 2, syncedTeams: 2 });
    expect(captured.map(c => c.table)).toEqual(['users', 'teams']);
    expect(render(captured[0].where).params).toEqual([TEAM]);
    expect(render(dogfoodTeamOwnersWhere([TEAM])).sql).toContain(`"team_members"."role" = 'owner'`);

    reset();
    expect((await reconcileAccountDogfood({})).activatedUsers).toBe(0);
    expect(captured.map(c => c.table)).toEqual(['teams']);
    reset();
  });

  it('a new team inherits its creator\'s account dogfood; a creator without it leaves the team at the default', async () => {
    reset();
    selectRows = [{ at: NOW }];
    expect(await inheritAccountDogfood(OTHER, USER)).toBe(true);
    expect(setValues).toEqual([{ table: 'teams', values: expect.objectContaining({ chatRetro: { lessons: true, proposals: true } }) }]);

    reset();
    selectRows = [];
    expect(await inheritAccountDogfood(OTHER, USER)).toBe(false);
    expect(setValues).toEqual([]);
    reset();
  });
});

describe('dogfood: the production team list resolves the first-occurrence policy from CHAT_RETRO_DOGFOOD_TEAM_IDS', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const optedIn = { lessons: true, proposals: true };

  it('parses a comma-separated list, trimming blanks; unset is empty', () => {
    expect([...dogfoodTeamIds({ CHAT_RETRO_DOGFOOD_TEAM_IDS: ` ${TEAM} ,, ${OTHER}` })]).toEqual([TEAM, OTHER]);
    expect(dogfoodTeamIds({}).size).toBe(0);
  });

  it('listOptedInTeams flags the configured team dogfood and no other', async () => {
    const prev = process.env.CHAT_RETRO_DOGFOOD_TEAM_IDS;
    selectRows = [{ id: TEAM, chatRetro: optedIn }, { id: OTHER, chatRetro: optedIn }];
    try {
      process.env.CHAT_RETRO_DOGFOOD_TEAM_IDS = TEAM;
      const teams = await listOptedInTeams();
      expect(teams.map(t => [t.teamId, t.dogfood])).toEqual([[TEAM, true], [OTHER, false]]);

      delete process.env.CHAT_RETRO_DOGFOOD_TEAM_IDS;
      expect((await listOptedInTeams()).every(t => t.dogfood === false)).toBe(true);
    } finally {
      selectRows = [];
      if (prev === undefined) delete process.env.CHAT_RETRO_DOGFOOD_TEAM_IDS;
      else process.env.CHAT_RETRO_DOGFOOD_TEAM_IDS = prev;
    }
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

  it('clusters: team, signed, last 14 days (a signature only exists on a judged lesson or a code-found visible-answer failure)', () => {
    const q = render(clusterWhere(TEAM, NOW));
    expect(q.sql).toContain('"chat_retros"."team_id" = $1');
    expect(q.sql).toContain('"chat_retros"."signature" is not null');
    expect(q.sql).not.toContain('"chat_retros"."status"');
    expect(q.params[0]).toEqual(TEAM);
  });

  it('high-confidence evidence: a no_output or render_gap entry at full confidence', () => {
    const q = render(highConfidenceEvidence());
    expect(q.sql).toContain('jsonb_array_elements("chat_retros"."evidence")');
    expect(q.params).toEqual(['no_output', 'render_gap', 1]);
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

describe('a filed proposal is work for a worker', () => {
  const cluster = { workspaceId: 'ws-1', signature: 'sig', sessions: 3, lessonIds: ['l1'] } as never;

  it('wakes the task it filed', async () => {
    mockWakeTask.mockClear();
    const { db } = await import('@buildd/core/db');
    const orig = db.insert;
    (db as any).insert = () => ({ values: () => ({ returning: async () => [{ id: 'a' }] }) });
    const id = await insertProposalTask({ cluster, title: 'T', description: 'D' }).finally(() => { (db as any).insert = orig; });
    expect(id).toBe('a');
    expect(mockWakeTask).toHaveBeenCalledWith('a', 'task.created');
  });

  it('files and wakes nothing without a target workspace', async () => {
    mockWakeTask.mockClear();
    const id = await insertProposalTask({ cluster: { ...(cluster as object), workspaceId: null } as never, title: 'T', description: 'D' });
    expect(id).toBeNull();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });
});
