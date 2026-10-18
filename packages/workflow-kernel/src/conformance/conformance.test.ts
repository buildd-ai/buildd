/**
 * Conformance on the pure core (docs/specs/workflow-kernel-library.md §2,
 * AC-6): the kernel driven through commands by the in-memory host, with no
 * database, no GitHub and no buildd import. Rows are named for the
 * docs/specs/workflow-state-kernel.md §16 matrix (S-numbers) and for the
 * incident sequences of the library spec (#4686, #4679). A rule the reducer
 * does not implement yet is a `test.todo` naming its acceptance criterion.
 */
import { describe, expect, test } from 'bun:test';
import type { Command, LivePr } from '../commands';
import { InMemoryKernel, memoryHost, type CommandResult, type DeliveryRef } from './harness';
import { ALL_CONFORMANCE_SCENARIOS as CONFORMANCE_SCENARIOS } from './all';
import { ConformanceFailure, type EpochHost } from './scenarios';
import type { EpochOp, EpochSnapshot } from '../delivery-epochs';

const REPO = 'acme/widgets';
const WS = 'w1';
const OWNER = 't1';
const live = (headSha: string, o: Partial<LivePr> = {}): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: REPO, baseRef: 'dev', ...o });
const mergedLive = (headSha: string): LivePr => live(headSha, { state: 'closed', merged: true, mergedAt: '2026-01-01T01:00:00.000Z', mergeCommitSha: 'M1' });

/** One delivery under test, with the moves a host makes on its behalf. */
class Scenario {
  readonly k = new InMemoryKernel();
  readonly ref: DeliveryRef = { workspaceId: WS, ownerTaskId: OWNER };
  private worker = 0;

  submit(cmd: Command): Promise<CommandResult> { return this.k.submit(cmd, this.ref); }
  get view() { return this.k.view(this.ref); }
  get d() { return this.view.delivery!; }
  get state() { return this.d.state; }
  get rounds() { return this.view.rounds; }
  get latestRound() { return this.rounds.at(-1)!; }
  effectKinds(): string[] { return this.k.effects(this.d.id).map((e) => e.kind); }

  async open(): Promise<this> {
    expectApplied(await this.k.submit({ type: 'DeliveryOpened', actor: 'runner', workspaceId: WS, ownerTaskId: OWNER, requiresPr: true }), 'WORKING');
    expectApplied(await this.submit({ type: 'PrBound', actor: 'runner', repoFullName: REPO, prNumber: 7, live: live('H1') }), 'WORKING');
    return this;
  }
  /** The owner attempt ends with its head on GitHub: the delivery goes to review. */
  ownerPushed(head = 'H1'): Promise<CommandResult> {
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: OWNER, outcome: 'success', localHeadSha: head, commitCount: 1, live: live(head) });
  }
  verdict(verdict: 'approve' | 'request_changes', roundId = this.latestRound.id, headBound = this.rounds.find((r) => r.id === roundId)!.headSha): Promise<CommandResult> {
    return this.submit({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId, verdict, effectiveVerdict: verdict, headBound });
  }
  /** T8 then T9: the fix is dispatched for the current round and claimed. Returns its attempt id. */
  async startFix(taskId = 'ft1'): Promise<string> {
    const head = this.d.currentHeadSha!;
    expectApplied(await this.submit({ type: 'FixDispatched', actor: 'kernel', roundId: this.latestRound.id, taskId, maxAttempts: 3, revalidation: { live: live(head), newerApprove: false } }), 'CHANGES_REQUESTED');
    const attempt = this.view.attempts.find((a) => a.family === 'review_fix' && a.status === 'queued')!;
    expectApplied(await this.submit({ type: 'FixClaimed', actor: 'runner', attemptId: attempt.id, revalidation: { live: live(head), approved: false } }), 'FIXING');
    return attempt.id;
  }
  push(head: string, o: Partial<Extract<Command, { type: 'HeadObserved' }>> = {}): Promise<CommandResult> {
    return this.submit({ type: 'HeadObserved', actor: 'webhook', live: live(head), ...o });
  }
  fixEnded(attemptId: string, o: Partial<Extract<Command, { type: 'AttemptEnded' }>>): Promise<CommandResult> {
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: 'ft1', attemptId, outcome: 'success', localHeadSha: null, commitCount: 0, live: live(this.d.currentHeadSha!), ...o });
  }
  land(head: string): Promise<CommandResult> {
    return this.submit({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: live(head), rails: { passed: true } });
  }
}

function expectApplied(r: CommandResult, toState: string): void {
  expect({ result: r.result, reason: 'reason' in r ? r.reason : undefined, to: r.result === 'applied' ? r.decision.toState : undefined })
    .toEqual({ result: 'applied', reason: undefined, to: toState as never });
}
function expectNotApplied(r: CommandResult, result: 'duplicate' | 'stale' | 'rejected', reason: string): void {
  expect({ result: r.result, reason: 'reason' in r ? r.reason : undefined }).toEqual({ result, reason });
}

