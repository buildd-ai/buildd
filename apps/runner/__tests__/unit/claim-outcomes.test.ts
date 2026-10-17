/**
 * The runner keeps what the server said about its last claim of each task, and
 * about its last broad claim, so `buildd top` can say what holds a waiting task
 * (spec c7410e76 R-25) instead of guessing "ready".
 */
import { describe, expect, test } from 'bun:test';
import { ClaimOutcomeStore, outcomeFromDiagnostics, outcomeFromRefusal } from '../../src/claim-outcomes';

const NOW = Date.UTC(2026, 2, 10, 15, 0, 0);

describe('outcomeFromDiagnostics', () => {
  test('keeps the structured walls, exclusion and lift time, not the prose alone', () => {
    const o = outcomeFromDiagnostics({
      reason: 'budget_exhausted',
      budgetBlock: { walls: [{ kind: 'provider_pause', backend: 'claude', resetsAt: '2026-03-11T00:00:00.000Z' }], summary: 'A run hit the Claude rate limit for this team.' },
      taskExclusion: { code: 'budget_paused', detail: 'Held by the Claude rate limit.' },
    } as any, NOW);
    expect(o).toEqual({
      at: NOW,
      reason: 'budget_exhausted',
      exclusion: 'budget_paused',
      detail: 'Held by the Claude rate limit.',
      walls: [{ kind: 'provider_pause', backend: 'claude', resetsAt: '2026-03-11T00:00:00.000Z' }],
      summary: 'A run hit the Claude rate limit for this team.',
    });
  });

  test('an exclusion with a structured end keeps it', () => {
    const o = outcomeFromDiagnostics({ reason: 'no_pending_tasks', taskExclusion: { code: 'workspace_paused', detail: 'x', until: '2026-03-10T17:00:00.000Z' } } as any, NOW);
    expect(o).toMatchObject({ reason: 'no_pending_tasks', exclusion: 'workspace_paused', until: '2026-03-10T17:00:00.000Z' });
  });

  test('deferral counts ride along on a deferred broad claim; missing diagnostics read as an empty queue', () => {
    expect(outcomeFromDiagnostics({ reason: 'all_candidates_deferred', deferrals: { mission_paced: 2, workspace_cap: 0 } } as any, NOW))
      .toEqual({ at: NOW, reason: 'all_candidates_deferred', deferrals: { mission_paced: 2 } });
    expect(outcomeFromDiagnostics(undefined, NOW)).toEqual({ at: NOW, reason: 'no_pending_tasks' });
  });

  test('an HTTP refusal keeps its status and text', () => {
    expect(outcomeFromRefusal(429, 'Too many workers', NOW)).toEqual({ at: NOW, reason: 'refused', status: 429, refusal: 'Too many workers' });
  });
});

// Spec c7410e76 R-26/AC-30: the Queue names what an overlap waits for.
describe('the task an overlap waits for', () => {
  const soft = 'Its declared scope overlaps in-flight task 0a1b2c3d-feed on apps/runner/src/a.ts, and the hold/start decision said HOLD. It starts when that task finishes or a START is decided. An admin can claim it anyway with claim_task force: true.';
  test('from the server\'s field', () => {
    const o = outcomeFromDiagnostics({ reason: 'all_candidates_deferred', taskExclusion: { code: 'soft_overlap', detail: soft, holderTaskId: 'beef-0001' } } as any, NOW);
    expect(o.holderTaskId).toBe('beef-0001');
  });
  test('from the sentence, on a server from before the field', () => {
    expect(outcomeFromDiagnostics({ reason: 'all_candidates_deferred', taskExclusion: { code: 'soft_overlap', detail: soft } } as any, NOW).holderTaskId).toBe('0a1b2c3d-feed');
    const path = 'Its files overlap an active claim held by task 9f8e7d6c-ab. An admin can claim it anyway with claim_task force: true.';
    expect(outcomeFromDiagnostics({ reason: 'all_candidates_deferred', taskExclusion: { code: 'path_overlap', detail: path } } as any, NOW).holderTaskId).toBe('9f8e7d6c-ab');
  });
  test('never from a word, an unknown holder, or another code', () => {
    const unknown = 'Its declared scope overlaps in-flight task (unknown), and the hold/start decision said HOLD. It starts when that task finishes or a START is decided.';
    expect(outcomeFromDiagnostics({ reason: 'all_candidates_deferred', taskExclusion: { code: 'soft_overlap', detail: unknown } } as any, NOW).holderTaskId).toBeUndefined();
    expect(outcomeFromDiagnostics({ reason: 'all_candidates_deferred', taskExclusion: { code: 'path_overlap', detail: 'Its files overlap open PR #12.' } } as any, NOW).holderTaskId).toBeUndefined();
    expect(outcomeFromDiagnostics({ reason: 'no_pending_tasks', taskExclusion: { code: 'mission_held', detail: soft } } as any, NOW).holderTaskId).toBeUndefined();
  });
});

