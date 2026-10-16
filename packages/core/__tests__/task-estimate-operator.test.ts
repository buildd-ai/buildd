import { describe, it, expect } from 'bun:test';
import {
  buildOperatorEstimatesReport, gateForVersion, gateScore, OPERATOR_MIN_SCORED_FOR_RATE,
  type OperatorEstimateRow, type OperatorReportInput,
} from '../task-estimate-operator';
import { computeTaskEstimateReadout } from '../task-estimate-accuracy';
import { scoreRows } from '../estimate-backtest';
import type { TaskEstimatesRolloutPin } from '../task-estimate-rollout';

const OWN = 'team-own';
const OTHER = 'team-other';
const PIN: TaskEstimatesRolloutPin = { verdict: 'no_go', estimatorVersion: 'v1', measuredOn: '2026-10-09', readoutRef: 'artifact x', failing: ['prior_only', 'cold_start'] };

let n = 0;
const row = (o: Partial<OperatorEstimateRow> = {}): OperatorEstimateRow => ({
  taskId: `t${n++}`, teamId: OWN, workspaceId: 'ws-own', estimatorVersion: 'v1', createdAt: new Date('2026-10-10T12:00:00Z'),
  p50Minutes: 20, p80Minutes: 40, p50Tokens: 100, p80Tokens: 200, expectedRepairs: 0,
  explanation: { sources: [{ source: 'neighbours', n: 4, weight: 1 }], clusterLabel: 'apps/web' },
  kind: 'engineering', complexity: 'normal', taskClass: 'work', taskStatus: 'completed',
  actuals: { minutes: 30, tokens: 150, repairs: 0 }, priorCompleted: 12,
  ...o,
});
const many = (k: number, o: Partial<OperatorEstimateRow> = {}) => Array.from({ length: k }, () => row(o));

const input = (rows: OperatorEstimateRow[], o: Partial<OperatorReportInput> = {}): OperatorReportInput => ({
  rows, truncated: false, rowLimit: 5000, detailTeamIds: new Set([OWN]),
  counts: { workTasks: 0, estimatedByVersion: {}, written: rows.length },
  pin: PIN, runningVersion: 'v1',
  ...o,
});

