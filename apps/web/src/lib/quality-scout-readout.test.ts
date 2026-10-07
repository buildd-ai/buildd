import { describe, expect, it } from 'bun:test';
import type { ScoutRunMetrics } from '@buildd/core/quality-scout/types';
import { buildScoutReadout, type ScoutRunSummary } from './quality-scout-readout';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00Z');

function metrics(over: Partial<ScoutRunMetrics> = {}): ScoutRunMetrics {
  return {
    candidatesGenerated: 5,
    candidatesTruncated: 0,
    probesSelected: 3,
    probesRun: 3,
    probesNotExecuted: 0,
    decisionsAsked: 3,
    decisionFailures: 0,
    verdicts: { total: 3, pass: 1, fail: 1, inconclusive: 1, unsupported: 0 },
    stages: {
      profile: { ms: 1, costUsd: null },
      signals: { ms: 1, costUsd: null },
      generate: { ms: 1, costUsd: null },
      select: { ms: 1, costUsd: 0.01 },
      execute: { ms: 1, costUsd: null },
      act: { ms: 1, costUsd: null },
    },
    costUsd: 0.01,
    findings: { created: 1, recurred: 0, regressed: 0, resolved: 0, writeFailures: 0 },
    actionable: 1,
    actions: { filed: 1, updated: 0, proposed: 0, aggregated: 0, retained: 0, suppressed: 0, cancelled: 0, annotated: 0, dismissed: 0, noop: 0, failed: 0 },
    dedupeSuppressed: 0,
    exercised: { ref: 'main', sha: A },
    prior: null,
    headSha: A,
    staleness: 'fresh',
    deadlineHit: false,
    costCapHit: false,
    warnings: [],
    ...over,
  };
}

function run(over: Partial<ScoutRunSummary>): ScoutRunSummary {
  return {
    id: 'r1',
    trigger: 'periodic',
    mode: 'propose',
    status: 'completed',
    ref: 'main',
    sha: A,
    startedAt: '2026-10-05T10:00:00.000Z',
    completedAt: '2026-10-05T10:05:00.000Z',
    error: null,
    metrics: metrics(),
    ...over,
  };
}

describe('buildScoutReadout', () => {
  it('says what was last exercised on each ref and whether newer work made it stale', () => {
    const r = buildScoutReadout({
      workspaceId: 'ws',
      mode: 'propose',
      runs: [run({}), run({ id: 'r2', ref: 'mission/x', sha: B, startedAt: '2026-10-05T11:00:00.000Z', completedAt: '2026-10-05T11:02:00.000Z' })],
      probes: [],
      heads: { main: B, 'mission/x': B },
      findings: [],
      now: NOW,
    });
    const main = r.refs.find((x) => x.ref === 'main')!;
    expect(main).toMatchObject({ staleness: 'stale', headSha: B, sinceExercisedMs: 115 * 60_000 });
    expect(main.lastCompleted?.sha).toBe(A);
    expect(r.refs.find((x) => x.ref === 'mission/x')!.staleness).toBe('fresh');
  });

  it('a running or failed latest run does not hide the last completed one', () => {
    const r = buildScoutReadout({
      workspaceId: 'ws',
      mode: 'shadow',
      runs: [run({}), run({ id: 'r2', sha: B, status: 'failed', startedAt: '2026-10-05T11:00:00.000Z', metrics: null })],
      probes: [],
      heads: { main: B },
      findings: [],
      now: NOW,
    });
    expect(r.refs[0].lastRun.id).toBe('r2');
    expect(r.refs[0].lastCompleted?.id).toBe('r1');
    expect(r.totals).toMatchObject({ runs: 2, completed: 1, failed: 1 });
  });

  it('lists probe families whose newest judged SHA is behind the head; inconclusive does not count as exercised', () => {
    const r = buildScoutReadout({
      workspaceId: 'ws',
      mode: 'propose',
      runs: [run({}), run({ id: 'r2', sha: B, startedAt: '2026-10-05T11:00:00.000Z' })],
      probes: [
        { runId: 'r1', family: 'contract', verdict: 'fail' },
        { runId: 'r1', family: 'surface', verdict: 'pass' },
        { runId: 'r2', family: 'surface', verdict: 'pass' },
        { runId: 'r2', family: 'contract', verdict: 'inconclusive' },
      ],
      heads: { main: B },
      findings: [],
      now: NOW,
    });
    expect(r.refs[0].familiesExercised).toEqual({ contract: A, surface: B });
    expect(r.refs[0].staleFamilies).toEqual(['contract']);
  });

  it('unknown staleness when the head cannot be read', () => {
    const r = buildScoutReadout({ workspaceId: 'ws', mode: 'propose', runs: [run({})], probes: [], heads: { main: null }, findings: [], now: NOW });
    expect(r.refs[0].staleness).toBe('unknown');
    expect(r.refs[0].staleFamilies).toEqual([]);
  });

  it('totals new defects per run, actionable, dedupe suppression and cost; counts findings by severity and action', () => {
    const r = buildScoutReadout({
      workspaceId: 'ws',
      mode: 'propose',
      runs: [run({}), run({ id: 'r2', metrics: metrics({ findings: { created: 0, recurred: 1, regressed: 0, resolved: 0, writeFailures: 0 }, dedupeSuppressed: 1, costUsd: null }) })],
      probes: [],
      heads: { main: A },
      findings: [
        { severity: 'high', state: 'open', actionState: 'filed' },
        { severity: 'medium', state: 'open', actionState: 'aggregated' },
        { severity: 'low', state: 'resolved', actionState: 'retained' },
      ],
      now: NOW,
    });
    expect(r.totals).toMatchObject({ newDefects: 1, newDefectsPerRun: 0.5, actionable: 2, dedupeSuppressed: 1, costUsd: 0.01 });
    expect(r.findings).toMatchObject({ open: 2, resolved: 1, openBySeverity: { high: 1, medium: 1 }, openByAction: { filed: 1, aggregated: 1 } });
  });
});
