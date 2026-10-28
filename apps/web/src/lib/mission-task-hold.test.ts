/**
 * Navigation R-14 / AC-14: a queued task names why it is held, in a fixed
 * order, and only reads "next in line for a runner" when nothing holds it.
 * The 14f6a2b1 case: ten `path_overlap` deferrals behind another task's PR
 * read "Ready: next in line for a runner" on every surface.
 */
import { describe, expect, it } from 'bun:test';
import { derivePendingTaskHold, holderNote, whenLabel, type PendingHolderFacts } from './mission-task-hold';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const H = 60 * 60 * 1000;
const D = 24 * H;

const holder = (over: Partial<PendingHolderFacts> = {}): PendingHolderFacts => ({
  id: 'holder-1', title: 'approve a spec from chat or MCP', status: 'in_progress', ...over,
});

describe('derivePendingTaskHold', () => {
  it('nothing recorded: next in line for a runner, aged from creation', () => {
    const h = derivePendingTaskHold({ now: NOW, createdAt: new Date(NOW - 2 * H) });
    expect(h.kind).toBe('next_in_line');
    expect(h.word).toBe('Queued');
    expect(h.cause).toBe('next in line for a runner');
    expect(h.ageLabel).toBe('2h');
    expect(h.row).toBe('Queued 2h · next in line for a runner');
    expect(h.holder).toBeNull();
  });

  it('a runner pin names the runner it waits for, not a missing capability', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'runner_capability', detail: { pinnedRunner: 'build-host' } } });
    expect(h.kind).toBe('no_runner');
    expect(h.cause).toBe('waiting for runner build-host');
    expect(h.cause).not.toContain('no online runner has what it needs');
  });

  it('regression 14f6a2b1: path_overlap deferrals behind a task read held, never next in line', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      createdAt: new Date(NOW - 5 * H),
      deferral: {
        reason: 'path_overlap',
        firstDeferredAt: new Date(NOW - 2 * H).toISOString(),
        detail: { blockingTaskId: 'holder-1', prNumber: 5434, consecutiveDeferrals: 10, paths: ['apps/web/src/lib/specs/store.ts', 'packages/core/db/schema.ts'] },
      },
      holders: new Map([['holder-1', holder()]]),
    });
    expect(h.kind).toBe('overlap');
    expect(h.cause).toBe('held: runs after approve a spec from chat or MCP');
    expect(h.row).toBe('Queued 2h · held: runs after approve a spec from chat or MCP');
    expect(h.row).not.toContain('next in line');
    expect(h.row).not.toContain('holder-1');
    expect(h.holder).toEqual({ id: 'holder-1', title: 'approve a spec from chat or MCP', note: null });
    expect(h.holdKey).toBe('path_overlap');
    // Time in state counts from the streak's first deferral, not creation.
    expect(h.ageLabel).toBe('2h');
  });

  it('a serial lane wait names the lane and how many go first (spec: Overlap scheduling, I-3, AC-10)', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      deferral: { reason: 'path_overlap', detail: { lane: 'migration', position: 2, laneVerdict: 'held', blockingTaskId: 'holder-1', prNumber: 5434 } },
      holders: new Map([['holder-1', holder()]]),
    });
    expect(h.kind).toBe('overlap');
    expect(h.cause).toBe('in line for the migration lane, 2 ahead: runs after approve a spec from chat or MCP');
    expect(h.row).not.toContain('next in line');
    const unknown = derivePendingTaskHold({ now: NOW, deferral: { reason: 'path_overlap', detail: { lane: 'surface:hotspot:a.ts', position: 1, prNumber: 7 } } });
    expect(unknown.cause).toBe('in line for the hotspot:a.ts lane, 1 ahead: runs after #7');
    const stuck = derivePendingTaskHold({ now: NOW, deferral: { reason: 'path_overlap', detail: { lane: 'migration', position: 1, prNumber: 7, holderQuietSince: new Date(NOW - 30 * H).toISOString() } } });
    expect(stuck.cause).toBe("in line for the migration lane, 1 ahead: runs after #7; the lane is stuck: its holder's PR has been quiet 1d 6h");
  });

  it('an overlap whose holder row is unknown names the PR, never an id', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'path_overlap', detail: { prNumber: 5434 } } });
    expect(h.kind).toBe('overlap');
    expect(h.cause).toBe('held: runs after #5434');
  });

  it('an overlap with neither holder nor PR still reads held, with no name to give', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'soft_overlap', detail: {} } });
    expect(h.kind).toBe('overlap');
    expect(h.cause).toBe('held: runs after another task on the same files');
  });

  it('a dependency not merged outranks an overlap: Waiting on <task>', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      createdAt: new Date(NOW - 3 * D),
      dependencies: [holder({ id: 'dep-1', title: 'Mirror the runner image to Docker Hub', status: 'completed', merged: false })],
      deferral: { reason: 'path_overlap', detail: { blockingTaskId: 'holder-1' } },
      holders: new Map([['holder-1', holder()]]),
    });
    expect(h.kind).toBe('dependency');
    expect(h.word).toBe('Waiting on Mirror the runner image to Docker Hub');
    expect(h.cause).toBeNull();
    expect(h.row).toBe('Waiting on Mirror the runner image to Docker Hub 3d');
    expect(h.holder?.id).toBe('dep-1');
  });

  it('several unmet dependencies: the first is named, the rest counted', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      dependencies: [holder({ id: 'd1', title: 'First' }), holder({ id: 'd2', title: 'Second' }), holder({ id: 'd3', title: 'Third' })],
    });
    expect(h.word).toBe('Waiting on First and 2 more');
  });

  it('no eligible runner: isolation, capability, credential', () => {
    const iso = derivePendingTaskHold({ now: NOW, deferral: { reason: 'isolation_unenforced', detail: { requirement: 'docker' } } });
    expect(iso.kind).toBe('no_runner');
    expect(iso.cause).toBe('no runner can take it: needs docker isolation');
    const cap = derivePendingTaskHold({ now: NOW, deferral: { reason: 'runner_capability', detail: { requiredVersion: '2.1.0' } } });
    expect(cap.cause).toBe('no runner can take it: needs Claude Code 2.1.0 or newer');
    const cred = derivePendingTaskHold({ now: NOW, deferral: { reason: 'no_personal_credential' } });
    expect(cred.cause).toBe('no runner can take it: it needs your own model key, which is not set');
  });

  it('no runner online, or no browser runner, is also "no runner can take it"', () => {
    const offline = derivePendingTaskHold({ now: NOW, runnerOnline: false });
    expect(offline.kind).toBe('no_runner');
    expect(offline.holdKey).toBe('runner_offline');
    expect(offline.cause).toBe('no runner can take it: none is online');
    const browser = derivePendingTaskHold({ now: NOW, missingBrowser: true });
    expect(browser.holdKey).toBe('browser_runner');
    expect(browser.cause).toBe('no runner can take it: it needs a runner with a browser');
  });

  it('a red trunk pauses merges', () => {
    const h = derivePendingTaskHold({ now: NOW, trunkRed: { branch: 'dev' } });
    expect(h.kind).toBe('trunk_red');
    expect(h.cause).toBe('merges paused: dev is red');
    // An overlap still outranks it.
    const both = derivePendingTaskHold({ now: NOW, trunkRed: { branch: 'dev' }, deferral: { reason: 'path_overlap', detail: { prNumber: 1 } } });
    expect(both.kind).toBe('overlap');
  });

  it('team daily budget: resumes at the wall reset', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      deferral: { reason: 'budget_paused', detail: { backend: 'claude', wall: 'daily', resetsAt: new Date(NOW + 3 * H + 5 * 60_000).toISOString() } },
    });
    expect(h.kind).toBe('budget');
    expect(h.cause).toBe('team daily budget reached, resumes in 3h 05m');
    const noTime = derivePendingTaskHold({ now: NOW, deferral: { reason: 'budget_paused' } });
    expect(noTime.cause).toBe('team daily budget reached');
    const provider = derivePendingTaskHold({ now: NOW, deferral: { reason: 'budget_paused', detail: { wall: 'provider_pause', backend: 'codex', resetsAt: new Date(NOW + H).toISOString() } } });
    expect(provider.cause).toBe('model provider rate limit reached, resumes in 1h 00m');
    const mission = derivePendingTaskHold({ now: NOW, deferral: { reason: 'mission_budget' } });
    expect(mission.kind).toBe('budget');
    expect(mission.cause).toBe("the mission's budget is spent");
  });

  it('a budget-exhausted requeue with a future start resumes then', () => {
    const h = derivePendingTaskHold({ now: NOW, budgetExhausted: true, startAt: new Date(NOW + 2 * H) });
    expect(h.kind).toBe('budget');
    expect(h.cause).toBe('team daily budget reached, resumes in 2h 00m');
  });

  it('a scheduled start or backoff: starts <time>', () => {
    const soon = derivePendingTaskHold({ now: NOW, startAt: new Date(NOW + 45 * 60_000) });
    expect(soon.kind).toBe('scheduled');
    expect(soon.cause).toBe('starts in 45m');
    const later = derivePendingTaskHold({ now: NOW, startAt: new Date('2026-10-24T09:00:00.000Z') });
    expect(later.cause).toBe('starts Oct 24');
    // A start already passed holds nothing.
    expect(derivePendingTaskHold({ now: NOW, startAt: new Date(NOW - 1000) }).kind).toBe('next_in_line');
  });

  it('a recorded hold the order does not rank keeps the gate wording', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'mission_concurrent' } });
    expect(h.kind).toBe('hold');
    expect(h.holdKey).toBe('mission_concurrent');
    expect(h.cause).toBe('the mission is already running as many tasks as it allows');
  });

  it('a reason with no wording invents no cause', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'some_future_gate' } });
    expect(h.kind).toBe('hold');
    expect(h.cause).toBeNull();
    expect(h.row).toBe('Queued');
  });

  describe('a dead holder is said out loud', () => {
    it('cancelled', () => {
      const h = derivePendingTaskHold({
        now: NOW,
        deferral: { reason: 'path_overlap', detail: { blockingTaskId: 'holder-1' } },
        holders: new Map([['holder-1', holder({ status: 'cancelled' })]]),
      });
      expect(h.cause).toBe('held: runs after approve a spec from chat or MCP (cancelled)');
      expect(h.holder?.note).toBe('cancelled');
    });
    it('completed and merged', () => {
      const h = derivePendingTaskHold({
        now: NOW,
        dependencies: [holder({ id: 'd', title: 'Schema', status: 'completed', merged: true })],
      });
      expect(h.word).toBe('Waiting on Schema (already merged)');
    });
    it('itself deferred to a future start', () => {
      const h = derivePendingTaskHold({
        now: NOW,
        dependencies: [holder({ id: 'd', title: 'Schema', status: 'pending', startAt: new Date('2026-10-24T08:00:00.000Z') })],
      });
      expect(h.word).toBe('Waiting on Schema (deferred until Oct 24)');
    });
    it('itself deferred by the claim gate for more than a day', () => {
      const h = derivePendingTaskHold({
        now: NOW,
        deferral: { reason: 'path_overlap', detail: { blockingTaskId: 'holder-1' } },
        holders: new Map([['holder-1', holder({ status: 'pending', firstDeferredAt: new Date(NOW - 3 * D).toISOString() })]]),
      });
      expect(h.cause).toBe('held: runs after approve a spec from chat or MCP (deferred for 3d)');
    });
    it('a holder deferred for less than a day is a live hold', () => {
      expect(holderNote(holder({ status: 'pending', firstDeferredAt: new Date(NOW - 2 * H).toISOString() }), NOW)).toBeNull();
    });
  });

  it('age is omitted when nothing dates the state', () => {
    const h = derivePendingTaskHold({ now: NOW });
    expect(h.ageLabel).toBeNull();
    expect(h.row).toBe('Queued · next in line for a runner');
  });
});

