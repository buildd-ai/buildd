/**
 * Activity's loader (spec 3ef37387 R-4, R-11, R-12). Rendered SQL, not a
 * mocked chain: a mocked `db` hides which columns and limits a read has.
 *
 *  - no JSON column is read whole: the two review facts come out of `result`
 *    and `context` in SQL, `loop_config` and the rest are never selected;
 *  - workers are bounded per task, newest first;
 *  - mission and initiative filters narrow every task read in SQL;
 *  - live roots (open, or an agent on them or an attempt) are read however
 *    old, so a root whose only movement is a repair attempt is not starved;
 *  - only the tab on screen is read and built.
 */
import { describe, expect, it, mock } from 'bun:test';
import { drizzle } from 'drizzle-orm/pg-proxy';

const statements: string[] = [];
let answer: (sql: string) => unknown[][] = () => [];
const offline = drizzle(async (sql) => {
  statements.push(sql);
  return { rows: answer(sql) };
});
mock.module('@buildd/core/db', () => ({
  db: {
    select: offline.select.bind(offline),
    batch: async (qs: Array<Promise<unknown>>) => Promise.all(qs),
    execute: async () => ({ rows: [] }),
  },
}));

const {
  loadActivity, overlayActivityRows, mayBeInMotionSql, mayBeFinishedSql, activityScopeWhere, liveRootsWhere, attemptChainIds,
  ACTIVITY_WORKERS_PER_TASK, ACTIVITY_LIVE_ROOT_LIMIT, ACTIVITY_ROOT_LIMIT, ACTIVITY_CHILD_LIMIT,
} = await import('./activity-data');
const rules = await import('@buildd/core/mission-helpers');

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\$\d+/g, '$').toLowerCase();
/** A task row read: Activity's own columns, in field order. */
const isTaskRead = (s: string) => norm(s).startsWith('select "id", "title", "status"') && norm(s).includes(' from "tasks"');
const isRecentRead = (s: string) => isTaskRead(s) && norm(s).includes('"tasks"."updated_at" >=');
const WS = ['00000000-0000-4000-8000-000000000001'];
const NOW = Date.parse('2026-10-18T12:00:00Z');

// Rows come back positionally, in the order of the select's fields.
const taskRow = (id: string, over: Partial<Record<string, unknown>> = {}) => {
  const r = { id, title: `Task ${id}`, status: 'completed', mode: null, taskClass: 'work', parentTaskId: null, missionId: null,
    createdAt: NOW - 3_600_000, updatedAt: NOW - 1_800_000, dependsOn: null, reviewVerdict: null, reviewHeadSha: null, ...over };
  return Object.values(r);
};

async function load(tab: 'now' | 'history', scope: Record<string, unknown> = {}) {
  statements.length = 0;
  return loadActivity({ scope: { workspaceIds: WS, ...scope }, tab, localHolds: new Map(), now: NOW, rules });
}

