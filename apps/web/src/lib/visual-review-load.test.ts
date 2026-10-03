/**
 * The visual review loader (docs/design/visual-qa-human-review.md, "Read").
 *
 * The db here builds every query with drizzle's real QueryBuilder and renders
 * it through PgDialect before handing back fixture rows, so the WHERE scoping
 * is asserted on the SQL Postgres would receive. A plain mocked db would make
 * every predicate unobservable. Illustrative ids only.
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';

type Rendered = { sql: string; params: unknown[] };
const rendered: Rendered[] = [];
let rowsFor: (r: Rendered) => unknown[] = () => [];

function wrap(builder: any): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'then') {
        const q = target.toSQL() as Rendered;
        rendered.push(q);
        const rows = rowsFor(q);
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows).then(res, rej);
      }
      const v = target[prop];
      return typeof v === 'function' ? (...args: unknown[]) => wrap(v.apply(target, args)) : v;
    },
  });
}

const qb = new QueryBuilder();
mock.module('@buildd/core/db', () => ({
  db: { select: (...args: unknown[]) => wrap((qb.select as any)(...args)) },
}));

const heartbeats = mock(async () => null as any);
mock.module('@/lib/runner-heartbeats', () => ({ loadBrowserRunnerHeartbeats: heartbeats }));

const { loadVisualReview, loadMissionVisualShotRows, loadWorkspaceAwaitingReview } = await import('./visual-review-load');

const MISSION = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-03-10T12:00:00.000Z');

const from = (r: Rendered) => /from "([a-z_]+)"/.exec(r.sql)?.[1];

beforeEach(() => {
  rendered.length = 0;
  rowsFor = () => [];
  heartbeats.mockReset();
  heartbeats.mockResolvedValue(null);
});

describe('shot query scoping (rendered SQL)', () => {
  it('limits shots to this mission, screenshots with a qa object, written by its visual-auditor workers', async () => {
    await loadMissionVisualShotRows(MISSION);
    const shots = rendered.find(r => from(r) === 'artifacts')!;
    expect(shots.sql).toContain('"artifacts"."mission_id" = $');
    expect(shots.sql).toContain('"artifacts"."type" = $');
    expect(shots.sql).toContain(`jsonb_typeof("artifacts"."metadata" -> 'qa') = 'object'`);
    expect(shots.sql).toContain('"artifacts"."worker_id" in (select "w"."id" from "workers" "w" inner join "tasks" "t" on "t"."id" = "w"."task_id" where "t"."mission_id" = $');
    expect(shots.sql).toContain('and "t"."role_slug" = $');
    expect(shots.params).toContain(MISSION);
    expect(shots.params).toContain('visual-auditor');
    expect(shots.params).toContain('screenshot');
    // The worker's task comes with the row, so a shot's round never depends on a worker limit.
    expect(shots.sql).toContain('left join "workers" on "workers"."id" = "artifacts"."worker_id"');
    expect(shots.sql).toContain('order by "artifacts"."created_at" desc');
  });
});

describe('loadVisualReview', () => {
  const auditId = '33333333-3333-4333-8333-333333333333';
  const shotRow = {
    id: '44444444-4444-4444-8444-444444444444',
    workerId: 'w1',
    title: null,
    type: 'screenshot',
    createdAt: new Date('2026-03-10T10:05:00.000Z'),
    taskId: auditId,
    metadata: { qa: { runKey: 'r', route: '/app/tasks', viewport: 'mobile', verdict: 'unsure', finding: 'Two headings.' } },
  };

  it('scopes every read to the mission and joins reviews and fix tasks into the model', async () => {
    rowsFor = (r) => {
      switch (from(r)) {
        case 'artifacts': return [shotRow];
        case 'tasks': return [
          { id: auditId, title: '[surface audit] M', status: 'completed', roleSlug: 'visual-auditor', dependsOn: [], pathManifest: null, createdAt: new Date('2026-03-10T10:00:00.000Z'), updatedAt: new Date('2026-03-10T10:10:00.000Z'), context: { surfaceAuditRound: null, visualQa: { requiredRoutes: ['/app/tasks'] } }, errorType: null },
          { id: 'fx1', title: '[surface fix] /app/tasks: Two headings.', status: 'in_progress', roleSlug: 'builder', dependsOn: [], pathManifest: null, createdAt: new Date('2026-03-10T10:20:00.000Z'), updatedAt: new Date('2026-03-10T10:20:00.000Z'), context: null, errorType: null },
        ];
        case 'workers': return [
          { id: 'w1', taskId: auditId, status: 'completed', startedAt: new Date('2026-03-10T10:01:00.000Z'), waitingFor: null, prUrl: null, prNumber: null, mergedAt: null },
          { id: 'wf', taskId: 'fx1', status: 'running', startedAt: new Date('2026-03-10T10:21:00.000Z'), waitingFor: null, prUrl: 'https://example.test/pr/9', prNumber: 9, mergedAt: null },
        ];
        case 'visual_shot_reviews': return [{
          id: 'rv1', missionId: MISSION, workspaceId: WS, artifactId: shotRow.id, auditTaskId: auditId, round: 1,
          cellKey: '/app/tasks|mobile|', route: '/app/tasks', viewport: 'mobile', agentVerdict: 'unsure',
          decision: 'needs_fix', relation: 'dispute', note: null, fixTaskId: 'fx1', cancelledFixTaskId: null,
          reviewerUserId: null, reviewerLabel: 'someone', supersededAt: null, createdAt: new Date('2026-03-10T10:19:00.000Z'),
        }];
        default: return [];
      }
    };
    const model = await loadVisualReview({ id: MISSION, workspaceId: WS }, { now: NOW });

    for (const table of ['artifacts', 'tasks', 'workers', 'visual_shot_reviews', 'mission_notes']) {
      const q = rendered.find(r => from(r) === table);
      expect(q, table).toBeDefined();
      expect(q!.params, table).toContain(MISSION);
    }
    expect(rendered.find(r => from(r) === 'tasks')!.sql).toContain('where "tasks"."mission_id" = $');
    expect(rendered.find(r => from(r) === 'visual_shot_reviews')!.sql).toContain('where "visual_shot_reviews"."mission_id" = $');
    expect(rendered.find(r => from(r) === 'workers')!.sql).toContain(`"t"."mission_id" = $`);

    expect(model.missionId).toBe(MISSION);
    expect(model.cells).toHaveLength(1);
    const cell = model.cells[0];
    expect(cell.current.review).toMatchObject({ id: 'rv1', decision: 'needs_fix', createdAt: '2026-03-10T10:19:00.000Z', supersededAt: null });
    expect(cell.current.fixTask).toMatchObject({ id: 'fx1', status: 'in_progress', prUrl: 'https://example.test/pr/9', prNumber: 9, mergedAt: null, origin: 'human' });
    expect(cell.effectiveVerdict).toBe('issue');
    expect(model.summary).toMatchObject({ shots: 1, required: 2, covered: 1, openFixes: 1 });
    expect(model.phase).toBe('fixing');
    // Nothing is pending, so no heartbeat read.
    expect(heartbeats).not.toHaveBeenCalled();
  });

  it('reads heartbeats only for a claimable audit pending past the window, and reports no_browser_runner', async () => {
    rowsFor = (r) => {
      if (from(r) === 'tasks') return [{ id: 'a1', title: '[surface audit] M', status: 'pending', roleSlug: 'visual-auditor', dependsOn: [], pathManifest: null, createdAt: new Date('2026-03-10T11:00:00.000Z'), updatedAt: new Date('2026-03-10T11:00:00.000Z'), context: {}, errorType: null }];
      if (from(r) === 'workspaces') return [{ id: WS, teamId: 'team-1', accessMode: 'open' }];
      return [];
    };
    heartbeats.mockResolvedValue([{ lastHeartbeatAt: new Date(NOW - 10_000), environment: { envKeys: ['node'] }, workspaceIds: [WS] }]);
    const model = await loadVisualReview({ id: MISSION, workspaceId: WS }, { now: NOW });
    expect(heartbeats).toHaveBeenCalledTimes(1);
    expect(model.phase).toBe('no_browser_runner');

    heartbeats.mockResolvedValue(null);
    expect((await loadVisualReview({ id: MISSION, workspaceId: WS }, { now: NOW })).phase).toBe('queued');
  });

  it("reads the mission's capture ref and keeps a wrong-ref shot out of the deck as a capture gap", async () => {
    const BRANCH = 'mission/settings-abcd1234';
    rowsFor = (r) => {
      if (from(r) === 'artifacts') return [{ ...shotRow, metadata: { qa: { ...shotRow.metadata.qa, ref: 'dev', refSource: 'trunk' } } }];
      if (from(r) === 'tasks') return [{ id: auditId, title: '[surface audit] M', status: 'completed', roleSlug: 'visual-auditor', dependsOn: [], pathManifest: null, createdAt: new Date(0), updatedAt: new Date(0), context: {}, errorType: null }];
      if (from(r) === 'missions') return [{ workingBranch: BRANCH, integrationBranchEnabled: true, gitConfig: { defaultBranch: 'dev' } }];
      return [];
    };
    const model = await loadVisualReview({ id: MISSION, workspaceId: WS }, { now: NOW });
    const q = rendered.find(r => from(r) === 'missions')!;
    expect(q.sql).toContain('left join "workspaces" on "workspaces"."id" = "missions"."workspace_id"');
    expect(q.params).toContain(MISSION);
    expect(model.cells).toEqual([]);
    expect(model.summary.awaitingHuman).toBe(0);
    expect(model.captureGaps).toMatchObject([{ shotId: shotRow.id, ref: 'dev', expectedRef: BRANCH }]);
    expect(model.phase).not.toBe('needs_you');
  });

  it('marks the round-cap question open when the note exists', async () => {
    rowsFor = (r) => {
      if (from(r) === 'artifacts') return [{ ...shotRow, metadata: { qa: { ...shotRow.metadata.qa, verdict: 'issue' } } }];
      if (from(r) === 'tasks') return [{ id: auditId, title: '[surface audit] M', status: 'completed', roleSlug: 'visual-auditor', dependsOn: [], pathManifest: null, createdAt: new Date(0), updatedAt: new Date(0), context: {}, errorType: null }];
      if (from(r) === 'mission_notes') return [{ id: 'n1' }];
      return [];
    };
    const model = await loadVisualReview({ id: MISSION, workspaceId: WS }, { now: NOW });
    expect(model.roundCapOpen).toBe(true);
    expect(model.phase).toBe('needs_you');
    const note = rendered.find(r => from(r) === 'mission_notes')!;
    expect(note.sql).toContain('"mission_notes"."status" = $');
    expect(note.params).toContain('open');
  });
});

describe('loadWorkspaceAwaitingReview', () => {
  const M2 = '55555555-5555-4555-8555-555555555555';
  const M3 = '66666666-6666-4666-8666-666666666666';
  const audit = (missionId: string) => ({ id: `a-${missionId}`, title: '[surface audit] M', status: 'completed', roleSlug: 'visual-auditor', dependsOn: [], pathManifest: null, createdAt: new Date(0), updatedAt: new Date(0), context: {}, errorType: null });
  const shot = (missionId: string, verdict: string) => ({ id: `s-${missionId}`, workerId: 'w1', title: null, type: 'screenshot', createdAt: new Date('2026-03-10T10:05:00.000Z'), taskId: `a-${missionId}`, metadata: { qa: { runKey: 'r', route: '/app/x', viewport: 'mobile', verdict, finding: 'f' } } });

  it('counts each candidate from its own model, keeps a round-cap decision, drops ones a later round already cleared', async () => {
    rowsFor = (r) => {
      if (from(r) === 'missions') return [
        { id: MISSION, title: 'First', status: 'active', workspaceId: WS },
        { id: M2, title: 'Second', status: 'completed', workspaceId: WS },
        { id: M3, title: 'Third', status: 'active', workspaceId: WS },
      ];
      if (from(r) === 'mission_notes') return r.params.includes(M3) ? [{ id: 'note' }] : [];
      const mission = r.params.includes(MISSION) ? MISSION : r.params.includes(M2) ? M2 : r.params.includes(M3) ? M3 : null;
      if (!mission) return [];
      if (from(r) === 'artifacts') return [shot(mission, mission === MISSION ? 'unsure' : mission === M3 ? 'issue' : 'ok')];
      if (from(r) === 'tasks') return [audit(mission)];
      return [];
    };
    const out = await loadWorkspaceAwaitingReview(WS, ['team-a'], { now: NOW });
    expect(out).toEqual({ missions: [
      { id: MISSION, title: 'First', status: 'active', phase: 'needs_you', reason: 'unsure', awaitingHuman: 1 },
      { id: M3, title: 'Third', status: 'active', phase: 'needs_you', reason: 'round_cap', awaitingHuman: 0 },
    ], more: false });
    const cand = rendered.find(r => from(r) === 'missions')!;
    expect(cand.params).toContain(WS);
    expect(cand.params).toContain('team-a');
  });

  it('reads nothing without a team', async () => {
    expect(await loadWorkspaceAwaitingReview(WS, [])).toEqual({ missions: [], more: false });
    expect(rendered).toHaveLength(0);
  });
});
