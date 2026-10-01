import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The readout's stores. Predicates are rendered with the real dialect (a
 * mocked `db` would hide every WHERE); the link keys are pure.
 */

mock.module('../db/client', () => ({ db: {} }));

const src = await import('../orchestration-readout-source');
const dialect = new PgDialect();
const render = (w: any) => dialect.sqlToQuery(w);

const WS = '00000000-0000-4000-8000-0000000000a1';
const W = { workspaceId: WS, since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-02-01T00:00:00Z') };

describe('predicates are workspace-scoped', () => {
  it('claim rows: workspace, the claim capability, the window', () => {
    const q = render(src.claimReadoutRowsWhere(W));
    expect(q.sql).toContain('"orchestration_decisions"."workspace_id" = $1');
    expect(q.sql).toContain('"orchestration_decisions"."capability" = $2');
    expect(q.sql).toContain('"orchestration_decisions"."created_at" >= $3');
    expect(q.sql).toContain('"orchestration_decisions"."created_at" < $4');
    expect(q.params[0]).toBe(WS);
    expect(q.params[1]).toBe('orchestration_claim');
  });

  it('manifest pick rows: workspace, the manifest capability, the predicted tasks', () => {
    const q = render(src.manifestPickRowsWhere({ workspaceId: WS, taskIds: ['t1', 't2'] }));
    expect(q.sql).toContain('"orchestration_decisions"."workspace_id" = $1');
    expect(q.sql).toContain('"orchestration_decisions"."capability" = $2');
    expect(q.sql).toContain('"orchestration_decisions"."task_id" in ($3, $4)');
    expect(q.params[1]).toBe('orchestration_manifest');
  });

  it('predictions, link tasks and link workers are all workspace-scoped', () => {
    expect(render(src.readoutPredictionsWhere(W)).sql).toContain('"orchestration_manifest_predictions"."workspace_id" = $1');
    expect(render(src.linkTasksWhere({ workspaceId: WS, taskIds: ['t1'] })).sql).toContain('"tasks"."workspace_id" = $1');
    const w = render(src.linkWorkersWhere({ workspaceId: WS, taskIds: ['t1'] })).sql;
    expect(w).toContain('"workers"."workspace_id" = $1');
    expect(w).toContain('"workers"."pr_number" is not null');
  });
});

describe('taskLinkKeys', () => {
  const tasks = [
    { id: 'root', parentTaskId: null, missionId: 'm1', conflictRetryPrNumber: null, subjectPrNumber: null },
    { id: 'retry', parentTaskId: 'root', missionId: 'm1', conflictRetryPrNumber: 7, subjectPrNumber: null },
    { id: 'review', parentTaskId: null, missionId: null, conflictRetryPrNumber: null, subjectPrNumber: 7 },
    { id: 'loop-a', parentTaskId: 'loop-b', missionId: null, conflictRetryPrNumber: null, subjectPrNumber: null },
    { id: 'loop-b', parentTaskId: 'loop-a', missionId: null, conflictRetryPrNumber: null, subjectPrNumber: null },
  ];

  it('a retry shares its chain root; tasks on one PR share the PR key', () => {
    const k = src.taskLinkKeys({ taskIds: ['root', 'retry', 'review'], tasks, prs: [{ taskId: 'root', prNumber: 7 }], linkMissions: false });
    expect(k.get('root')).toEqual(['chain:root', 'pr:7']);
    expect(k.get('retry')).toEqual(['chain:root', 'pr:7']);
    expect(k.get('review')).toEqual(['chain:review', 'pr:7']);
  });

  it('mission links are optional', () => {
    const k = src.taskLinkKeys({ taskIds: ['retry'], tasks, prs: [], linkMissions: true });
    expect(k.get('retry')).toContain('mission:m1');
  });

  it('a parent cycle terminates', () => {
    const k = src.taskLinkKeys({ taskIds: ['loop-a'], tasks, prs: [], linkMissions: false });
    expect(k.get('loop-a')!.length).toBe(1);
  });
});
