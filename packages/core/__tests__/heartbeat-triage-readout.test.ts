import { describe, it, expect, mock } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { computeHeartbeatTriageReadout, organizerActed, type OrganizerOutcome, type TriageLookRow } from '../heartbeat-triage-readout';

mock.module('../db/client', () => ({
  db: { select: (fields: any) => new QueryBuilder().select(fields) },
}));
const src = await import('../heartbeat-triage-readout-source');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

let t = 0;
const look = (missionId: string, arm: 'control' | 'treatment', over: Partial<TriageLookRow> = {}): TriageLookRow => ({
  missionId, arm, taskId: null, pick: 'act', confidence: 0.6, skipped: false, createdAt: new Date(1_000_000 + (t++) * 60_000), ...over,
});

describe('computeHeartbeatTriageReadout', () => {
  const outcomes = new Map<string, OrganizerOutcome>([
    ['c1', { acted: false, costUsd: 0.2 }], ['c2', { acted: true, costUsd: 0.3 }],
    ['t1', { acted: true, costUsd: 0.25 }], ['t2', { acted: false, costUsd: 0.1 }],
  ]);
  const looks = [
    // control: two dispatched cycles, the first a confident wait the organizer agreed with
    look('m-c', 'control', { taskId: 'c1', pick: 'wait', confidence: 0.95 }),
    look('m-c', 'control', { taskId: 'c2', pick: 'wait', confidence: 0.92 }),
    // treatment: a skip, then a dispatch that acted (a wrong wait), then a skip with no successor
    look('m-t', 'treatment', { skipped: true, pick: 'wait', confidence: 0.97 }),
    look('m-t', 'treatment', { taskId: 't1' }),
    look('m-t2', 'treatment', { taskId: 't2', pick: 'wait', confidence: 0.99 }),
    look('m-t2', 'treatment', { skipped: true, pick: 'wait', confidence: 0.97 }),
  ];
  const r = computeHeartbeatTriageReadout(looks, outcomes, { minSamplePerArm: 1, waitMinConfidence: 0.9 });

  it('counts dispatches per mission and organizer cost per arm', () => {
    expect(r.arms.control).toMatchObject({ missions: 1, cycles: 2, dispatched: 2, skipped: 0, dispatchesPerMission: 2 });
    expect(r.arms.control.organizerCostUsd).toBeCloseTo(0.5, 6);
    expect(r.arms.treatment).toMatchObject({ missions: 2, cycles: 4, dispatched: 2, skipped: 2, dispatchesPerMission: 1 });
  });

  it('flags a skip whose next organizer acted, ignoring skips with no successor yet', () => {
    expect(r.arms.treatment).toMatchObject({ skipsWithSuccessor: 1, actedAfterSkipRate: 1 });
  });

  it('grades confident waits against the organizer on the same state', () => {
    expect(r.arms.control).toMatchObject({ confidentWaitsDispatched: 2, confidentWaitPrecision: 0.5 });
    expect(r.arms.treatment).toMatchObject({ confidentWaitsDispatched: 1, confidentWaitPrecision: 1 });
  });

  it('says why it cannot conclude', () => {
    expect(computeHeartbeatTriageReadout([], new Map(), { minSamplePerArm: 5, waitMinConfidence: 0.9 }).status).toBe('no_scope');
    expect(computeHeartbeatTriageReadout(looks.slice(0, 2), outcomes, { minSamplePerArm: 5, waitMinConfidence: 0.9 }).status).toBe('no_baseline');
    expect(computeHeartbeatTriageReadout(looks, outcomes, { minSamplePerArm: 5, waitMinConfidence: 0.9 }).status).toBe('underpowered');
    expect(r.status).toBe('ready');
  });
});

describe('organizerActed', () => {
  it('reads rows, not the self-reported status', () => {
    expect(organizerActed({ childCount: 1, structuredOutput: { status: 'ok' } })).toBe(true);
    expect(organizerActed({ childCount: 0, structuredOutput: { tasksRetried: 1 } })).toBe(true);
    expect(organizerActed({ childCount: 0, structuredOutput: { missionComplete: true } })).toBe(true);
    expect(organizerActed({ childCount: 0, structuredOutput: { status: 'action_taken', actionCount: 3 } })).toBe(false);
    expect(organizerActed({ childCount: 0, structuredOutput: null })).toBe(false);
  });
});

describe('heartbeat triage readout queries', () => {
  const EXP = '5b0f6c1e-0000-4000-8000-00000000000c';
  it('looks: cohort = experiment AND policy_version, capped', () => {
    const q = src.buildTriageLooksQuery(EXP, 2).toSQL();
    expect(norm(q.sql)).toContain('from "heartbeat_triage_looks" where ("heartbeat_triage_looks"."experiment_id" = $1 and "heartbeat_triage_looks"."policy_version" = $2)');
    expect(q.params).toEqual([EXP, 2, src.HEARTBEAT_TRIAGE_READOUT_ROW_LIMIT]);
  });
  it('organizer tasks and cost: by task id with an IN list', () => {
    expect(norm(src.buildOrganizerTasksQuery(['a', 'b']).toSQL().sql)).toContain('where "tasks"."id" in ($1, $2)');
    const cost = norm(src.buildOrganizerCostQuery(['a']).toSQL().sql);
    expect(cost).toContain('where "workers"."task_id" in ($1)');
    expect(cost).toContain('group by "workers"."task_id"');
  });
});
