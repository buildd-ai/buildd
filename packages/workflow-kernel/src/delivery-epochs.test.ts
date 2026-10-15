/**
 * The mission epoch transition table (docs/specs/workflow-kernel-library.md §6,
 * AC-20–AC-23), run against the in-memory epoch store, which keeps the same
 * CAS and unique-index rules as the Postgres statement.
 */
import { describe, expect, it } from 'bun:test';
import {
  adoptionOf, classifySettlement, epochBranchName, epochCompletionHold, isPriorEpochBranch, pendingEpochSteps,
  reduceMissionEpochs, writableEpoch, type MissionEpochCommand, type MissionEpochView,
} from './delivery-epochs';
import { EpochConflict, MemoryEpochStore } from './memory/delivery-epochs';

const M = 'mission-1';
const ROOT = 'mission/kernel';
const AT = '2026-10-14T12:00:00.000Z';
const base = { actor: 'test', at: AT };

function harness(opts: { work?: MissionEpochView['work']; terminal?: boolean; legacyPr?: MissionEpochView['legacyPr'] } = {}) {
  const store = new MemoryEpochStore();
  store.setMissionBranch(M, ROOT);
  let work = opts.work ?? { unfinishedTasks: 1, openTaskPrs: 0 };
  let terminal = opts.terminal ?? false;
  const view = () => store.view({ missionId: M, terminal, scopeVersion: 1, work, legacyPr: opts.legacyPr ?? null });
  /** What the host does: reduce, apply, and on a lost race re-read and reduce again. */
  const run = (cmd: MissionEpochCommand, v = view()) => {
    for (let i = 0; i < 3; i++) {
      const r = reduceMissionEpochs(i === 0 ? v : view(), cmd);
      if (r.result !== 'applied') return r;
      try { store.apply(r.ops); return r; } catch (err) { if (!(err instanceof EpochConflict)) throw err; }
    }
    throw new Error('did not converge');
  };
  return {
    store, view, run,
    setWork: (w: MissionEpochView['work']) => { work = w; },
    setTerminal: (t: boolean) => { terminal = t; },
  };
}

const merged = (prNumber: number, extra: Partial<Extract<MissionEpochCommand, { type: 'Merged' }>> = {}): MissionEpochCommand => ({
  ...base, type: 'Merged', prNumber, repoFullName: 'o/r', headRef: ROOT, mergeCommitSha: 'm1', mergedHeadSha: 'h1', mergedAt: AT, ...extra,
});

describe('epoch naming', () => {
  it('epoch 1 keeps the mission branch; a successor gets a name no epoch used', () => {
    expect(epochBranchName(ROOT, 1)).toBe(ROOT);
    expect(epochBranchName(ROOT, 2)).toBe(`${ROOT}-delivery-2`);
    expect(epochBranchName(`${ROOT}-delivery-2`, 3)).toBe(`${ROOT}-delivery-3`);
  });
  it('a stale base the task was filed under is recognised as a prior epoch, nothing else is', () => {
    expect(isPriorEpochBranch(ROOT, `${ROOT}-delivery-2`)).toBe(true);
    expect(isPriorEpochBranch(`${ROOT}-delivery-2`, `${ROOT}-delivery-3`)).toBe(true);
    expect(isPriorEpochBranch(`${ROOT}-delivery-2`, `${ROOT}-delivery-2`)).toBe(false);
    expect(isPriorEpochBranch('mission/other', `${ROOT}-delivery-2`)).toBe(false);
    expect(isPriorEpochBranch('buildd/abc12345-x', ROOT)).toBe(false);
    expect(isPriorEpochBranch(null, ROOT)).toBe(false);
  });
});

