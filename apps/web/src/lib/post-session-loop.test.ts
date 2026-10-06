import { describe, expect, it } from 'bun:test';
import { POST_SESSION_POLICY_VERSION } from '@buildd/core/post-session-quality';
import type { PostSessionSweepSummary } from './post-session-run';
import type { RecordTriagedSummary } from './post-session-findings';
import { runPostSessionQualityLoop } from './post-session-loop';

const NOW = new Date('2026-10-04T12:00:00Z');

function sweepSummary(over: Partial<PostSessionSweepSummary> = {}): PostSessionSweepSummary {
  return {
    candidates: 4, collected: 3, duplicate: 0, failed: 1, skipped: 0, errors: 0, deferred: 0,
    triaged: 3, selected: 2, hardTriggered: 1, triageUnavailable: 0, triageErrors: 1, triageDeferred: 0,
    triageCost: { calls: 3, usd: 0.0003, inputTokens: 300, outputTokens: 9 },
    ...over,
  };
}

function recordSummary(over: Partial<RecordTriagedSummary> = {}): RecordTriagedSummary {
  return {
    candidates: 2, recorded: 2, notReady: 0, analyseErrors: 0, recordErrors: 1, deferred: 0,
    actionable: 2, tasksFiled: 1, proposalsFiled: 1, deduped: 0, wouldAct: 0, duplicatesSuppressed: 1, transcriptUnread: 1,
    ...over,
  };
}

describe('runPostSessionQualityLoop', () => {
  it('runs collect+triage, then analyse+act, and folds both into one readout', async () => {
    const order: string[] = [];
    const readout = await runPostSessionQualityLoop({
      now: NOW,
      env: {},
      sweep: async () => { order.push('sweep'); return sweepSummary(); },
      record: async () => { order.push('record'); return recordSummary(); },
    });
    expect(order).toEqual(['sweep', 'record']);
    expect(readout).toMatchObject({
      enabled: true,
      policyVersion: POST_SESSION_POLICY_VERSION,
      evaluated: 3,
      triaged: 3,
      hardTriggered: 1,
      selectedForAnalysis: 2,
      analysed: 2,
      actionable: 2,
      tasksCreated: 1,
      proposalsCreated: 1,
      duplicatesSuppressed: 1,
      stageFailures: { collect: 1, triage: 1, transcript: 1, analyse: 0, act: 1 },
      stageCost: {
        triage: { calls: 3, usd: 0.0003, inputTokens: 300, outputTokens: 9 },
        analyse: { calls: 0, usd: 0 },
      },
    });
  });

  it('shares one time budget across both stages', async () => {
    let t = 0;
    const seen: boolean[] = [];
    await runPostSessionQualityLoop({
      now: NOW,
      env: {},
      budgetMs: 1000,
      clock: () => t,
      sweep: async ({ shouldContinue }) => { seen.push(shouldContinue()); t = 1500; seen.push(shouldContinue()); return sweepSummary(); },
      record: async ({ shouldContinue }) => { seen.push(shouldContinue()); return recordSummary(); },
    });
    expect(seen).toEqual([true, false, false]);
  });

  it('a stage that throws is contained: the other stage still runs and the failure is counted', async () => {
    const readout = await runPostSessionQualityLoop({
      now: NOW,
      env: {},
      sweep: async () => { throw new Error('boom'); },
      record: async () => recordSummary({ recordErrors: 0 }),
    });
    expect(readout.analysed).toBe(2);
    expect(readout.stageFailures.collect).toBe(1);
    expect(readout.stageErrors).toEqual(['sweep: boom']);

    const r2 = await runPostSessionQualityLoop({
      now: NOW,
      env: {},
      sweep: async () => sweepSummary({ failed: 0, triageErrors: 0 }),
      record: async () => { throw new Error('kaput'); },
    });
    expect(r2.evaluated).toBe(3);
    expect(r2.stageFailures.act).toBe(1);
    expect(r2.stageErrors).toEqual(['record: kaput']);
  });

  it('the deploy-wide kill switch turns the whole loop off', async () => {
    let called = false;
    const readout = await runPostSessionQualityLoop({
      now: NOW,
      env: { POST_SESSION_QUALITY_ENABLED: '0' },
      sweep: async () => { called = true; return sweepSummary(); },
      record: async () => { called = true; return recordSummary(); },
    });
    expect(called).toBe(false);
    expect(readout).toMatchObject({ enabled: false, evaluated: 0, analysed: 0 });
  });
});
