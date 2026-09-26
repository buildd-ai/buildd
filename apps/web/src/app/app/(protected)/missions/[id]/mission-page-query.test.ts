/**
 * AC-18 (docs/design/mission-feed-mobile-continuity.md, slice S7): the mission
 * page's task query does not select artifact `content`, task `result` or task
 * `context`. What the page does read from `result` and `context` arrives as a
 * projected digest, and the digest is proven sufficient by running the page's
 * own readers over the full value and over the digest.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { asc, desc, type SQL } from 'drizzle-orm';
import { mapColumnsInSQLToAlias } from 'drizzle-orm/alias';
import { artifacts } from '@buildd/core/db/schema';
import { selectMissionCompletionSummary } from '@/lib/mission-helpers';
import { getHeartbeatStatus } from '@/lib/heartbeat-helpers';
import { buildAttemptStrips } from '@/lib/attempt-strip';
import {
  MISSION_ARTIFACT_COLUMNS,
  MISSION_DETAIL_WITH,
  MISSION_TASK_COLUMNS,
  MISSION_WORKER_COLUMNS,
  MISSION_TASKS_WITH,
  RESULT_DIGEST_SQL,
  CONTEXT_DIGEST_SQL,
  TASK_DIGEST_SELECTION,
  digestTaskContext,
  digestTaskResult,
  indexTaskDigests,
  MISSION_VISUAL_SHOT_COLUMNS,
  MISSION_VISUAL_SHOTS_LIMIT,
  missionVisualShotsWhere,
  MISSION_VISUAL_SHOTS_ORDER,
} from './mission-page-query';

const PAGE = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
const dialect = new PgDialect();

describe('AC-18: mission page query shape', () => {
  it('task columns select neither result nor context', () => {
    expect(Object.keys(MISSION_TASK_COLUMNS)).not.toContain('result');
    expect(Object.keys(MISSION_TASK_COLUMNS)).not.toContain('context');
    // The probe can fail: a column the page does read is present.
    expect(MISSION_TASK_COLUMNS.status).toBe(true);
  });

  it('worker columns carry what the Board and Lanes draw', () => {
    // runner → lanes and fleet slots; milestones → tile notches;
    // lines → the landed rows and the completion record.
    for (const k of ['runner', 'milestones', 'linesAdded', 'linesRemoved', 'waitingFor', 'startedAt', 'completedAt'] as const) {
      expect(MISSION_WORKER_COLUMNS[k]).toBe(true);
    }
    expect(MISSION_TASK_COLUMNS.outputRequirement).toBe(true);
    expect(MISSION_TASK_COLUMNS.label).toBe(true);
  });

  it('artifact columns do not select content', () => {
    expect(Object.keys(MISSION_ARTIFACT_COLUMNS)).not.toContain('content');
    expect(MISSION_ARTIFACT_COLUMNS.title).toBe(true);
  });

  it('the nested with-tree carries the trimmed column sets', () => {
    expect(MISSION_DETAIL_WITH.tasks).toBe(MISSION_TASKS_WITH);
    expect(MISSION_TASKS_WITH.columns).toBe(MISSION_TASK_COLUMNS);
    expect(MISSION_TASKS_WITH.with.workers.with.artifacts.columns).toBe(MISSION_ARTIFACT_COLUMNS);
  });

  it('page.tsx uses the shared shape for both mission reads and inlines no heavy column', () => {
    expect(PAGE.split('with: MISSION_DETAIL_WITH').length - 1).toBe(2);
    expect(PAGE).not.toMatch(/\bcontent:\s*true/);
    expect(PAGE).not.toMatch(/\bresult:\s*true/);
    expect(PAGE).not.toMatch(/\bcontext:\s*true/);
  });

  it('the digest SQL never selects the whole column', () => {
    const r = dialect.sqlToQuery(RESULT_DIGEST_SQL);
    const c = dialect.sqlToQuery(CONTEXT_DIGEST_SQL);
    expect(r.sql).toContain('jsonb_build_object');
    // Every reference to the column is a `->` key access or the null test —
    // never the bare value.
    const bare = (q: string, col: string) =>
      q.split(col).slice(1).filter(rest => !rest.startsWith('->') && !rest.startsWith(' is null')).length;
    expect(bare(r.sql, '"tasks"."result"')).toBe(0);
    expect(bare(c.sql, '"tasks"."context"')).toBe(0);
    expect(r.sql.split('"tasks"."result"->').length - 1).toBeGreaterThan(3);
    // The keys are this module's constants, bound as text.
    expect(r.params).toContain('structuredOutput');
    expect(r.params).toContain('reaperAutoCompleted');
    expect(c.params).toContain('failureContext');
    expect(c.params).toContain('errorType');
    expect(c.params).toContain('driftDiagnosis');
    expect(Object.keys(TASK_DIGEST_SELECTION).sort()).toEqual(['context', 'id', 'result']);
  });
});

// docs/design/visual-qa-auditor.md, "Where the screenshots show": audit
// shots need their own query. The nested with-tree keeps five artifacts per
// worker, which would silently cut a 40-shot run to five.
describe('visual review shots query', () => {
  it('is scoped to this mission, to screenshots, and to rows carrying metadata.qa', () => {
    const q = dialect.sqlToQuery(missionVisualShotsWhere('mission-1'));
    const text = q.sql.replace(/\s+/g, ' ');
    expect(text).toMatch(/"artifacts"\."mission_id" = \$\d+/);
    expect(text).toMatch(/"artifacts"\."type" = \$\d+/);
    expect(text).toContain(`jsonb_typeof("artifacts"."metadata" -> 'qa') = 'object'`);
    expect(q.params).toEqual(['mission-1', 'screenshot', 'mission-1', 'visual-auditor']);
    // AND, not OR: every clause must hold.
    expect(text).not.toContain(' or ');
  });

  // Evidence is the auditor's alone: a screenshot another worker on the
  // mission writes with a hand-made metadata.qa must not become the run.
  it('counts only shots written by a visual-auditor worker on this mission', () => {
    const q = dialect.sqlToQuery(missionVisualShotsWhere('mission-1'));
    const text = q.sql.replace(/\s+/g, ' ');
    expect(text).toMatch(
      /"artifacts"\."worker_id" in \(select "w"\."id" from "workers" "w" inner join "tasks" "t" on "t"\."id" = "w"\."task_id" where "t"\."mission_id" = \$3 and "t"\."role_slug" = \$4\)/,
    );
    expect(q.params[3]).toBe('visual-auditor');
  });

  // The relational query (`db.query.artifacts.findMany({ where })`) re-aliases
  // EVERY column in a raw `where` to the queried table. A subquery written with
  // workers/tasks column objects became `select "artifacts"."id" from "workers"
  // … "artifacts"."task_id"` and failed on every mission page render.
  it('survives the relational query aliasing its where to the artifacts table', () => {
    const aliased = mapColumnsInSQLToAlias(missionVisualShotsWhere('mission-1'), 'artifacts');
    const text = dialect.sqlToQuery(aliased).sql.replace(/\s+/g, ' ');
    expect(text).not.toContain('"artifacts"."task_id"');
    expect(text).not.toContain('"artifacts"."role_slug"');
    expect(text).toMatch(/"artifacts"\."worker_id" in \(select /);
  });

  it('selects no content, carries the worker, and holds up to three 40-shot runs', () => {
    expect(Object.keys(MISSION_VISUAL_SHOT_COLUMNS).sort()).toEqual(['createdAt', 'id', 'metadata', 'type', 'workerId']);
    expect(MISSION_VISUAL_SHOTS_LIMIT).toBeGreaterThanOrEqual(120);
  });

  // With a limit, the order decides which runs survive: ascending would keep
  // the OLDEST 120 and silently cut the newest run.
  it('orders newest first', () => {
    const [order] = MISSION_VISUAL_SHOTS_ORDER(artifacts, { desc, asc });
    const text = dialect.sqlToQuery(order as SQL).sql;
    expect(text).toBe('"artifacts"."created_at" desc');
  });

  it('page.tsx reads the shots through the dedicated query and helper', () => {
    expect(PAGE).toContain('missionVisualShotsWhere(');
    expect(PAGE).toContain('limit: MISSION_VISUAL_SHOTS_LIMIT');
    expect(PAGE).toContain('orderBy: MISSION_VISUAL_SHOTS_ORDER');
    expect(PAGE).toContain('missionVisualReview(');
  });
});

// ── Digest sufficiency ──────────────────────────────────────────────────────
// Illustrative fixtures only.

const bulky = 'x'.repeat(10_000);

describe('digestTaskResult', () => {
  it('keeps only what the page reads', () => {
    expect(digestTaskResult({
      summary: 'Done', summarySource: 'agent', output: bulky, files: [bulky],
      structuredOutput: { status: 'ok', summary: 'Nominal', details: bulky },
    })).toEqual({ summary: 'Done', summarySource: 'agent', structuredOutput: { status: 'ok', summary: 'Nominal' } });
  });

  it('null stays null; an object with nothing readable is empty', () => {
    expect(digestTaskResult(null)).toBeNull();
    expect(digestTaskResult({ output: bulky })).toEqual({});
  });

  it('completion summary and heartbeat status read the same from the digest', () => {
    const base = { title: 'Evaluate mission completion: example', status: 'completed', mode: 'planning', taskClass: 'bookkeeping', createdAt: new Date('2026-01-02') };
    const full = [
      { ...base, id: 'eval', result: { summary: 'Mission delivered its goal.', output: bulky } },
      { ...base, id: 'reaped', title: 'Evaluate mission completion: older', createdAt: new Date('2026-01-01'), result: { summary: 'Stale', reaperAutoCompleted: true } },
      { ...base, id: 'hb', title: 'Heartbeat', result: { structuredOutput: { status: 'action_taken', trace: bulky } } },
    ];
    const slim = full.map(t => ({ ...t, result: digestTaskResult(t.result) }));
    expect(selectMissionCompletionSummary({ tasks: slim, completionNote: null }))
      .toEqual(selectMissionCompletionSummary({ tasks: full, completionNote: null }));
    const hb = (ts: typeof full) => getHeartbeatStatus(ts.filter(t => t.id !== 'eval'));
    expect(hb(slim as typeof full)).toEqual(hb(full));
    expect(hb(slim as typeof full).lastStatus).toBe('action_taken');
  });
});

describe('digestTaskContext', () => {
  it('keeps the attempt-strip keys and failureContext.errorType only', () => {
    expect(digestTaskContext({
      iteration: 2, maxIterations: 3, prompt: bulky, failureContext: { errorType: 'test_failure', log: bulky },
    })).toEqual({ iteration: 2, maxIterations: 3, failureContext: { errorType: 'test_failure' } });
  });

  it('attempt strips are identical over full context and digest', () => {
    const row = (id: string, over: Record<string, unknown>) => ({
      id, status: 'completed', taskClass: 'attempt', parentTaskId: 'p', roleSlug: 'builder',
      creationSource: 'webhook', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
      ciRetryPrNumber: null, reviewerRetryPrNumber: null, conflictRetryPrNumber: null, ...over,
    });
    const full = [
      row('p', { taskClass: 'work', parentTaskId: null }),
      row('ci', { ciRetryPrNumber: 41, context: { iteration: 1, maxIterations: 3, failureContext: { errorType: 'lint', log: bulky }, ciRunUrl: 'https://example.test/run/1' } }),
      row('drift', { ciRetryPrNumber: 41, context: { driftDiagnosis: true, prompt: bulky } }),
      row('cf', { conflictRetryPrNumber: 41, context: { conflictIteration: 2, maxConflictIterations: 4, prUrl: 'https://example.test/pr/41' } }),
      row('rv', { reviewerRetryPrNumber: 41, context: { iteration: 1, cycleNumber: 3, scheduleName: 'Nightly', prNumber: 41 } }),
    ];
    const slim = full.map(t => ({ ...t, context: digestTaskContext((t as { context?: unknown }).context) }));
    const ctx = { repoFullName: 'example/repo', roleNameBySlug: new Map([['builder', 'Builder']]) };
    const a = buildAttemptStrips(full as never, ctx);
    const b = buildAttemptStrips(slim as never, ctx);
    expect([...b.entries()]).toEqual([...a.entries()]);
    expect(a.get('p')?.total).toBe(3);
  });
});

describe('digestTaskContext and the Visual review coverage', () => {
  // The page shows n/m coverage from auditRequiredRoutes, which reads the
  // round-2 planner's frozen context.visualQa.requiredRoutes.
  it('keeps context.visualQa, so required routes read the same from the digest', async () => {
    const { auditRequiredRoutes } = await import('@/lib/visual-qa-required-routes');
    const context = { surfaceAuditRound: 2, visualQa: { requiredRoutes: ['/app/tasks'] }, prompt: bulky };
    const deps = [['apps/web/src/app/app/(protected)/missions/[id]/page.tsx']];
    expect(auditRequiredRoutes({ context: digestTaskContext(context) }, deps))
      .toEqual(auditRequiredRoutes({ context }, deps));
    expect(auditRequiredRoutes({ context: digestTaskContext(context) }, deps)).toContain('/app/tasks');
  });
});

describe('indexTaskDigests', () => {
  it('maps id → digest with nulls preserved', () => {
    const m = indexTaskDigests([{ id: 'a', result: { summary: 's' }, context: null }]);
    expect(m.get('a')).toEqual({ result: { summary: 's' }, context: null });
  });
});