describe('adoption of a mission that predates epochs', () => {
  it('no mission PR (or an open one): the branch is epoch 1, open', () => {
    const h = harness({ legacyPr: { prNumber: 7, repoFullName: 'o/r', ownerTaskId: 't', state: 'open', mergedAt: null } });
    expect(h.run({ ...base, type: 'Adopt' }).result).toBe('applied');
    const [e1] = h.view().epochs;
    expect(e1).toMatchObject({ epoch: 1, branch: ROOT, state: 'open', origin: 'adopted', prNumber: 7 });
    expect(h.run({ ...base, type: 'Adopt' }).result).toBe('noop');
  });

  it('a merged mission PR and no work left: one merged epoch, already settled and retired', () => {
    const h = harness({ work: { unfinishedTasks: 0, openTaskPrs: 0 }, legacyPr: { prNumber: 7, repoFullName: 'o/r', ownerTaskId: 't', state: 'merged', mergedAt: AT } });
    h.run({ ...base, type: 'Adopt' });
    expect(h.view().epochs).toHaveLength(1);
    expect(h.view().epochs[0]).toMatchObject({ state: 'merged', prNumber: 7, settledAt: AT, retiredAt: AT });
    expect(pendingEpochSteps(h.view())).toEqual([]);
  });

  it('a merged mission PR with work left (the live re-cut): epoch 1 merged, epoch 2 open under the same name, never deleted', () => {
    const h = harness({ legacyPr: { prNumber: 7, repoFullName: 'o/r', ownerTaskId: 't', state: 'merged', mergedAt: AT } });
    h.run({ ...base, type: 'Adopt' });
    const [e1, e2] = h.view().epochs;
    expect(e1).toMatchObject({ state: 'merged', prNumber: 7 });
    expect(e2).toMatchObject({ epoch: 2, branch: ROOT, state: 'open', origin: 'adopted_recut', predecessorId: e1.id });
    expect(h.store.missionBranch(M)).toBe(ROOT);
    // The shared branch is never retired while the open epoch uses it.
    expect(pendingEpochSteps(h.view()).filter((s) => s.step === 'retire')).toEqual([]);
  });

  it('adopted at the moment its mission PR merges: that PR is the live delivery, so the merge rotates and settles normally', () => {
    const h = harness({ legacyPr: { prNumber: 7, repoFullName: 'o/r', ownerTaskId: 't', state: 'merged', mergedAt: AT } });
    h.run({ ...base, type: 'Adopt', mergingPr: 7 });
    expect(h.view().epochs).toHaveLength(1);
    expect(h.view().epochs[0]).toMatchObject({ epoch: 1, state: 'open', prNumber: 7 });
    expect(h.run(merged(7)).reason).toBe('merged_rotated');
    expect(pendingEpochSteps(h.view()).map((s) => s.step)).toEqual(['cut_branch']);
  });

  it('a mission with no integration branch is not adopted', () => {
    const h = harness();
    h.store.setMissionBranch(M, null);
    expect(adoptionOf(h.view(), AT)).toEqual([]);
    expect(h.run({ ...base, type: 'Adopt' }).result).toBe('rejected');
  });
});