describe('ClaimOutcomeStore', () => {
  test('keeps the latest per task and the latest broad, and forgets a task once claimed', () => {
    const store = new ClaimOutcomeStore();
    store.recordTask('t1', { at: NOW - 1000, reason: 'race_lost' });
    store.recordTask('t1', { at: NOW, reason: 'no_pending_tasks', exclusion: 'runner_cooldown' });
    store.recordTask('t2', { at: NOW, reason: 'no_pending_tasks', exclusion: 'mission_local' });
    store.recordBroad({ at: NOW, reason: 'all_candidates_deferred' });
    expect(store.snapshot(NOW).tasks.t1.exclusion).toBe('runner_cooldown');
    expect(store.snapshot(NOW).broad?.reason).toBe('all_candidates_deferred');
    store.clearTask('t1');
    expect(Object.keys(store.snapshot(NOW).tasks)).toEqual(['t2']);
  });

  test('old outcomes age out, and the store stays bounded', () => {
    const store = new ClaimOutcomeStore({ maxTasks: 3, maxAgeMs: 60_000 });
    store.recordTask('old', { at: NOW - 120_000, reason: 'race_lost' });
    for (const id of ['a', 'b', 'c', 'd']) store.recordTask(id, { at: NOW, reason: 'race_lost' });
    const snap = store.snapshot(NOW);
    expect(Object.keys(snap.tasks).sort()).toEqual(['b', 'c', 'd']);
  });

  test('an outcome whose lift time is still ahead outlives the age limit', () => {
    const store = new ClaimOutcomeStore({ maxAgeMs: 60_000 });
    store.recordTask('walled', { at: NOW - 3_600_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: new Date(NOW + 3_600_000).toISOString() }] });
    store.recordBroad({ at: NOW - 3_600_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: new Date(NOW + 3_600_000).toISOString() }] });
    const snap = store.snapshot(NOW);
    expect(snap.tasks.walled).toBeDefined();
    expect(snap.broad).not.toBeNull();
  });
});

describe('a broad claim keeps the provider limits that have not lifted', () => {
  const wall = { kind: 'account_seat', backend: 'claude', resetsAt: new Date(NOW + 3_600_000).toISOString() };
  test('a claim that took something does not erase them', () => {
    const store = new ClaimOutcomeStore();
    store.recordBroad({ at: NOW - 2000, reason: 'budget_exhausted', walls: [wall], summary: 'Claude plan limit' });
    store.recordBroad({ at: NOW - 1000, reason: 'claimed' });
    const broad = store.snapshot(NOW).broad!;
    expect(broad.reason).toBe('claimed');
    expect(broad.walls).toEqual([wall]);
  });
  test('an empty claim that names no wall means it lifted', () => {
    const store = new ClaimOutcomeStore();
    store.recordBroad({ at: NOW - 2000, reason: 'budget_exhausted', walls: [wall] });
    store.recordBroad({ at: NOW - 1000, reason: 'no_pending_tasks' });
    expect(store.snapshot(NOW).broad?.walls).toBeUndefined();
  });
  test('a lifted wall is not carried', () => {
    const store = new ClaimOutcomeStore();
    store.recordBroad({ at: NOW - 7_200_000, reason: 'budget_exhausted', walls: [{ ...wall, resetsAt: new Date(NOW - 3_600_000).toISOString() }] });
    store.recordBroad({ at: NOW, reason: 'claimed' });
    expect(store.snapshot(NOW).broad?.walls).toBeUndefined();
  });
  test('the stored outcome is returned so the frame sent to top carries the kept walls', () => {
    const store = new ClaimOutcomeStore();
    store.recordBroad({ at: NOW - 2000, reason: 'budget_exhausted', walls: [wall] });
    expect(store.recordBroad({ at: NOW, reason: 'claimed' }).walls).toEqual([wall]);
  });
});
