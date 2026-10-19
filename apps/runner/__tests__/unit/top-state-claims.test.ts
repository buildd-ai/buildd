/**
 * `buildd top` says what really holds a waiting task (spec c7410e76 R-25,
 * AC-11): the reason the server gave the runner's last claim of that task, or
 * of its last broad claim, in words. "Ready, next claim picks it up" only when
 * the last claim saw nothing holding it. A provider limit holding all of that
 * provider's work is said once, as a header hold. R-27: an asking agent is not
 * promoted.
 */
import { describe, expect, test } from 'bun:test';
import {
  NO_MISSION, eventChangesQueue, localLiftTime, providerHolds, reduce, taskRows, waitingReason, type ClaimOutcome,
} from '../../src/top/state';
import { NOW, TASKS, fixtureState } from './top-fixture';

const loose = () => TASKS.find(t => t.id === 't-loose')!;
const withOutcome = (o: Partial<ClaimOutcome>, taskId = 't-loose', s = fixtureState()) =>
  reduce(s, { type: 'claim_outcome', taskId, outcome: { at: NOW - 5_000, reason: 'no_pending_tasks', ...o } });
const reset = new Date(NOW + 9 * 3_600_000).toISOString();

describe('waiting reasons from the last claim (R-25)', () => {
  test('every exclusion the server names reads in words, never as ready', () => {
    const inTwoHours = new Date(NOW + 2 * 3_600_000).toISOString();
    const cases: Array<[Partial<ClaimOutcome>, string | RegExp]> = [
      [{ exclusion: 'runner_cooldown' }, 'cooldown, 1 min'],
      [{ exclusion: 'mission_local' }, 'your session'],
      [{ exclusion: 'mission_held' }, 'mission is paused'],
      [{ exclusion: 'task_held' }, 'paused by a person'],
      [{ exclusion: 'budget_paused' }, 'usage limit'],
      [{ exclusion: 'task_reserved' }, 'taken by your session'],
      [{ exclusion: 'already_claimed' }, 'another runner has it'],
      [{ exclusion: 'active_worker' }, 'another runner has it'],
      [{ exclusion: 'workspace_cap' }, 'workspace is at its task limit'],
      [{ exclusion: 'mission_concurrent' }, 'mission is at its task limit'],
      [{ exclusion: 'mission_paced' }, 'mission is paced'],
      [{ exclusion: 'codex_single_flight' }, 'one Codex run per workspace at a time'],
      [{ exclusion: 'path_overlap' }, 'waits for work on the same files'],
      [{ exclusion: 'role_mismatch' }, 'needs a role this runner lacks'],
      [{ exclusion: 'workspace_paused', until: inTwoHours }, `workspace paused until ${localLiftTime(inTwoHours, NOW)}`],
      [{ exclusion: 'deferred', until: inTwoHours }, 'starts in 2h'],
      [{ exclusion: 'deps_blocked' }, 'waits on a dependency'],
      [{ reason: 'race_lost' }, 'another runner took it'],
      [{ reason: 'context_paused', until: new Date(NOW + 5 * 60_000).toISOString() }, 'paused after repeated failures, 5m'],
      [{ reason: 'refused', status: 409, refusal: 'path overlap with another task' }, 'refused: path overlap with another task'],
      [{ reason: 'budget_exhausted', exclusion: 'budget_paused', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: reset }] }, /^plan limit/],
      [{ reason: 'budget_exhausted', exclusion: 'budget_paused', walls: [{ kind: 'provider_pause', backend: 'claude', resetsAt: reset }] }, /^shared limit/],
      // Spec "A runner" R-12: this machine's own login, never a team-wide word.
      [{ reason: 'budget_exhausted', exclusion: 'budget_paused', walls: [{ kind: 'runner_seat', backend: 'claude', resetsAt: reset }] }, /^login limit/],
      [{ exclusion: 'some_future_gate', detail: 'A new gate said no. More words here.' }, 'A new gate said no'],
    ];
    for (const [o, want] of cases) {
      const got = waitingReason(loose(), withOutcome(o), NOW);
      if (typeof want === 'string') expect(got).toBe(want);
      else expect(got).toMatch(want);
      expect(got).not.toMatch(/ready/);
    }
  });

  test('a plan limit on one task names the local time it lifts', () => {
    const s = withOutcome({ reason: 'budget_exhausted', exclusion: 'budget_paused', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: reset }] });
    // Other pending Claude tasks have no outcome, so no header covers this one.
    expect(providerHolds(s, NOW)).toEqual([]);
    expect(waitingReason(loose(), s, NOW)).toBe(`plan limit, ${localLiftTime(reset, NOW)}`);
  });

  test('a dependency exclusion names the dependency by title when the list has it', () => {
    const s = withOutcome({ exclusion: 'deps_blocked' }, 't-top');
    expect(waitingReason(TASKS.find(t => t.id === 't-top')!, s, NOW)).toBe('waits on: name override');
  });

  test('ready only when the last claim saw nothing holding it', () => {
    expect(waitingReason(loose(), withOutcome({ reason: 'no_pending_tasks' }), NOW)).toBe('ready, next claim picks it up');
  });

  test('a stale outcome expires once the task moves, or its hold has passed', () => {
    // The task changed on the server after the claim was refused.
    let s = withOutcome({ exclusion: 'mission_local' });
    s = reduce(s, { type: 'tasks', tasks: TASKS });
    s = reduce(s, { type: 'tasks', tasks: TASKS.map(t => t.id === 't-loose' ? { ...t, updatedAt: new Date(NOW).toISOString() } : t) });
    expect(waitingReason(s.tasks.find(t => t.id === 't-loose')!, s, NOW)).toBe('not tried yet');
    expect(s.claimOutcomes.tasks['t-loose']).toBeUndefined();
    // A task no longer pending drops its outcome.
    s = withOutcome({ exclusion: 'mission_local' });
    s = reduce(s, { type: 'tasks', tasks: TASKS.map(t => t.id === 't-loose' ? { ...t, status: 'completed' } : t) });
    expect(s.claimOutcomes.tasks['t-loose']).toBeUndefined();
    // A cooldown is a minute long.
    s = withOutcome({ exclusion: 'runner_cooldown' });
    expect(waitingReason(loose(), s, NOW + 90_000)).toBe('not tried yet');
    // A wall that has lifted holds nothing.
    s = withOutcome({ reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: new Date(NOW - 1000).toISOString() }] });
    expect(waitingReason(loose(), s, NOW)).toBe('not tried yet');
    // A worker starting on it clears it.
    s = withOutcome({ exclusion: 'mission_local' });
    s = reduce(s, { type: 'worker_update', worker: { id: 'w9', taskId: 't-loose', taskTitle: 'fix flaky test', status: 'working', startedAt: NOW } });
    expect(s.claimOutcomes.tasks['t-loose']).toBeUndefined();
  });

  test("init carries the runner's outcomes so a fresh top starts with them", () => {
    const s = reduce(fixtureState(), { type: 'init', claimOutcomes: { tasks: { 't-loose': { at: NOW - 1000, reason: 'no_pending_tasks', exclusion: 'mission_local' } }, broad: null } });
    expect(waitingReason(loose(), s, NOW)).toBe('your session');
  });

  test('a claim outcome refetches the task list', () => {
    expect(eventChangesQueue(fixtureState(), { type: 'claim_outcome', outcome: { at: NOW, reason: 'race_lost' } })).toBe(true);
  });
});

