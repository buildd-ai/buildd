/**
 * Each recent-claim row on the local debug page says why in words, from the
 * claim log's reason, exclusion, walls and refusal; never a bare event name
 * (spec c7410e76 R-28, AC-13).
 */
import { describe, expect, test } from 'bun:test';
import { bannedWordsIn } from '@buildd/shared';
import { claimEntryWords } from '../../src/claim-words';
import { localLiftTime } from '../../src/top/state';

const NOW = Date.UTC(2026, 2, 10, 15, 0, 0);
const base = { ts: NOW - 1000, slotsRequested: 1, workersClaimed: 0 };

describe('claimEntryWords', () => {
  test('a plan limit names the provider and when it lifts', () => {
    const resetsAt = '2026-03-12T00:00:00.000Z';
    const w = claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt }] }, NOW);
    expect(w).toBe(`waiting: Claude plan limit until ${localLiftTime(resetsAt, NOW)}`);
  });

  test('a cooldown after a failure', () => {
    const w = claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'no_pending_tasks', taskExclusion: 'runner_cooldown' }, NOW);
    expect(w).toBe('waiting: cooldown after a failure');
  });

  test('a local-session mission', () => {
    const w = claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'no_pending_tasks', taskExclusion: 'mission_local' }, NOW);
    expect(w).toMatch(/^waiting: your session/);
  });

  test('a refusal says the status and the server reason, not claim_rejected', () => {
    const w = claimEntryWords({ ...base, event: 'claim_rejected', status: 429, reason: 'Too many sessions' }, NOW);
    expect(w).toBe('refused (429): Too many sessions');
  });

  test('a refusal with no HTTP response says the answer was lost', () => {
    const w = claimEntryWords({ ...base, event: 'claim_rejected', status: 0, reason: 'fetch failed' }, NOW);
    expect(w).toContain('no answer');
  });

  test('a diagnostic reason has words, and an unknown one never prints raw', () => {
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'race_lost' }, NOW)).toBe('another runner took it');
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'context_paused' }, NOW)).toBe('paused after repeated failures');
    const w = claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'brand_new_reason' as any }, NOW);
    expect(w).not.toContain('brand_new_reason');
    expect(w).not.toContain('claim_');
  });

  test('all candidates deferred names a single reason', () => {
    const w = claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'all_candidates_deferred', deferrals: { mission_concurrent: 3 } as any }, NOW);
    expect(w).toBe('waiting: mission is at its task limit');
  });

  test('a gate the server did not name reads reason unknown, never that the server held it', () => {
    expect(claimEntryWords({ ...base, event: 'claim_empty', taskExclusion: 'brand_new_gate' }, NOW)).toBe('Not started: reason unknown');
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'brand_new_reason' as any }, NOW)).toBe('Not started: reason unknown');
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'all_candidates_deferred', deferrals: { brand_new: 1 } as any }, NOW)).toBe('Not started: reason unknown');
  });

  test('usage limits, person and mission pauses, and a fully deferred claim use catalog words', () => {
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'budget_exhausted' }, NOW)).toBe('usage limit');
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'budget_exhausted_partial' }, NOW)).toBe('usage limit for one provider');
    expect(claimEntryWords({ ...base, event: 'claim_empty', taskExclusion: 'budget_paused' }, NOW)).toBe('usage limit');
    expect(claimEntryWords({ ...base, event: 'claim_empty', diagnosticReason: 'all_candidates_deferred' }, NOW)).toBe('nothing can start yet');
    expect(claimEntryWords({ ...base, event: 'claim_empty', taskExclusion: 'task_held' }, NOW)).toBe('waiting: paused by a person');
    expect(claimEntryWords({ ...base, event: 'claim_empty', taskExclusion: 'mission_held' }, NOW)).toBe('waiting: mission is paused');
  });

  test('no claim row uses a word the terms catalog bans', () => {
    const entries = [
      { event: 'claim_empty', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: null }] },
      { event: 'claim_empty', taskExclusion: 'runner_cooldown' },
      { event: 'claim_empty', taskExclusion: 'budget_paused' },
      { event: 'claim_empty', taskExclusion: 'task_held' },
      { event: 'claim_empty', taskExclusion: 'mission_held' },
      { event: 'claim_empty', taskExclusion: 'unknown_code' },
      { event: 'claim_empty', diagnosticReason: 'all_candidates_deferred' },
      { event: 'claim_empty', diagnosticReason: 'budget_exhausted' },
      { event: 'claim_empty', diagnosticReason: 'budget_exhausted_partial' },
      { event: 'claim_empty', diagnosticReason: 'nope' },
    ];
    for (const e of entries) expect(bannedWordsIn(claimEntryWords({ ...base, ...e } as any, NOW))).toEqual([]);
  });

  test('a success and an idle streak', () => {
    expect(claimEntryWords({ ...base, event: 'claim_success', workersClaimed: 1, taskId: 'abcdef12-0000' }, NOW)).toBe('claimed 1/1 (abcdef12)');
    expect(claimEntryWords({ ...base, event: 'claim_idle', idlePolls: 3, idleSince: NOW - 60_000 }, NOW)).toMatch(/^nothing waiting/);
  });

  test('no event ever comes back as its bare name', () => {
    for (const event of ['claim_attempt', 'claim_success', 'claim_empty', 'claim_rejected', 'claim_idle'] as const) {
      expect(claimEntryWords({ ...base, event }, NOW)).not.toMatch(/^claim_/);
    }
  });
});