describe('buildOperatorEstimatesReport: live', () => {
  it('scores each version on its own, never pooled', () => {
    const v1 = many(12, { actuals: { minutes: 30, tokens: 150, repairs: 0 } });
    const v2 = many(12, { estimatorVersion: 'v2', actuals: { minutes: 90, tokens: 150, repairs: 0 } });
    const r = buildOperatorEstimatesReport(input([...v1, ...v2]));
    expect(r.live.map(l => l.estimatorVersion)).toEqual(['v1', 'v2']);
    expect(r.live[0].running).toBe(true);
    expect(r.live[0].overall.medianRatio).toBe(1.5);
    expect(r.live[1].overall.medianRatio).toBe(4.5);
    expect(r.live[1].overall.withinP80).toBe(0);
  });

  it('is the shared scorer: overall equals computeTaskEstimateReadout on the eligible rows', () => {
    const rows = many(15).map((r, i) => ({ ...r, actuals: { minutes: 5 + i * 4, tokens: 100, repairs: 0 } }));
    const r = buildOperatorEstimatesReport(input(rows));
    const direct = scoreRows(rows.map(x => ({ p50: x.p50Minutes, p80: x.p80Minutes, actual: x.actuals!.minutes })));
    expect(r.live[0].overall).toMatchObject({ n: direct.n, scored: direct.scored, withinP80: direct.withinP80, medianRatio: direct.medianRatio, sufficient: true });
  });

  it('withholds rates under the sample bar and keeps the n', () => {
    const r = buildOperatorEstimatesReport(input(many(OPERATOR_MIN_SCORED_FOR_RATE - 1)));
    expect(r.live[0].overall).toEqual({ n: 9, scored: 9, sufficient: false, withinP80: null, medianRatio: null, medianAbsLogError: null });
    const r10 = buildOperatorEstimatesReport(input(many(OPERATOR_MIN_SCORED_FOR_RATE)));
    expect(r10.live[0].overall.sufficient).toBe(true);
    expect(r10.live[0].overall.withinP80).toBe(1);
  });

  it('a slice under the bar shows n and no rate even when the whole version is sufficient', () => {
    const rows = [...many(12), ...many(3, { kind: 'research' })];
    const k = buildOperatorEstimatesReport(input(rows)).live[0].byKind;
    expect(k.find(g => g.key === 'engineering')!.score.sufficient).toBe(true);
    expect(k.find(g => g.key === 'research')!.score).toMatchObject({ n: 3, sufficient: false, withinP80: null });
  });

  it('counts what is not scored, with the reason', () => {
    const rows = [
      ...many(2, { actuals: null, priorCompleted: null, taskStatus: 'in_progress' }),
      row({ actuals: null, priorCompleted: null, taskStatus: 'failed' }),
      row({ taskClass: 'attempt' }),
      row({ actuals: { minutes: 0, tokens: 0, repairs: 0 } }),
      row(),
    ];
    const l = buildOperatorEstimatesReport(input(rows)).live[0];
    expect(l.estimates).toBe(6);
    expect(l.eligible).toBe(2);
    expect(l.overall.scored).toBe(1);
    expect(l.excluded).toEqual({ open: 2, ended_without_actuals: 1, non_work: 1, no_usable_actual: 1 });
  });

  it('with no rows the running version reads zero and unknown, not a clean result', () => {
    const r = buildOperatorEstimatesReport(input([]));
    expect(r.live).toHaveLength(1);
    expect(r.live[0]).toMatchObject({ estimatorVersion: 'v1', estimates: 0, eligible: 0, repairs: null });
    expect(r.live[0].overall).toMatchObject({ n: 0, sufficient: false, withinP80: null, medianRatio: null });
  });

  it('a version filter narrows live to that version and still lists every gate', () => {
    const r = buildOperatorEstimatesReport(input([...many(2), ...many(2, { estimatorVersion: 'v2' })], { estimatorVersion: 'v2' }));
    expect(r.live.map(l => l.estimatorVersion)).toEqual(['v2']);
    expect(r.backtest.map(b => b.estimatorVersion)).toEqual(['v1', 'v2']);
  });

  it('slices by complexity, history band, team, workspace and day', () => {
    const rows = [
      ...many(3, { complexity: null, priorCompleted: 0, createdAt: new Date('2026-10-09T23:00:00Z') }),
      ...many(2, { teamId: OTHER, workspaceId: 'ws-other', priorCompleted: 60 }),
    ];
    const l = buildOperatorEstimatesReport(input(rows)).live[0];
    expect(l.byComplexity.map(g => g.key).sort()).toEqual(['normal', 'unknown']);
    expect(l.byHistory.find(h => h.key === '0')!.score.n).toBe(3);
    expect(l.byHistory.find(h => h.key === '50+')!.score.n).toBe(2);
    expect(l.byTeam.map(g => [g.key, g.score.n])).toEqual([[OWN, 3], [OTHER, 2]]);
    expect(l.byWorkspace.map(g => g.key)).toEqual(['ws-own', 'ws-other']);
    expect(l.byDay.map(g => g.key)).toEqual(['2026-10-09', '2026-10-10']);
  });

  it('area labels come only from detail teams; other teams still count elsewhere', () => {
    const rows = [...many(2), ...many(4, { teamId: OTHER, workspaceId: 'ws-other', explanation: { sources: [], clusterLabel: 'secret/path' } })];
    const l = buildOperatorEstimatesReport(input(rows)).live[0];
    expect(l.overall.n).toBe(6);
    expect(l.byCluster.map(g => g.key)).toEqual(['apps/web']);
    expect(JSON.stringify(l)).not.toContain('secret/path');
    expect(buildOperatorEstimatesReport(input(rows, { detailTeamIds: new Set() })).live[0].byCluster).toEqual([]);
  });

  it('gateScore never invents a rate the scorer did not have', () => {
    expect(gateScore(computeTaskEstimateReadout([]).overall)).toMatchObject({ withinP80: null, sufficient: false });
  });
});