describe('one provider limit, said once (R-25, AC-11)', () => {
  const walled = (s = fixtureState()) => reduce(s, {
    type: 'claim_outcome',
    outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: reset }] },
  });

  test('the broad claim held by the Claude limit: one header hold, short rows, no Claude task reads ready', () => {
    const s = walled();
    expect(providerHolds(s, NOW)).toEqual([{ backend: 'claude', provider: 'Claude', kind: 'account_seat', word: 'plan limit', resetsAt: reset }]);
    expect(waitingReason(loose(), s, NOW)).toBe('plan limit');
    for (const key of ['m-tui-0000-0000', 'm-spec-0000-0000', NO_MISSION]) {
      for (const r of taskRows({ ...s, selectedMission: key }, NOW)) {
        if (r.group === 'waiting') expect(r.reason).not.toMatch(/ready/);
      }
    }
  });

  test('every pending Claude task held on its own claim also makes one header hold', () => {
    let s = fixtureState();
    for (const id of ['t-top', 't-docs', 't-import', 't-loose']) {
      s = reduce(s, { type: 'claim_outcome', taskId: id, outcome: { at: NOW - 5_000, reason: 'budget_exhausted', exclusion: 'budget_paused', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: reset }] } });
    }
    expect(providerHolds(s, NOW).map(h => h.backend)).toEqual(['claude']);
    expect(waitingReason(loose(), s, NOW)).toBe('plan limit');
  });

  test('a Codex task is not held by the Claude limit', () => {
    const s = reduce(walled(), { type: 'tasks', tasks: TASKS.map(t => t.id === 't-loose' ? { ...t, backend: 'codex' } : t) });
    expect(waitingReason(s.tasks.find(t => t.id === 't-loose')!, s, NOW)).toBe('the server skipped it at the last claim');
  });

  test('the hold ends when its reset passes', () => {
    expect(providerHolds(walled(), NOW + 10 * 3_600_000)).toEqual([]);
  });

  test('a later broad claim that saw no wall clears the header', () => {
    const s = reduce(walled(), { type: 'claim_outcome', outcome: { at: NOW, reason: 'no_pending_tasks' } });
    expect(providerHolds(s, NOW)).toEqual([]);
  });

  test('the lift time is local: today as a clock time, another day with its weekday', () => {
    const today = new Date(2026, 2, 10, 18, 30).getTime();
    expect(localLiftTime(new Date(today).toISOString(), NOW)).toBe('18:30');
    const thu = new Date(2026, 2, 12, 0, 0).getTime();
    expect(localLiftTime(new Date(thu).toISOString(), NOW)).toBe('Thu 00:00');
  });
});

