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
    const h = derivePendingTaskHold({ now: NOW, deferral: { reason: 'workspace_cap' } });
    expect(h.kind).toBe('hold');
    expect(h.holdKey).toBe('workspace_cap');
    expect(h.cause).toBe('every agent slot in the workspace is in use');
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