describe('whenLabel', () => {
  it('counts down inside a day and names the date past it', () => {
    expect(whenLabel(new Date(NOW + 90 * 60_000), NOW)).toBe('in 1h 30m');
    expect(whenLabel(new Date(NOW + 30_000), NOW)).toBe('in under 1m');
    expect(whenLabel(new Date('2026-10-25T00:00:00.000Z'), NOW)).toBe('Oct 25');
  });
});

/**
 * The live queue wait decides (spec: Overlap scheduling, AC-10): one reason
 * per kind, read from the claim route's own query and gates, and "next in
 * line" only for a slot wait. A stale or missing ledger row cannot make a
 * refused task read ready.
 */
describe('derivePendingTaskHold with the live queue wait', () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const TABLE: Array<{ name: string; wait: import('@buildd/shared').QueueWait; kind: string; cause: string | null; word?: string; holdKey: string }> = [
    { name: 'declared', wait: { kind: 'declared', blockerId: 'dep-1', blockerTitle: '“Add the index”', count: 1 }, kind: 'dependency', cause: null, word: 'Waiting on “Add the index”', holdKey: 'dependency' },
    { name: 'lane', wait: { kind: 'lane', lane: 'migration', position: 2, holderTaskId: 'h' }, kind: 'overlap', cause: 'in the schema lane, 2nd in line', holdKey: 'lane' },
    { name: 'limit: mission budget', wait: { kind: 'limit', limit: 'mission_budget', liftsAt: at(4 * 60_000) }, kind: 'budget', cause: 'mission budget, lifts in 4m', holdKey: 'mission_budget' },
    { name: 'limit: cap', wait: { kind: 'limit', limit: 'mission_cap' }, kind: 'hold', cause: 'mission limit', holdKey: 'mission_concurrent' },
    { name: 'limit: plan', wait: { kind: 'limit', limit: 'plan' }, kind: 'budget', cause: 'plan limit', holdKey: 'managed_runner_hours' },
    { name: 'limit: budget', wait: { kind: 'limit', limit: 'budget', liftsAt: at(2 * H) }, kind: 'budget', cause: 'daily budget, lifts in 2h 00m', holdKey: 'budget_paused' },
    { name: 'limit: seats', wait: { kind: 'limit', limit: 'seats' }, kind: 'hold', cause: 'seats in use', holdKey: 'account_slots' },
    { name: 'start time', wait: { kind: 'start_time', startAt: at(3 * H) }, kind: 'scheduled', cause: 'starts in 3h 00m', holdKey: 'scheduled' },
    { name: 'free slot', wait: { kind: 'slot', noRunnerReason: null }, kind: 'next_in_line', cause: 'next in line for a runner', holdKey: 'next_in_line' },
    { name: 'free slot, no runner', wait: { kind: 'slot', noRunnerReason: 'no online runner has what it needs' }, kind: 'no_runner', cause: 'no runner can take it: no online runner has what it needs', holdKey: 'runner_capability' },
  ];
  for (const row of TABLE) {
    it(row.name, () => {
      const h = derivePendingTaskHold({ now: NOW, wait: row.wait });
      expect(h.kind).toBe(row.kind as never);
      expect(h.cause).toBe(row.cause);
      if (row.word) expect(h.word).toBe(row.word);
      expect(h.holdKey).toBe(row.holdKey);
    });
  }

  it('2026-10-22: refused on path_overlap with no fresh ledger row still reads its lane, never next in line', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: null, wait: { kind: 'lane', lane: 'migration', position: 5, holderTaskId: 'holder-1' }, holders: new Map([['holder-1', holder()]]) });
    expect(h.kind).toBe('overlap');
    expect(h.cause).toBe('in the schema lane, 5th in line: runs after approve a spec from chat or MCP');
  });

  it('2026-10-22: a declared dependency on a running task the status read missed: waiting on it', () => {
    const h = derivePendingTaskHold({ now: NOW, dependencies: [], wait: { kind: 'declared', blockerId: 'run-1', blockerTitle: '“Rework claim order”', blockerStatus: 'in_progress', count: 1 } });
    expect(h.word).toBe('Waiting on “Rework claim order”');
    expect(h.kind).not.toBe('next_in_line');
  });

  it('a slot wait beats an old refusal: the claim query returns it now', () => {
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'path_overlap', detail: { blockingTaskId: 'holder-1' } }, wait: { kind: 'slot', noRunnerReason: null } });
    expect(h.kind).toBe('next_in_line');
  });

  it('a slot wait with no runner online still says so', () => {
    expect(derivePendingTaskHold({ now: NOW, runnerOnline: false, wait: { kind: 'slot', noRunnerReason: null } }).holdKey).toBe('runner_offline');
  });

  it('without a wait, a deps_blocked row once its dependencies are met reads no cause from it', () => {
    expect(derivePendingTaskHold({ now: NOW, deferral: { reason: 'deps_blocked' } }).kind).toBe('next_in_line');
  });
});