describe('the shared conformance scenarios, on the in-memory store (AC-6; the same list runs on Postgres for AC-7)', () => {
  for (const sc of CONFORMANCE_SCENARIOS) {
    test(sc.name, async () => { await sc.run(memoryHost()); });
  }
});

describe('the in-memory host', () => {
  test('every applied transition bumps the version by one and is recorded once, at the clock', async () => {
    const s = await new Scenario().open();
    s.k.clock.advance(60_000);
    await s.ownerPushed();
    const ts = s.k.transitions(s.d.id);
    expect(ts.map((t) => t.toVersion)).toEqual([1, 2, 3]);
    expect(ts.map((t) => t.fromVersion)).toEqual([0, 1, 2]);
    expect(ts.at(-1)!.at).toBe('2026-01-01T00:01:00.000Z');
    expect(s.d.version).toBe(3);
  });

  test('ids are deterministic: two runs of the same sequence allocate the same ids', async () => {
    const a = await new Scenario().open(); await a.ownerPushed();
    const b = await new Scenario().open(); await b.ownerPushed();
    expect(a.view).toEqual(b.view);
  });

  test('a decision written against a version that moved is a CAS miss, and nothing is written', async () => {
    const s = await new Scenario().open();
    const before = s.view;
    const dec = await s.k.submit({ type: 'HeadObserved', actor: 'webhook', live: live('H2') }, s.ref);
    expect(dec.result).toBe('applied');
    if (dec.result !== 'applied') return;
    // Replay the same decision: its guard names the version it read, which is gone.
    expect(await s.k.store.applyTransition(dec.decision, { deliveryId: s.d.id })).toEqual({ status: 'conflict', cause: 'guard' });
    expect(s.d.version).toBe(before.delivery!.version + 1);
  });

  test('a replayed idempotency key is a uniqueness conflict that writes nothing', async () => {
    const s = await new Scenario().open();
    const dec = await s.k.submit({ type: 'HeadObserved', actor: 'webhook', live: live('H2') }, s.ref);
    if (dec.result !== 'applied') throw new Error('applied');
    const after = s.view;
    const replay = { ...dec.decision, guard: { ...dec.decision.guard, version: s.d.version, states: [s.state] } };
    expect(await s.k.store.applyTransition(replay, { deliveryId: s.d.id })).toEqual({ status: 'conflict', cause: 'unique' });
    expect(s.view).toEqual(after);
  });
});

describe('#4686: a review fix that changes nothing', () => {
  const requested = async () => {
    const s = await new Scenario().open();
    await s.ownerPushed('H1');
    expectApplied(await s.verdict('request_changes'), 'CHANGES_REQUESTED');
    return { s, fix: await s.startFix() };
  };

  test('a fix that reports success without moving the head is not delivery: no re-review, no approval (#3754 proof)', async () => {
    const { s, fix } = await requested();
    const r = await s.fixEnded(fix, { outcome: 'success', localHeadSha: 'H1', commitCount: 0 });
    expectApplied(r, 'AWAITING_PUSH');
    expect(r.result === 'applied' && r.decision.evidence.proof).toEqual({ holds: false, reason: 'head_not_advanced' });
    expect(s.view.attempts.find((a) => a.id === fix)!.outcome).toBe('unproven');
    expect(s.rounds).toHaveLength(1);
    expect(s.d.approvedHeads).toEqual([]);
  });

  test('a person merging on GitHub over the open verdict is recorded as merged over it', async () => {
    const { s } = await requested();
    const r = await s.submit({ type: 'PrMerged', actor: 'webhook', live: mergedLive('H1') });
    expectApplied(r, 'MERGED');
    expect(r.result === 'applied' && r.decision.evidence.reviewClass).toBe('merged_over_verdict');
    expect(s.d).toMatchObject({ mergedAt: '2026-01-01T01:00:00.000Z', mergeCommitSha: 'M1' });
  });

  // AC-19 is a shared scenario (./scenarios), so it runs on Postgres too.
});

