/**
 * loadMissionCardViews: one batched steering read, capped to the missions the
 * surface shows (docs/design/mission-feed-mobile-continuity.md, S5).
 * Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';

const calls: string[][] = [];
mock.module('./mission-steering-notes', () => ({
  loadHumanSteeringMarksByMission: async (ids: string[]) => {
    calls.push(ids);
    return new Map();
  },
}));

const { loadMissionCardViews, MISSION_CARD_VIEW_CAP, homeMissionRecencyWhere } = await import('./mission-card-views');

const row = (id: string, status = 'active') => ({
  id,
  title: `Mission ${id}`,
  status,
  tasks: [{
    id: `${id}-t`, title: 'Work', status: 'in_progress', taskClass: 'work', createdAt: new Date(),
    workers: [{ id: `${id}-w`, status: 'running', startedAt: new Date(Date.now() - 60_000) }],
  }],
});

describe('loadMissionCardViews', () => {
  it('reads steering once for the unfinished visible missions and builds a view per mission', async () => {
    calls.length = 0;
    const views = await loadMissionCardViews([row('a'), row('b'), row('c', 'completed')], { from: 'home' });
    expect(calls).toEqual([['a', 'b']]);
    expect([...views.keys()]).toEqual(['a', 'b', 'c']);
    expect(views.get('a')!.flightStrip).not.toBeNull();
    expect(views.get('c')!.compact).toBe(true);
    expect(views.get('a')!.href).toBe('/app/missions/a?from=home');
  });

  it('never builds more than the cap', async () => {
    calls.length = 0;
    const many = Array.from({ length: MISSION_CARD_VIEW_CAP + 5 }, (_, i) => row(`m${i}`));
    const views = await loadMissionCardViews(many, { from: 'home' });
    expect(views.size).toBe(MISSION_CARD_VIEW_CAP);
    expect(calls[0]).toHaveLength(MISSION_CARD_VIEW_CAP);
  });

  it('skips the read entirely when nothing visible is unfinished', async () => {
    calls.length = 0;
    await loadMissionCardViews([row('x', 'completed')], { from: 'missions' });
    expect(calls).toEqual([]);
  });
});

describe('card query shape', () => {
  it('the nested workers are latest-first, so the live attempt is inside the limit', () => {
    const { MISSION_CARD_WORKERS_WITH } = require('./mission-card-views');
    expect(MISSION_CARD_WORKERS_WITH.limit).toBe(5);
    const order = MISSION_CARD_WORKERS_WITH.orderBy(
      { startedAt: 'startedAt', updatedAt: 'updatedAt' },
      { desc: (c: string) => `${c} desc` },
    );
    expect(order).toEqual(['startedAt desc', 'updatedAt desc']);
  });

  it('the card task columns carry no task.result jsonb', () => {
    const { MISSION_CARD_TASK_COLUMNS } = require('./mission-card-views');
    expect('result' in MISSION_CARD_TASK_COLUMNS).toBe(false);
  });
});

// ── Bounded card query (task 16e1cc50) ──────────────────────────────────────
// Home loaded every mission's tasks with the whole `tasks.context` blob, which
// grew to tens of MB per render in production traces once context was added
// to the card columns (knowledge-base: buildd/reports/core-page-performance-2026-10-17.md).
// The card now receives a digest of the keys it reads, and Home loads only the
// completed missions it can still show.
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as drizzleSql } from 'drizzle-orm';
import { tasks as tasksTable, taskSchedules } from '@buildd/core/db/schema';
import { classifySingleTaskWait } from './mission-wait';
import { deriveCiRedChain } from './ci-red-chain';
import { deliverableRole } from '@buildd/core/mission-helpers';
import { isTrunkRefreshTask, surfaceAuditRound, surfaceAuditTrigger } from '@buildd/core/surface-audit';

const dialect = new PgDialect();
const bulky = 'x'.repeat(50_000);

describe('card task context is a digest, never the whole column (task 16e1cc50)', () => {
  const mod = require('./mission-card-views');

  it('the task columns select neither context nor result; the loop columns stay', () => {
    expect(Object.keys(mod.MISSION_CARD_TASK_COLUMNS)).not.toContain('context');
    expect(Object.keys(mod.MISSION_CARD_TASK_COLUMNS)).not.toContain('result');
    expect(mod.MISSION_CARD_TASK_COLUMNS.loopConfig).toBe(true);
    expect(mod.MISSION_CARD_TASK_COLUMNS.loopState).toBe(true);
  });

  it('pins the digest keys: adding one is a deliberate edit here', () => {
    expect([...mod.MISSION_CARD_CONTEXT_KEYS].sort()).toEqual([
      'baseBranch', 'budgetExhausted', 'finalVerification', 'heartbeat', 'infraRetryCount',
      'prNumber', 'refreshTrunk', 'requireMergeCommit', 'resumeBranch', 'specRepair',
      'surfaceAuditRound', 'surfaceAuditTrigger', 'surfaceFix', 'visualQa',
    ]);
    expect([...mod.MISSION_CARD_CONTEXT_FAILURE_KEYS]).toEqual(['summary']);
  });

  it('the extras project context by key, never the bare column', () => {
    expect(Object.keys(mod.MISSION_CARD_TASK_EXTRAS).sort()).toEqual(['context', 'isIntegrationRefresh']);
    const aliased = mod.MISSION_CARD_TASK_EXTRAS.context(tasksTable, { sql: drizzleSql });
    const q = dialect.sqlToQuery(aliased.getSQL());
    const col = '"tasks"."context"';
    const bare = q.sql.split(col).slice(1).filter((rest: string) => !rest.startsWith('->') && !rest.startsWith(' is null'));
    expect(bare).toHaveLength(0);
    expect(q.sql).toContain('jsonb_build_object');
    for (const k of mod.MISSION_CARD_CONTEXT_KEYS) expect(q.params).toContain(k);
    expect(q.params).toContain('failureContext');
    expect(q.params).not.toContain('notifiedOverlaps');
  });

  it('the JS twin keeps the card keys and failureContext.summary only', () => {
    expect(mod.digestMissionCardContext(null)).toBeNull();
    expect(mod.digestMissionCardContext({
      budgetExhausted: true, infraRetryCount: 2, prompt: bulky, notifiedOverlaps: [bulky],
      failureContext: { summary: 'lint failed', log: bulky },
    })).toEqual({ budgetExhausted: true, infraRetryCount: 2, failureContext: { summary: 'lint failed' } });
  });

  it('every card reader answers the same over the full context and the digest', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const later = new Date('2026-06-01T13:00:00Z');
    const contexts: Record<string, unknown>[] = [
      { budgetExhausted: true, padding: bulky },
      { infraRetryCount: 1, padding: bulky },
      { finalVerification: { specId: 's' }, padding: bulky },
      { surfaceFix: { round: 1 } },
      { specRepair: { criterionId: 'AC-1' } },
      { requireMergeCommit: true },
      { refreshTrunk: 'abc123' },
      { surfaceAuditRound: 2, surfaceAuditTrigger: 'human', visualQa: { requiredRoutes: ['/app/home'] } },
      { prNumber: 41, failureContext: { summary: 'job: build failed', log: bulky } },
      {},
    ];
    for (const context of contexts) {
      const digest = mod.digestMissionCardContext(context);
      const task = (c: unknown) => ({
        id: 't', title: '[ci-fix #1] Work', status: 'pending', mode: null, taskClass: 'work' as const,
        startAt: later, loopConfig: null, loopState: null, createdAt: now, roleSlug: 'builder', context: c as any,
      });
      expect(classifySingleTaskWait(task(digest), now)).toEqual(classifySingleTaskWait(task(context), now));
      expect(deliverableRole(task(digest))).toBe(deliverableRole(task(context)));
      expect(isTrunkRefreshTask(task(digest))).toBe(isTrunkRefreshTask(task(context)));
      expect(surfaceAuditRound(task(digest))).toBe(surfaceAuditRound(task(context)));
      expect(surfaceAuditTrigger(task(digest))).toBe(surfaceAuditTrigger(task(context)));
      const chain = (c: unknown) => deriveCiRedChain({
        pr: { taskId: 'p', prNumber: 41 }, prLifecycleStatus: 'ci_failed',
        tasks: [{ ...task(c), status: 'failed' }],
      });
      expect(chain(digest)).toEqual(chain(context));
    }
  });

  it('the schedule template is narrowed to context.heartbeat', () => {
    const aliased = mod.MISSION_CARD_SCHEDULE_EXTRAS.taskTemplate(taskSchedules, { sql: drizzleSql });
    const q = dialect.sqlToQuery(aliased.getSQL());
    const col = '"task_schedules"."task_template"';
    expect(q.sql.split(col).slice(1).every((rest: string) => rest.startsWith('->') || rest.startsWith(' is null'))).toBe(true);
    expect(q.params).toEqual(expect.arrayContaining(['context', 'heartbeat']));
  });
});

describe('Home loads only the completed missions it can still show (task 16e1cc50)', () => {
  const mod = require('./mission-card-views');

  it('a completed mission is kept only inside the window; every other status always', () => {
    expect(mod.HOME_COMPLETED_MISSION_WINDOW_MS).toBe(7 * 86_400_000);
    const now = Date.parse('2026-06-01T12:00:00Z');
    const q = dialect.sqlToQuery(homeMissionRecencyWhere(now));
    expect(q.sql).toContain('"missions"."status" <> $1');
    expect(q.sql).toContain('coalesce("missions"."completed_at", "missions"."updated_at") >= $2');
    expect(q.params[0]).toBe('completed');
    expect(new Date(q.params[1] as string).getTime()).toBe(now - mod.HOME_COMPLETED_MISSION_WINDOW_MS);
  });
});

describe('Home reads stored mission summaries, bounded (spec 3ef37387 R-9, R-13)', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const page: string = readFileSync(join(import.meta.dir, '../app/app/(protected)/home/page.tsx'), 'utf8');
  const start = page.indexOf('const missionScope = and(');
  const scope = page.slice(start, page.indexOf(');', start));

  it('scopes to the team, skips archived missions and bounds completed ones', () => {
    expect(scope).toContain("ne(missionsTable.status, 'archived')");
    expect(scope).toContain('homeMissionRecencyWhere(now)');
  });

  it('reads no mission tasks or workers for the cards, and every mission list is capped', () => {
    expect(page).toContain('innerJoin(missionSummaries, stored)');
    expect(page).not.toContain('MISSION_CARD_SCHEDULE_EXTRAS');
    for (const list of ['moving:', 'listedMissions:', 'missingSummaries:']) {
      const at = page.indexOf(`    ${list}`);
      expect(at).toBeGreaterThan(-1);
      expect(page.slice(at, page.indexOf('\n    // ', at + 10))).toMatch(/\.limit\(/);
    }
  });
});