describe('backtest gate', () => {
  it('reads the pinned verdict for the measured version, check by check', () => {
    const g = gateForVersion('v1', PIN, 'v1');
    expect(g).toMatchObject({ verdict: 'no_go', measuredOn: '2026-10-09', evidenceRef: 'artifact x', failing: ['prior_only', 'cold_start'], defaultOn: false, running: true });
    expect(g.checks.map(c => [c.id, c.run, c.result])).toEqual([
      ['blend_better', 'recent', 'passed'],
      ['neighbours', 'recent', 'passed'],
      ['prior_only', 'recent', 'failed'],
      ['cold_start', 'held_out', 'failed'],
    ]);
    expect(g.checks.find(c => c.id === 'cold_start')!.bar).toMatchObject({ minScored: 30, withinP80: 0.7 });
    // The figures live in the evidence artifact, not the repo: n is unknown, not 0.
    expect(g.checks.every(c => c.n === null)).toBe(true);
  });

  it('a version the pin did not measure reads unknown on every check', () => {
    const g = gateForVersion('v2', PIN, 'v2');
    expect(g).toMatchObject({ verdict: 'unknown', measuredOn: null, evidenceRef: null, failing: [], defaultOn: false });
    expect(g.checks.every(c => c.result === 'unknown')).toBe(true);
  });

  it('defaultOn only when the go pin is for the running version', () => {
    const go = { ...PIN, verdict: 'go' as const, failing: [] };
    expect(gateForVersion('v1', go, 'v1').defaultOn).toBe(true);
    expect(gateForVersion('v1', go, 'v2').defaultOn).toBe(false);
  });

  it('live and backtest stay apart: no live figure sits under a check', () => {
    const r = buildOperatorEstimatesReport(input(many(40, { actuals: { minutes: 500, tokens: 1, repairs: 0 } })));
    expect(r.backtest.find(b => b.estimatorVersion === 'v1')!.checks.find(c => c.id === 'neighbours')!.result).toBe('passed');
    for (const b of r.backtest) for (const c of b.checks) expect(Object.keys(c).sort()).toEqual(['bar', 'id', 'n', 'result', 'run']);
  });

  it('lists the running, pinned and observed versions', () => {
    const r = buildOperatorEstimatesReport(input(many(1, { estimatorVersion: 'v0' }), { runningVersion: 'v2' }));
    expect(r.backtest.map(b => [b.estimatorVersion, b.verdict])).toEqual([['v2', 'unknown'], ['v0', 'unknown'], ['v1', 'no_go']]);
  });
});

describe('coverage and runtime', () => {
  it('coverage is per version over work tasks; no work tasks reads null, not 0%', () => {
    const r = buildOperatorEstimatesReport(input([], { counts: { workTasks: 8, estimatedByVersion: { v1: 6 }, written: 6 } }));
    expect(r.coverage).toEqual({ workTasks: 8, byVersion: [{ estimatorVersion: 'v1', estimated: 6, share: 0.75 }] });
    const empty = buildOperatorEstimatesReport(input([], { counts: { workTasks: 0, estimatedByVersion: {}, written: 0 } }));
    expect(empty.coverage.byVersion[0]).toEqual({ estimatorVersion: 'v1', estimated: 0, share: null });
  });

  it('write failures and duration read not instrumented, never 0', () => {
    const r = buildOperatorEstimatesReport(input([], { counts: { workTasks: 0, estimatedByVersion: {}, written: 3 } }));
    expect(r.runtime).toEqual({
      written: 3,
      skipped: { status: 'not_instrumented' },
      failed: { status: 'not_instrumented' },
      writeDurationMs: { status: 'not_instrumented' },
    });
  });

  it('carries the cap and schema version', () => {
    const r = buildOperatorEstimatesReport(input([], { truncated: true, rowLimit: 10 }));
    expect(r).toMatchObject({ schemaVersion: 1, truncated: true, rowLimit: 10, runningVersion: 'v1', minScoredForRate: 10 });
  });
});