// Spec e28018c2 R-6: an upstream in another workspace is named per viewer.
describe('derivePendingTaskHold: a cross-workspace upstream', () => {
  it('a hidden upstream reads as a task in a workspace you can\'t see, with no note and nothing about it', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      dependencies: [{ id: 'up-a', hidden: true, title: null, status: 'failed', merged: false, startAt: new Date(NOW + 2 * D) }],
    });
    expect(h.kind).toBe('dependency');
    expect(h.word).toBe("Waiting on a task in a workspace you can't see");
    expect(h.holder).toEqual({ id: 'up-a', title: null, note: null, hidden: true });
    expect(h.row).not.toContain('failed');
    expect(h.row).not.toContain('up-a');
  });

  it('a hidden holder never shows a title even when a caller left one on the facts', () => {
    const h = derivePendingTaskHold({ now: NOW, dependencies: [{ id: 'up-a', hidden: true, title: 'Private plan', status: 'cancelled' }] });
    expect(h.word).toBe("Waiting on a task in a workspace you can't see");
    expect(JSON.stringify(h)).not.toContain('Private plan');
  });

  it('a visible upstream in another workspace is named with its workspace', () => {
    const h = derivePendingTaskHold({ now: NOW, dependencies: [holder({ workspaceName: 'Docs' })] });
    expect(h.word).toBe('Waiting on approve a spec from chat or MCP in Docs');
  });

  it('a hidden overlap holder is worded the same way', () => {
    const h = derivePendingTaskHold({
      now: NOW,
      deferral: { reason: 'path_overlap', detail: { blockingTaskId: 'up-a' } },
      holders: new Map([['up-a', { id: 'up-a', hidden: true, title: null, status: 'pending' }]]),
    });
    expect(h.cause).toBe("held: runs after a task in a workspace you can't see");
  });
});
