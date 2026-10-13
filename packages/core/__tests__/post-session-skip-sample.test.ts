import { describe, expect, it } from 'bun:test';
import {
  SKIP_SAMPLE_DEFAULT_DAILY_CAP,
  SKIP_SAMPLE_DEFAULT_RATE,
  isSampledSkip,
  markSampledSkip,
  resolveSkipSampleConfig,
  sampledSkipRate,
  triagedRunState,
  utcDayStart,
  type TriageOutcome,
} from '../post-session-triage';

const skip: TriageOutcome = {
  triage: { status: 'ok', decision: 'skip', focus: 'general', reasonCode: 'focus_general', confidence: 0.9, provenance: { rule: 'triage' } },
  hardTriggered: false,
  hardTriggerReasons: [],
  finalDecision: 'skip',
  rule: 'triage',
};

describe('skip sampling', () => {
  it('defaults to 3% and a daily cap; reads valid env overrides only', () => {
    expect(resolveSkipSampleConfig({})).toEqual({ rate: SKIP_SAMPLE_DEFAULT_RATE, dailyCap: SKIP_SAMPLE_DEFAULT_DAILY_CAP });
    expect(SKIP_SAMPLE_DEFAULT_RATE).toBe(0.03);
    expect(resolveSkipSampleConfig({ POST_SESSION_SKIP_SAMPLE_RATE: '0', POST_SESSION_SKIP_SAMPLE_DAILY_CAP: '5' })).toEqual({ rate: 0, dailyCap: 5 });
    expect(resolveSkipSampleConfig({ POST_SESSION_SKIP_SAMPLE_RATE: '2', POST_SESSION_SKIP_SAMPLE_DAILY_CAP: '-1' }))
      .toEqual({ rate: SKIP_SAMPLE_DEFAULT_RATE, dailyCap: SKIP_SAMPLE_DEFAULT_DAILY_CAP });
    expect(resolveSkipSampleConfig({ POST_SESSION_SKIP_SAMPLE_RATE: 'x', POST_SESSION_SKIP_SAMPLE_DAILY_CAP: ' ' }))
      .toEqual({ rate: SKIP_SAMPLE_DEFAULT_RATE, dailyCap: SKIP_SAMPLE_DEFAULT_DAILY_CAP });
  });

  it('a sampled skip stays a skip, carries its rate, and goes to analysis', () => {
    const s = markSampledSkip(skip, 0.03);
    expect(s.finalDecision).toBe('skip');
    expect(s.triage.provenance).toMatchObject({ rule: 'triage', sampled: true, sampleRate: 0.03 });
    expect(isSampledSkip(s.triage)).toBe(true);
    expect(sampledSkipRate(s.triage)).toBe(0.03);
    expect(triagedRunState(s)).toBe('triaged');
    // The input is not mutated.
    expect(isSampledSkip(skip.triage)).toBe(false);
  });

  it('only analyse or a sampled skip goes to analysis', () => {
    expect(triagedRunState(skip)).toBe('skipped');
    expect(triagedRunState({ ...skip, finalDecision: 'analyse' })).toBe('triaged');
    expect(isSampledSkip(null)).toBe(false);
    expect(sampledSkipRate(skip.triage)).toBeNull();
  });

  it('the cap window starts at UTC midnight', () => {
    expect(utcDayStart(new Date('2026-10-03T23:59:00-05:00')).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });
});