describe('task reads', () => {
  it('select narrow columns: the review facts come out of result/context in SQL, nothing else of them', async () => {
    answer = (s) => (isRecentRead(s) ? [taskRow('r1')] : []);
    await load('history');
    const taskReads = statements.filter(isTaskRead);
    expect(taskReads.length).toBeGreaterThanOrEqual(2);
    for (const s of taskReads) {
      const head = norm(s).split(' from "tasks"')[0];
      expect(head).not.toMatch(/(^select |, )("tasks"\.)?"(result|context|loop_config|description)"(,|$)/);
      expect(head).toContain(`"tasks"."result"->'effectiveverdict'`);
      expect(head).toContain(`"tasks"."context"->'headsha'`);
    }
  });

  it('the recent window and the live roots are bounded', async () => {
    answer = () => [];
    await load('now');
    const all = norm(statements.join('\n'));
    expect(all).toContain('limit $');
    expect(statements.some(s => norm(s).includes('"tasks"."updated_at" >='))).toBe(true);
    // Both live-root subqueries carry their cap.
    const live = statements.find(s => norm(s).includes('"tasks"."parent_task_id", "tasks"."id")'))!;
    expect(live).toBeDefined();
    expect((norm(live).match(/limit \$/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(ACTIVITY_LIVE_ROOT_LIMIT).toBeGreaterThan(0);
    expect(ACTIVITY_ROOT_LIMIT).toBeGreaterThan(0);
  });

  it('a mission filter narrows every task read in SQL', async () => {
    answer = () => [];
    await load('now', { missionId: '00000000-0000-4000-8000-0000000000aa' });
    const taskReads = statements.filter(s => norm(s).includes('from "tasks"'));
    expect(taskReads.length).toBeGreaterThan(0);
    for (const s of taskReads) expect(norm(s)).toContain('"tasks"."mission_id" = $');
  });

  it('an initiative filter narrows to its missions in SQL', async () => {
    answer = () => [];
    await load('history', { initiativeId: '00000000-0000-4000-8000-0000000000bb' });
    const taskReads = statements.filter(s => norm(s).includes('from "tasks"'));
    for (const s of taskReads) expect(norm(s)).toContain('"tasks"."mission_id" in (select "id" from "missions" where "missions"."initiative_id" = $');
  });
});

describe('worker reads', () => {
  it('are bounded per task, newest first, and read no JSON whole', async () => {
    answer = (s) => (isRecentRead(s) ? [taskRow('r1')] : []);
    await load('history');
    const w = statements.find(s => norm(s).includes('row_number() over (partition by "task_id"'));
    expect(w).toBeDefined();
    expect(norm(w!)).toContain('order by "started_at" desc, "updated_at" desc');
    expect(norm(w!)).toContain('where "w"."rn" <= $');
    expect(norm(w!)).not.toMatch(/(^select |, )("workers"\.)?"(milestones|mcp_calls|result_meta|instruction_history|waiting_for)"(,| from)/);
    expect(ACTIVITY_WORKERS_PER_TASK).toBe(5);
    expect(ACTIVITY_CHILD_LIMIT).toBeGreaterThan(0);
  });
});

describe('only the tab on screen', () => {
  it('Now reads the recent roots that may be in motion; History the live roots that may be finished', async () => {
    answer = () => [];
    await load('now');
    const nowSql = norm(statements.join('\n'));
    await load('history');
    const historySql = norm(statements.join('\n'));
    const inMotion = norm(new (await import('drizzle-orm/pg-core')).PgDialect().sqlToQuery(mayBeInMotionSql()).sql);
    const finished = norm(new (await import('drizzle-orm/pg-core')).PgDialect().sqlToQuery(mayBeFinishedSql()).sql);
    expect(nowSql).toContain(inMotion);
    expect(nowSql).not.toContain(finished);
    expect(historySql).toContain(finished);
    expect(historySql).not.toContain(inMotion);
  });

  it('builds Now without History and History without Now', async () => {
    answer = (s) => (isRecentRead(s) ? [taskRow('r1')] : []);
    const now = await load('now');
    expect(now.history).toEqual([]);
    const history = await load('history');
    expect(history.now.groups).toEqual([]);
    expect(history.history.map(e => e.id)).toEqual(['r1']);
  });

  it('the in-motion test looks up workers per task, never with an OR that scans them all', () => {
    const q = norm(new (require('drizzle-orm/pg-core').PgDialect)().sqlToQuery(mayBeInMotionSql()).sql);
    expect(q).toContain('"workers"."task_id" = "tasks"."id" and');
    expect(q).not.toMatch(/"workers"\."task_id" = "tasks"\."id" or/);
  });
});

describe('overlay', () => {
  it('AC-26: a merged worker row reads as not merged while its delivery is in review', () => {
    const merged = { prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', mergedAt: new Date('2026-10-01'), prLifecycleStatus: 'merged' };
    const view = { ownerTaskId: 't1', repoFullName: 'acme/app', prNumber: 7, state: 'AWAITING_REVIEW', prState: 'ci_passed', mergedAt: null, headline: 'Review queued' } as any;
    const out = overlayActivityRows({
      workersByTask: new Map([['t1', [{ ...merged }]], ['legacy', [{ ...merged, prNumber: 9 }]]]),
      missions: [{ id: 'm1', tasks: [{ id: 't1', workers: [{ ...merged }] }] }],
      views: new Map([['t1', view]]),
    });
    expect(out.workersByTask.get('t1')![0]).toMatchObject({ mergedAt: null, prLifecycleStatus: 'ci_green' });
    expect((out.missions[0]!.tasks![0] as any).workers[0]).toMatchObject({ mergedAt: null, prLifecycleStatus: 'ci_green' });
    // No delivery: the worker row stands.
    expect(out.workersByTask.get('legacy')![0]).toMatchObject({ prLifecycleStatus: 'merged' });
  });
});

const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

describe('the page', () => {
  it('a failed load reaches the view as an error, not as empty data', () => {
    const c = page.slice(page.indexOf('} catch (error) {'));
    expect(c).toContain('loadFailed = true');
    expect(page).toContain('loadError={loadFailed}');
  });

  it('reads local sessions only for Now', () => {
    expect(page).toMatch(/mode === 'now'\s*\?\s*listLocalSessions/);
  });
});

describe('the scope and live-root predicates, rendered', () => {
  const render = (q: Parameters<InstanceType<typeof import('drizzle-orm/pg-core').PgDialect>['sqlToQuery']>[0]) =>
    norm(new (require('drizzle-orm/pg-core').PgDialect)().sqlToQuery(q).sql);

  it('activityScopeWhere narrows to the workspaces, then the mission or the initiative\'s missions', () => {
    expect(render(activityScopeWhere({ workspaceIds: WS })!)).toBe('"tasks"."workspace_id" in ($)');
    expect(render(activityScopeWhere({ workspaceIds: WS, missionId: 'm1' })!))
      .toBe('(("tasks"."workspace_id" in ($)) and ("tasks"."mission_id" = $))');
    expect(render(activityScopeWhere({ workspaceIds: WS, initiativeId: 'i1' })!))
      .toContain('"tasks"."mission_id" in (select "id" from "missions" where "missions"."initiative_id" = $)');
  });

  it('liveRootsWhere reads open roots and roots with a live agent, bounded, minus the recent window', () => {
    const { tasks: tasksTable } = require('@buildd/core/db/schema');
    const recent = offline.select({ id: tasksTable.id }).from(tasksTable).limit(5);
    const now = render(liveRootsWhere({ workspaceIds: WS }, recent, 'now')!);
    expect(now).toContain('"tasks"."parent_task_id" is null');
    expect(now).toContain('"tasks"."status" not in');
    expect(now).toContain('"tasks"."parent_task_id", "tasks"."id")');
    expect(now).toContain('inner join "tasks" on "workers"."task_id" = "tasks"."id"');
    expect(now).toContain('"workers"."status" in');
    expect(now.match(/ limit \$/g)?.length).toBe(3);
    expect(now).toContain('"tasks"."id" not in (select "id" from "tasks" limit $)');
    // History adds the "may be finished" filter; Now does not.
    const finished = render(mayBeFinishedSql());
    expect(now).not.toContain(finished);
    expect(render(liveRootsWhere({ workspaceIds: WS }, recent, 'history')!)).toContain(finished);
    expect(ACTIVITY_LIVE_ROOT_LIMIT).toBeGreaterThan(0);
  });

  it('attemptChainIds walks children of the roots, then only through attempts, depth-bounded', () => {
    const q = render(attemptChainIds(['r1', 'r2']));
    expect(q).toContain('with recursive chain(id, task_class, depth) as (');
    expect(q).toContain('where "tasks"."parent_task_id" in ($, $)');
    expect(q).toContain('join chain on t.parent_task_id = chain.id');
    expect(q).toContain(`where chain.task_class = 'attempt' and chain.depth < $`);
    expect(q.endsWith('select id from chain)')).toBe(true);
  });
});

describe('live work with context (spec 9430a28f R-2, R-3)', () => {
  it('reads every generation of a root\'s attempts, walking parent_task_id through attempts, bounded', async () => {
    answer = (s) => (isRecentRead(s) ? [taskRow('r1')] : []);
    await load('now');
    const child = statements.find(s => isTaskRead(s) && norm(s).includes('with recursive'));
    expect(child).toBeDefined();
    const q = norm(child!);
    expect(q).toContain('join chain on t.parent_task_id = chain.id');
    expect(q).toContain(`chain.task_class = 'attempt'`);
    expect(q).toContain('chain.depth < $');
    expect(q).toContain('limit $');
  });

  it('a live agent deep in a chain holds the chain\'s root, by its lineage stamp', () => {
    const { tasks: tasksTable } = require('@buildd/core/db/schema');
    const recent = offline.select({ id: tasksTable.id }).from(tasksTable).limit(5);
    const q = norm(new (require('drizzle-orm/pg-core').PgDialect)().sqlToQuery(liveRootsWhere({ workspaceIds: WS }, recent, 'now')!).sql);
    expect(q).toContain(`"tasks"."context"->>'roottaskid'`);
  });

  it('a 3-generation chain loads as one delivery with its attempts folded', async () => {
    answer = (s) => {
      if (isRecentRead(s)) return [taskRow('r1', { status: 'pending' })];
      if (isTaskRead(s) && norm(s).includes('with recursive')) return [
        taskRow('a1', { taskClass: 'attempt', parentTaskId: 'r1', title: '[builder · after CI #1] Task r1', status: 'completed' }),
        taskRow('a2', { taskClass: 'attempt', parentTaskId: 'a1', title: '[builder · after CI #2] Task r1', status: 'completed' }),
        taskRow('a3', { taskClass: 'attempt', parentTaskId: 'a2', title: '[builder · after CI #3] Task r1', status: 'pending' }),
      ];
      return [];
    };
    const out = await load('now');
    const rows = out.now.groups.flatMap(g => g.rows);
    expect(rows.map(r => r.id)).toEqual(['r1']);
    expect(rows[0].children.map(c => [c.id, c.generation, c.parent.id])).toEqual([['a1', 1, 'r1'], ['a2', 2, 'a1'], ['a3', 3, 'a2']]);
  });

  it('missions are read with their created time; History adds a creation event for one created in its window', async () => {
    const missionRow = (id: string, createdAt: number) => [id, `Mission ${id}`, 'active', createdAt, null];
    answer = (s) => {
      if (isRecentRead(s)) return [taskRow('r1', { missionId: 'm-new', status: 'pending' })];
      if (norm(s).startsWith('select "missions"."id"') || norm(s).includes(' from "missions" left join')) return [missionRow('m-new', NOW - 600_000)];
      return [];
    };
    const out = await load('history');
    const m = statements.find(s => norm(s).includes(' from "missions" left join'))!;
    expect(norm(m)).toContain('"missions"."created_at"');
    expect(out.history.filter(e => e.event === 'created').map(e => e.id)).toEqual(['created:m-new']);
    const now = await load('now');
    expect(now.now.groups.find(g => g.missionId === 'm-new')?.isNew).toBe(true);
  });
});