describe('AC-20 / scenario 1 and 3: an epoch merges while work remains', () => {
  function inFlight() {
    const h = harness();
    h.run({ ...base, type: 'Adopt' });
    h.run({ ...base, type: 'PrBound', prNumber: 10, repoFullName: 'o/r', ownerTaskId: 'owner-1', headRef: ROOT });
    return h;
  }

  it('the mission stays active with exactly one writable successor, cut from the merge commit, and the branch projected', () => {
    const h = inFlight();
    const r = h.run(merged(10));
    expect(r).toMatchObject({ result: 'applied', reason: 'merged_rotated' });
    const [e1, e2] = h.view().epochs;
    expect(e1).toMatchObject({ state: 'merged', prNumber: 10, mergeCommitSha: 'm1', mergedHeadSha: 'h1', mergedAt: AT, scopeVersion: 1 });
    expect(e2).toMatchObject({ epoch: 2, state: 'open', origin: 'cut', branch: `${ROOT}-delivery-2`, cutFromSha: 'm1', predecessorId: e1.id });
    expect(writableEpoch(h.view())?.id).toBe(e2.id);
    expect(h.store.missionBranch(M)).toBe(`${ROOT}-delivery-2`);
  });

  it('the merge ingested twice, or late, creates no second successor', () => {
    const h = inFlight();
    h.run(merged(10));
    expect(h.run(merged(10)).result).toBe('noop');
    expect(h.run(merged(10, { mergedAt: '2026-10-15T00:00:00.000Z' })).result).toBe('noop');
    expect(h.view().epochs.map((e) => e.epoch)).toEqual([1, 2]);
  });

  it('two hosts racing on the same view: the loser re-reads and ends a noop', () => {
    const h = inFlight();
    const stale = h.view();
    const a = reduceMissionEpochs(stale, merged(10));
    const b = reduceMissionEpochs(stale, merged(10));
    h.store.apply(a.ops);
    expect(() => h.store.apply(b.ops)).toThrow(EpochConflict);
    expect(reduceMissionEpochs(h.view(), merged(10)).result).toBe('noop');
    expect(h.view().epochs.filter((e) => e.state === 'open')).toHaveLength(1);
  });

  it('the steps run in order: cut the successor branch, then settle, then retire', () => {
    const h = inFlight();
    h.run(merged(10));
    const [e1, e2] = h.view().epochs;
    expect(pendingEpochSteps(h.view())).toEqual([{ step: 'cut_branch', epochId: e2.id, branch: e2.branch, fromSha: 'm1' }]);
    h.run({ ...base, type: 'BranchReady', epochId: e2.id });
    expect(pendingEpochSteps(h.view())).toEqual([{ step: 'settle', epochId: e1.id, branch: ROOT, successorBranch: e2.branch }]);
    h.run({ ...base, type: 'Settled', epochId: e1.id, settlement: { settled: [], held: [], satisfiedByPr: 10 } });
    expect(pendingEpochSteps(h.view())).toEqual([{ step: 'retire', epochId: e1.id, branch: ROOT }]);
    h.run({ ...base, type: 'Retired', epochId: e1.id });
    expect(pendingEpochSteps(h.view())).toEqual([]);
  });

  it('the later task PR opens and merges on the successor normally (epoch 2 rotates to 3 the same way)', () => {
    const h = inFlight();
    h.run(merged(10));
    expect(h.run({ ...base, type: 'PrBound', prNumber: 11, repoFullName: 'o/r', ownerTaskId: 'owner-2', headRef: ROOT }).result).toBe('rejected');
    expect(h.run({ ...base, type: 'PrBound', prNumber: 11, repoFullName: 'o/r', ownerTaskId: 'owner-2', headRef: `${ROOT}-delivery-2` }).result).toBe('applied');
    h.setWork({ unfinishedTasks: 0, openTaskPrs: 0 });
    expect(h.run(merged(11, { headRef: `${ROOT}-delivery-2`, mergeCommitSha: 'm2' })).reason).toBe('merged');
    expect(h.view().epochs.map((e) => [e.epoch, e.state])).toEqual([[1, 'merged'], [2, 'merged']]);
    expect(writableEpoch(h.view())).toBeNull();
  });

  it('a merge for a PR no epoch knows is refused, not guessed', () => {
    const h = inFlight();
    expect(h.run(merged(99, { headRef: 'buildd/other' })).reason).toBe('unknown_epoch');
  });
});

describe('scenario 4 and later work: an epoch merges with nothing left', () => {
  it('no successor is cut; work added later gets exactly one, from trunk', () => {
    const h = harness({ work: { unfinishedTasks: 0, openTaskPrs: 0 } });
    h.run({ ...base, type: 'Adopt' });
    h.run({ ...base, type: 'PrBound', prNumber: 10, repoFullName: 'o/r', ownerTaskId: 'o', headRef: ROOT });
    expect(h.run(merged(10)).reason).toBe('merged');
    expect(writableEpoch(h.view())).toBeNull();
    expect(h.store.missionBranch(M)).toBe(ROOT);

    h.setWork({ unfinishedTasks: 1, openTaskPrs: 0 });
    const ensure: MissionEpochCommand = { ...base, type: 'EnsureWritable', trunkSha: 't9', reason: 'task_claimed' };
    expect(h.run(ensure).reason).toBe('successor_cut');
    expect(h.run(ensure).result).toBe('noop');
    expect(h.view().epochs.map((e) => [e.epoch, e.state, e.cutFromSha])).toEqual([[1, 'merged', null], [2, 'open', 't9']]);
    expect(h.store.missionBranch(M)).toBe(`${ROOT}-delivery-2`);
  });

  it('a completed or archived mission is never given a new epoch', () => {
    const h = harness({ work: { unfinishedTasks: 0, openTaskPrs: 0 } });
    h.run({ ...base, type: 'Adopt' });
    h.run(merged(10));
    h.setTerminal(true);
    expect(h.run({ ...base, type: 'EnsureWritable', trunkSha: 't9', reason: 'x' }).reason).toBe('mission_terminal');
  });

  it('completion: an open epoch with landed work holds it; an empty open epoch or none does not', () => {
    const h = harness();
    h.run({ ...base, type: 'Adopt' });
    h.run(merged(10, { headRef: ROOT }));
    const v = h.view();
    expect(epochCompletionHold(v, () => 0)).toEqual({ holds: false });
    const held = epochCompletionHold(v, (b) => (b === `${ROOT}-delivery-2` ? 2 : 0));
    expect(held).toMatchObject({ holds: true, landed: 2 });
    h.setWork({ unfinishedTasks: 0, openTaskPrs: 0 });
  });

  it('completion on an adopted re-cut counts only work landed after the predecessor merged', () => {
    const h = harness({ legacyPr: { prNumber: 7, repoFullName: 'o/r', ownerTaskId: 't', state: 'merged', mergedAt: AT } });
    h.run({ ...base, type: 'Adopt' });
    const seen: Array<[string, string | null]> = [];
    epochCompletionHold(h.view(), (b, after) => { seen.push([b, after]); return 0; });
    expect(seen).toEqual([[ROOT, AT]]);
  });
});