describe('a runner view, not an inbox (R-27)', () => {
  test('an asking agent shows its question in its own row, in its usual place, not promoted', () => {
    const running = taskRows(fixtureState(), NOW).filter(r => r.group === 'running');
    expect(running[0].kind).not.toBe('asking');
    expect(running.find(r => r.kind === 'asking')!.question).toBe('Print the URL or open the browser?');
  });
});

describe('what the last claim did not see (R-25, AC-11)', () => {
  const walledOutcome = { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: reset }] };
  const broad = (s: ReturnType<typeof fixtureState>, o: Partial<ClaimOutcome>) =>
    reduce(s, { type: 'claim_outcome', outcome: { at: NOW - 1_000, reason: 'no_pending_tasks', ...o } });

  test('a broad claim that takes some other task does not erase a Claude limit that has not lifted', () => {
    const s = broad(broad(fixtureState(), walledOutcome), { reason: 'claimed' });
    expect(providerHolds(s, NOW)).toEqual([{ backend: 'claude', provider: 'Claude', kind: 'account_seat', word: 'plan limit', resetsAt: reset }]);
    expect(waitingReason(loose(), s, NOW)).toBe('plan limit');
  });

  test('the kept limit still ends at its lift time', () => {
    const s = broad(broad(fixtureState(), walledOutcome), { reason: 'claimed' });
    expect(providerHolds(s, NOW + 10 * 3_600_000)).toEqual([]);
  });

  test('a task the last broad claim never offered is not called ready', () => {
    const s = broad(fixtureState(), { reason: 'no_pending_tasks' });
    expect(waitingReason(loose(), s, NOW)).toBe('the server skipped it at the last claim');
  });

  test('a task no claim has tried is not called ready', () => {
    expect(waitingReason(loose(), fixtureState(), NOW)).toBe('not tried yet');
  });

  test('a task newer than the last broad claim has not been tried yet', () => {
    const s0 = broad(fixtureState(), { reason: 'no_pending_tasks' });
    const s = reduce(s0, { type: 'tasks', tasks: TASKS.map(t => t.id === 't-loose' ? { ...t, updatedAt: new Date(NOW + 3_600_000).toISOString() } : t) });
    expect(waitingReason(s.tasks.find(t => t.id === 't-loose')!, s, NOW)).toBe('not tried yet');
  });

  test('deferral codes are said in words, never as the raw code', () => {
    for (const code of ['budget_paused', 'oauth_parallelism', 'duplicate_worker', 'sibling_retry_open', 'fix_not_needed', 'a_code_from_the_future']) {
      const s = broad(fixtureState(), { reason: 'all_candidates_deferred', deferrals: { [code]: 3 } });
      const got = waitingReason(loose(), s, NOW);
      expect(got).not.toContain('_');
      expect(got).not.toMatch(/budget paused|oauth parallelism|duplicate worker|sibling retry/);
    }
    const s = broad(fixtureState(), { reason: 'all_candidates_deferred', deferrals: { budget_paused: 3 } });
    expect(waitingReason(loose(), s, NOW)).toBe('skipped at the last claim (runner-wide): usage limit');
    const unknown = broad(fixtureState(), { reason: 'all_candidates_deferred', deferrals: { a_code_from_the_future: 2 } });
    expect(waitingReason(loose(), unknown, NOW)).toBe('skipped at the last claim (runner-wide): reason unknown');
  });

  test('a row keeps its own reason, and a mixed deferral is not pinned on a row it may not describe', () => {
    let s = broad(fixtureState(), { reason: 'all_candidates_deferred', deferrals: { budget_paused: 5, workspace_cap: 1 } });
    expect(waitingReason(loose(), s, NOW)).toBe('skipped at the last claim, for reasons it did not tie to this task');
    s = reduce(s, { type: 'claim_outcome', taskId: 't-loose', outcome: { at: NOW - 500, reason: 'no_pending_tasks', exclusion: 'mission_local' } });
    expect(waitingReason(loose(), s, NOW)).toBe('your session');
  });

  test('a server clock ahead of this machine does not drop a fresh outcome', () => {
    const ahead = new Date(NOW + 3_600_000).toISOString();
    let s = reduce(fixtureState(), { type: 'tasks', tasks: TASKS.map(t => t.id === 't-loose' ? { ...t, updatedAt: ahead } : t) });
    s = withOutcome({ exclusion: 'mission_local' }, 't-loose', s);
    s = reduce(s, { type: 'tasks', tasks: s.tasks });
    expect(waitingReason(s.tasks.find(t => t.id === 't-loose')!, s, NOW)).toBe('your session');
    // A later change on the server still retires it.
    s = reduce(s, { type: 'tasks', tasks: s.tasks.map(t => t.id === 't-loose' ? { ...t, updatedAt: new Date(NOW + 7_200_000).toISOString() } : t) });
    expect(s.claimOutcomes.tasks['t-loose']).toBeUndefined();
  });
});