describe('#4679: a second push before re-review', () => {
  test('approval binds only the reviewed head: H3 approved, H2 never, and a later push is unapproved', async () => {
    const s = await new Scenario().open();
    await s.ownerPushed('H1');
    await s.verdict('request_changes');
    const fix = await s.startFix();
    expectApplied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW');
    expectApplied(await s.push('H3'), 'AWAITING_REVIEW');
    expectApplied(await s.verdict('approve'), 'APPROVED');
    expect(s.d.approvedHeads).toEqual(['H3']);
    expect(s.k.effects(s.d.id, 'post_review').at(-1)!.payload).toMatchObject({ commitId: 'H3', event: 'APPROVE' });
    expectNotApplied(await s.land('H2'), 'stale', 'head_moved');
    expectApplied(await s.push('H4'), 'AWAITING_REVIEW');
    expect(s.d.approvedHeads).not.toContain('H4');
  });

  test('a late approval of the superseded head posts no review', async () => {
    const s = await new Scenario().open();
    await s.ownerPushed('H1');
    await s.verdict('request_changes');
    const fix = await s.startFix();
    await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: live('H2'), proof: { liveContainsLocal: true } });
    const fixRound = s.latestRound;
    await s.push('H3');
    expectNotApplied(await s.verdict('approve', fixRound.id, 'H2'), 'stale', 'round_superseded');
    expect(s.k.effects(s.d.id, 'post_review').map((e) => e.payload.event)).toEqual(['REQUEST_CHANGES']);
  });

  // AC-17 and AC-18 are shared scenarios (./scenarios), so they run on Postgres too.
});

describe('the scenarios can fail', () => {
  test('a store whose ack does not settle the row fails the drain scenario, naming what it read', async () => {
    const host = memoryHost();
    host.store.ackEffect = async () => true;
    const drain = CONFORMANCE_SCENARIOS.find((s) => s.name.startsWith('drain: every due effect'))!;
    await expect(drain.run(host)).rejects.toThrow(ConformanceFailure);
  });
  test('a store that loses the transition log fails the idempotency scenario', async () => {
    const host = memoryHost();
    host.store.findTransition = async () => null;
    const s5 = CONFORMANCE_SCENARIOS.find((s) => s.name.startsWith('S5:'))!;
    await expect(s5.run(host)).rejects.toThrow();
  });

  // The incident sequences (incident-scenarios.ts), each against the adapter fault it guards.
  const incident = (prefix: string) => CONFORMANCE_SCENARIOS.find((s) => s.name.startsWith(prefix))!;

  test('#3787: an epoch store with no compare-and-set or unique index writes a second successor, and the double-ingest scenario fails', async () => {
    const host = memoryHost();
    host.epochs = laxEpochs();
    await expect(incident('#3787').run(host)).rejects.toThrow(/compare-and-set/);
  });
  test('#4663/#4670: an epoch store that drops the settlement it was given lets the held branch retire, and the refresh scenario fails', async () => {
    const host = memoryHost();
    const apply = host.epochs.apply;
    host.epochs.apply = (ops) => apply(ops.map((o) => (o.op === 'update' ? { ...o, set: { ...o.set, settlement: undefined } } : o)));
    await expect(incident('#4663/#4670').run(host)).rejects.toThrow(/settlement/);
  });
  test('§15: a store that loses the decided round at H1 lets the #3754 re-review in, and the replay fails', async () => {
    const host = memoryHost();
    const load = host.store.loadView.bind(host.store);
    // Only on the delivery that replays step 6 after a refused completion (PR 3756), so the
    // failure is that step's and not an earlier one's.
    host.store.loadView = async (ref) => {
      const v = await load(ref);
      if (v.delivery?.prNumber !== 3756) return v;
      return { ...v, rounds: v.rounds.map((r) => (r.status === 'decided' ? { ...r, status: 'superseded' } : r)) };
    };
    await expect(incident('§15 (#3754)').run(host)).rejects.toThrow(/head_already_reviewed/);
  });
  test('#4686: a store that drops the external-merge effect files no trunk fix, and the end-to-end scenario fails', async () => {
    const host = memoryHost();
    const write = host.store.applyTransition.bind(host.store);
    host.store.applyTransition = (d, ref) => write({ ...d, effects: d.effects.filter((e) => e.kind !== 'dispatch_external_merge_fix') }, ref);
    await expect(incident('#4686 end to end').run(host)).rejects.toThrow(/trunk fix/);
  });
});

/** Mission epochs with no compare-and-set and no unique index: every write applies. */
function laxEpochs(): EpochHost {
  const rows: EpochSnapshot[] = [];
  const branches = new Map<string, string | null>();
  let seq = 0;
  return {
    seedMission: async (branch) => { const id = `lax${++seq}`; branches.set(id, branch); return id; },
    load: async (missionId) => ({ integrationBranch: branches.get(missionId) ?? null, epochs: rows.filter((r) => r.missionId === missionId).sort((a, b) => a.epoch - b.epoch).map((r) => ({ ...r })) }),
    apply: async (ops: EpochOp[]) => {
      for (const op of ops) {
        if (op.op === 'insert') {
          const { predecessorEpoch: _p, ...e } = op.epoch;
          rows.push({ ...e, id: `le${++seq}`, version: 0, settlement: null });
        } else if (op.op === 'update') {
          const row = rows.find((r) => r.id === op.epochId);
          if (row) Object.assign(row, op.set, { version: row.version + 1 });
        } else branches.set(op.missionId, op.branch);
      }
      return true;
    },
  };
}