describe('AC-23 / a11abc4b: settlement before a branch is retired', () => {
  const ctx = { mergeCommitSha: 'm1', successorBranch: `${ROOT}-delivery-2` };

  it('a contained refresh or task PR closes as redundant, with the read it rests on', () => {
    const [r] = classifySettlement([{ prNumber: 5, kind: 'refresh', baseRef: ROOT, headSha: 'h', contained: true }], ctx);
    expect(r).toMatchObject({ disposition: 'close_redundant', proof: { headSha: 'h', mergeCommitSha: 'm1', contained: true } });
  });

  it('task work GitHub moved to trunk when it deleted the branch goes to the successor, never stays on trunk', () => {
    const [r] = classifySettlement([{ prNumber: 6, kind: 'task', baseRef: 'dev', headSha: 'h', contained: false }], ctx);
    expect(r).toMatchObject({ disposition: 'retarget', target: `${ROOT}-delivery-2` });
  });

  it('a refresh with unique work, or any unreadable ancestry, holds the branch', () => {
    const out = classifySettlement([
      { prNumber: 5, kind: 'refresh', baseRef: ROOT, headSha: 'h', contained: false },
      { prNumber: 6, kind: 'task', baseRef: ROOT, headSha: 'h', contained: null },
      { prNumber: 8, kind: 'task', baseRef: ROOT, headSha: 'h', contained: false },
    ], { mergeCommitSha: 'm1', successorBranch: null });
    expect(out.map((p) => p.disposition)).toEqual(['hold', 'hold', 'hold']);
  });

  it('a held settlement keeps the branch: retire is refused and not owed; settle stays owed until it clears', () => {
    const h = harness();
    h.run({ ...base, type: 'Adopt' });
    h.run(merged(10));
    const [e1, e2] = h.view().epochs;
    h.run({ ...base, type: 'BranchReady', epochId: e2.id });
    const held = classifySettlement([{ prNumber: 5, kind: 'refresh', baseRef: ROOT, headSha: 'h', contained: false }], ctx);
    h.run({ ...base, type: 'Settled', epochId: e1.id, settlement: { settled: [], held, satisfiedByPr: 10 } });
    expect(h.run({ ...base, type: 'Retired', epochId: e1.id }).reason).toBe('settlement_held');
    expect(pendingEpochSteps(h.view()).map((s) => s.step)).toEqual(['settle']);
    // A person closed it: the next settlement clears and the branch can go.
    h.run({ ...base, type: 'Settled', epochId: e1.id, settlement: { settled: [], held: [], satisfiedByPr: 10 } });
    expect(pendingEpochSteps(h.view()).map((s) => s.step)).toEqual(['retire']);
  });

  it('settle waits for the successor branch to exist, so nothing is moved onto a missing ref', () => {
    const h = harness();
    h.run({ ...base, type: 'Adopt' });
    h.run(merged(10));
    expect(pendingEpochSteps(h.view()).map((s) => s.step)).toEqual(['cut_branch']);
  });
});
