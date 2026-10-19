/**
 * Mission deliveries and epochs (docs/specs/workflow-kernel-library.md §6,
 * AC-20–AC-23; task f3bda4e1, folding in a11abc4b's refresh settlement).
 *
 * A mission-branch mission reaches trunk through an ordered sequence of
 * epochs. Each epoch is one integration branch and, once its work is in, one
 * PR into trunk. A merged epoch is terminal and immutable; the mission is not.
 * When an epoch merges while the mission still has work, the mission rotates
 * to exactly one successor epoch, cut from the merge commit, and every later
 * task PR targets that successor. Before a merged epoch's branch is deleted,
 * every open PR still based on it (or silently retargeted to trunk by
 * GitHub's delete-branch-on-merge) is settled: redundant work is closed with
 * the epoch's PR recorded as where it landed, task work is retargeted to the
 * successor, and anything unique or uncertain holds the branch and is handed
 * to a person.
 *
 * This module is the pure half: the transition table (`reduceMissionEpochs`),
 * what is still owed after a transition (`pendingEpochSteps`), the settlement
 * rule (`classifySettlement`) and the branch naming. The host loads a
 * `MissionEpochView`, applies the ops one statement per transition with a
 * compare-and-set on the epoch row's version, and performs the steps against
 * GitHub, recording each outcome back through this reducer. Nothing here
 * reads a clock, a database or GitHub; time arrives on the command.
 *
 * The epoch rows are the durable record of what each delivery shipped:
 * branch, PR, merge commit, timestamps and the scope version it carried.
 * Rows are never deleted and a merged row's delivery fields never change.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * `open`: the one writable epoch, the base every task PR of the mission takes.
 * `merged`: its PR reached trunk; terminal, kept as the record of what it
 * shipped. A mission has at most one open epoch.
 */
export type EpochState = 'open' | 'merged';

/**
 * How the epoch came to exist. `cut`: rotated by this reducer, its branch is
 * created from `cutFromSha`. `adopted`: the mission predates epochs and its
 * existing integration branch became epoch 1. `adopted_recut`: the mission
 * predates epochs, its first mission PR had already merged and its branch was
 * re-cut under the same name for later work; that live branch is the open
 * epoch.
 */
export type EpochOrigin = 'cut' | 'adopted' | 'adopted_recut';

export interface EpochSnapshot {
  id: string;
  missionId: string;
  epoch: number;
  branch: string;
  state: EpochState;
  /** CAS counter: every applied transition on the row increments it. */
  version: number;
  origin: EpochOrigin;
  /** The trunk commit a `cut` epoch's branch is created from (the predecessor's merge commit). */
  cutFromSha: string | null;
  /** When the branch was confirmed on the remote (created, or found there). */
  branchReadyAt: string | null;
  predecessorId: string | null;
  scopeVersion: number;
  repoFullName: string | null;
  prNumber: number | null;
  /** The task that owns this epoch's PR (the mission-PR bookkeeping row). */
  ownerTaskId: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedHeadSha: string | null;
  /** The settlement of the PRs left on this epoch's branch when it merged. */
  settlement: EpochSettlement | null;
  settledAt: string | null;
  /** When the merged branch was confirmed gone from the remote. */
  retiredAt: string | null;
  /**
   * PRs GitHub moved off this epoch's branch (a retarget recorded from the
   * `pull_request.edited` webhook, `from` = this branch), so settlement knows
   * they were on it. A PR that was always on trunk is never in this list.
   */
  movedPrs?: number[];
}

/** The legacy mission-PR record, read once when a mission predating epochs is adopted. */
export interface LegacyMissionPr {
  prNumber: number | null;
  repoFullName: string | null;
  ownerTaskId: string | null;
  state: 'open' | 'merged' | 'closed';
  mergedAt: string | null;
}

export interface MissionEpochView {
  missionId: string;
  /** The mission's integration branch (`missions.workingBranch`) when it uses one; null otherwise. */
  integrationBranch: string | null;
  /** completed / archived: no new epoch is cut. */
  terminal: boolean;
  /** The mission's current scope version (1 until a scope amendment). */
  scopeVersion: number;
  /** Ordered by `epoch`. */
  epochs: EpochSnapshot[];
  /**
   * Work that has not reached trunk. `unfinishedTasks`: deliverable tasks
   * still pending, assigned or in progress with no merged PR. `openTaskPrs`:
   * deliverable task PRs open on an integration branch.
   */
  work: { unfinishedTasks: number; openTaskPrs: number };
  /** Read only for adoption; null when the mission never had a mission PR. */
  legacyPr?: LegacyMissionPr | null;
  /**
   * Read only for adoption: the integration branch exists and carries commits
   * trunk lacks. A merged mission PR then cannot be the whole story: the branch
   * is the live delivery (an adopted re-cut), never a record to retire.
   */
  liveBranchAhead?: boolean;
}

// ── Branch naming ───────────────────────────────────────────────────────────

const SUCCESSOR_SUFFIX = /-delivery-\d+$/;

/**
 * Epoch n's branch. Epoch 1 keeps the mission's own name (`root`, exactly as
 * it is); a successor gets `<root>-delivery-<n>`, a name no other epoch used,
 * so a merged epoch's branch is never written again and GitHub's
 * delete-on-merge of it can never take a later epoch's work with it. The root
 * is never stripped: a mission branch that already ends in `-delivery-2` gets
 * `…-delivery-2-delivery-2` for its second epoch, never its own name back.
 */
export function epochBranchName(root: string, epoch: number): string {
  return epoch <= 1 ? root : `${root}-delivery-${epoch}`;
}

/**
 * Is `ref` the branch of one of this mission's epochs other than the current
 * one? Lets a door replace a stale base a task was filed with (the epoch it
 * was created under) by the current writable branch, without a database read.
 */
export function isPriorEpochBranch(ref: string | null | undefined, currentBranch: string | null | undefined): boolean {
  const r = ref?.trim();
  const cur = currentBranch?.trim();
  if (!r || !cur || r === cur) return false;
  return r.replace(SUCCESSOR_SUFFIX, '') === cur.replace(SUCCESSOR_SUFFIX, '');
}

export const writableEpoch = (v: Pick<MissionEpochView, 'epochs'>): EpochSnapshot | null =>
  v.epochs.find((e) => e.state === 'open') ?? null;

export const latestEpoch = (v: Pick<MissionEpochView, 'epochs'>): EpochSnapshot | null =>
  v.epochs.length === 0 ? null : v.epochs.reduce((a, b) => (b.epoch > a.epoch ? b : a));

const hasWork = (v: MissionEpochView): boolean => v.work.unfinishedTasks > 0 || v.work.openTaskPrs > 0;

// ── Settlement ──────────────────────────────────────────────────────────────

/**
 * One open PR found on a merged epoch's branch, or a mission task PR GitHub
 * moved from it to trunk when it deleted the branch. `contained`: its head is
 * an ancestor of the epoch's merge commit (every commit it carries already
 * reached trunk); null when that could not be read.
 */
export interface SettlementCandidate {
  prNumber: number;
  /** `refresh`: a merge-trunk-into-the-mission-branch PR; `task`: deliverable task work. */
  kind: 'task' | 'refresh';
  baseRef: string;
  headSha: string | null;
  contained: boolean | null;
}

export type SettlementDisposition =
  /** Every commit it carries is in trunk through this epoch: close it, recording the epoch PR. */
  | 'close_redundant'
  /** Task work still to land: move it onto the successor epoch. */
  | 'retarget'
  /** Unique or uncertain work: keep the branch, ask a person. Never retargeted to trunk. */
  | 'hold';

export interface SettledPr {
  prNumber: number;
  kind: SettlementCandidate['kind'];
  disposition: SettlementDisposition;
  /** Why, in words a person can act on. */
  reason: string;
  /** For `retarget`: the successor branch. */
  target?: string;
  /** The read the disposition rests on. */
  proof: { headSha: string | null; mergeCommitSha: string | null; contained: boolean | null };
}

export interface EpochSettlement {
  /** Dispositions taken (closed or retargeted). */
  settled: SettledPr[];
  /** PRs holding the branch until a person decides. */
  held: SettledPr[];
  /** The epoch PR the redundant ones are recorded as satisfied by. */
  satisfiedByPr: number | null;
  /**
   * The branch's live head carries commits that never reached trunk (it is
   * neither the merged head nor contained in trunk): the branch is kept, a
   * person is asked, and nothing deletes it. The head read, when one was.
   */
  unshippedHead?: string | null;
}

/** Does this settlement keep the branch (held PRs, or unshipped commits on it)? */
export const settlementHolds = (s: EpochSettlement | null | undefined): boolean =>
  (s?.held.length ?? 0) > 0 || !!s?.unshippedHead;

/**
 * The settlement rule (a11abc4b R-2, R-3; §6 AC-23). Pure: the host read
 * each candidate's ancestry fresh from GitHub.
 *
 *  - contained (task or refresh): redundant, close it with the epoch PR as
 *    where its work landed;
 *  - a task PR with work of its own: retarget it to the successor, never to
 *    trunk (no successor yet: hold);
 *  - a refresh PR with work of its own (a conflict resolution, a migration
 *    renumber): its premise, the merged branch, is gone, and nothing can tell
 *    mechanically whether that work still matters. Hold and ask;
 *  - an unreadable ancestry: hold. Uncertain equivalence never closes a PR.
 */
export function classifySettlement(
  candidates: SettlementCandidate[],
  ctx: { mergeCommitSha: string | null; successorBranch: string | null },
): Array<SettledPr> {
  return candidates.map((c) => {
    const proof = { headSha: c.headSha, mergeCommitSha: ctx.mergeCommitSha, contained: c.contained };
    if (c.contained === null || !ctx.mergeCommitSha) {
      return { prNumber: c.prNumber, kind: c.kind, disposition: 'hold', reason: 'could not tell whether its commits already reached trunk', proof };
    }
    if (c.contained) {
      return { prNumber: c.prNumber, kind: c.kind, disposition: 'close_redundant', reason: 'every commit it carries reached trunk with this delivery', proof };
    }
    if (c.kind === 'task') {
      return ctx.successorBranch
        ? { prNumber: c.prNumber, kind: c.kind, disposition: 'retarget', reason: 'its work is still to land; it moves to the next delivery', target: ctx.successorBranch, proof }
        : { prNumber: c.prNumber, kind: c.kind, disposition: 'hold', reason: 'its work is still to land and there is no next delivery to move it to', proof };
    }
    return { prNumber: c.prNumber, kind: c.kind, disposition: 'hold', reason: 'it carries changes of its own that did not reach trunk; a person decides whether they still matter', proof };
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

interface Base { actor: string; at: string }

export type MissionEpochCommand =
  /**
   * A mission predating epochs: record its existing branch (and any merged
   * mission PR) as epochs. `mergingPr`: adoption is happening because that PR
   * is merging now, so it is the open epoch's PR, not a past delivery.
   */
  | (Base & { type: 'Adopt'; mergingPr?: number | null; liveBranchAhead?: boolean })
  /** The mission PR for the open epoch was opened (or adopted). */
  | (Base & { type: 'PrBound'; prNumber: number; repoFullName: string; ownerTaskId: string | null; headRef: string | null })
  /** An epoch's PR merged (GitHub's values). Idempotent on replay. */
  | (Base & { type: 'Merged'; prNumber: number; repoFullName: string; headRef: string | null; mergeCommitSha: string | null; mergedHeadSha: string | null; mergedAt: string })
  /** Work needs a writable branch and the newest epoch already merged: cut one from `trunkSha`. */
  | (Base & { type: 'EnsureWritable'; trunkSha: string | null; reason: string })
  /** The open epoch's branch is confirmed on the remote. */
  | (Base & { type: 'BranchReady'; epochId: string })
  /** A merged epoch's PRs were settled (or re-settled while some are held). */
  | (Base & { type: 'Settled'; epochId: string; settlement: EpochSettlement })
  /** A merged, settled epoch's branch is confirmed gone from the remote. */
  | (Base & { type: 'Retired'; epochId: string })
  /** GitHub moved a PR off an epoch's branch (the retarget webhook's `from`). */
  | (Base & { type: 'PrMovedOff'; branch: string; prNumber: number });

export interface NewEpoch {
  missionId: string;
  epoch: number;
  branch: string;
  state: EpochState;
  origin: EpochOrigin;
  cutFromSha: string | null;
  predecessorId: string | null;
  /** For an adopted epoch 2: the epoch 1 row inserted in the same statement. */
  predecessorEpoch?: number;
  scopeVersion: number;
  repoFullName: string | null;
  prNumber: number | null;
  ownerTaskId: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedHeadSha: string | null;
  branchReadyAt: string | null;
  settledAt: string | null;
  retiredAt: string | null;
}

export type EpochPatch = Partial<Pick<EpochSnapshot,
  'state' | 'repoFullName' | 'prNumber' | 'ownerTaskId' | 'mergedAt' | 'mergeCommitSha' | 'mergedHeadSha' | 'branchReadyAt' | 'settlement' | 'settledAt' | 'retiredAt' | 'movedPrs'>>;

export type EpochOp =
  | { op: 'insert'; epoch: NewEpoch }
  | { op: 'update'; epochId: string; expectVersion: number; set: EpochPatch }
  /**
   * Project the writable branch onto the mission (`missions.workingBranch`), in
   * the same statement, so every base resolution reads the successor at once.
   * Applied only while the mission still names `fromBranch`.
   */
  | { op: 'project_branch'; missionId: string; fromBranch: string | null; branch: string };

export type EpochResult =
  | { result: 'applied'; ops: EpochOp[]; reason: string }
  | { result: 'noop'; ops: []; reason: string }
  | { result: 'rejected'; ops: []; reason: string };

const noop = (reason: string): EpochResult => ({ result: 'noop', ops: [], reason });
const rejected = (reason: string): EpochResult => ({ result: 'rejected', ops: [], reason });
const applied = (reason: string, ops: EpochOp[]): EpochResult => ({ result: 'applied', ops, reason });

function successorOf(v: MissionEpochView, prev: EpochSnapshot, cutFromSha: string | null): NewEpoch {
  const n = prev.epoch + 1;
  const root = v.epochs.find((e) => e.epoch === 1)?.branch ?? prev.branch;
  return {
    missionId: v.missionId, epoch: n, branch: epochBranchName(root, n), state: 'open', origin: 'cut',
    cutFromSha, predecessorId: prev.id, scopeVersion: v.scopeVersion,
    repoFullName: null, prNumber: null, ownerTaskId: null,
    mergedAt: null, mergeCommitSha: null, mergedHeadSha: null,
    branchReadyAt: null, settledAt: null, retiredAt: null,
  };
}

/**
 * The adoption of a mission that predates epochs. One rule, so a mission
 * already in flight (this mission among them) keeps working:
 *
 *  - no mission PR, or one still open or closed: its branch is epoch 1, open;
 *  - a merged mission PR and no work left: epoch 1, merged, with that PR;
 *  - a merged mission PR and work left: the branch it merged was re-cut under
 *    the same name for that work (or will be), so epoch 1 is the merged
 *    record and epoch 2 is the live branch under its existing name.
 */
export function adoptionOf(v: MissionEpochView, at: string, opts: { mergingPr?: number | null } = {}): NewEpoch[] {
  if (!v.integrationBranch || v.epochs.length > 0) return [];
  const branch = v.integrationBranch;
  const recorded = v.legacyPr ?? null;
  // The PR merging right now is the live delivery, whatever its row already says.
  const pr = recorded && opts.mergingPr != null && recorded.prNumber === opts.mergingPr
    ? { ...recorded, state: 'open' as const, mergedAt: null }
    : recorded;
  const blank = {
    missionId: v.missionId, cutFromSha: null, predecessorId: null, scopeVersion: v.scopeVersion,
    mergeCommitSha: null, mergedHeadSha: null, settledAt: null, retiredAt: null,
  };
  if (pr?.state !== 'merged') {
    return [{
      ...blank, epoch: 1, branch, state: 'open', origin: 'adopted', branchReadyAt: null,
      repoFullName: pr?.state === 'open' ? pr.repoFullName : null,
      prNumber: pr?.state === 'open' ? pr.prNumber : null,
      ownerTaskId: pr?.state === 'open' ? pr.ownerTaskId : null,
      mergedAt: null,
    }];
  }
  const first: NewEpoch = {
    ...blank, epoch: 1, branch, state: 'merged', origin: 'adopted', branchReadyAt: null,
    repoFullName: pr.repoFullName, prNumber: pr.prNumber, ownerTaskId: pr.ownerTaskId,
    mergedAt: pr.mergedAt ?? at,
    // A legacy merge was never settled by this reducer, and its branch was
    // deleted on merge by design: record both as done rather than invent work.
    settledAt: at, retiredAt: hasWork(v) || v.liveBranchAhead ? null : at,
  };
  if (!hasWork(v) && !v.liveBranchAhead) return [first];
  return [first, {
    ...blank, epoch: 2, branch, state: 'open', origin: 'adopted_recut', predecessorEpoch: 1, branchReadyAt: null,
    repoFullName: null, prNumber: null, ownerTaskId: null, mergedAt: null,
  }];
}

/**
 * The mission epoch transition table. Every command is idempotent: a replay
 * of a transition already taken is a `noop`, never a second successor.
 */
export function reduceMissionEpochs(v: MissionEpochView, cmd: MissionEpochCommand): EpochResult {
  if (cmd.type === 'Adopt') {
    if (!v.integrationBranch) return rejected('not_opted_in');
    if (v.epochs.length > 0) return noop('already_adopted');
    return applied('adopted', adoptionOf(cmd.liveBranchAhead !== undefined ? { ...v, liveBranchAhead: cmd.liveBranchAhead } : v, cmd.at, { mergingPr: cmd.mergingPr }).map((epoch) => ({ op: 'insert' as const, epoch })));
  }
  if (v.epochs.length === 0) return rejected('not_adopted');
  const byId = (id: string) => v.epochs.find((e) => e.id === id) ?? null;

  switch (cmd.type) {
    case 'PrBound': {
      const open = writableEpoch(v);
      if (!open) return rejected('no_writable_epoch');
      if (cmd.headRef && cmd.headRef !== open.branch) return rejected('head_not_writable_epoch');
      if (open.prNumber === cmd.prNumber && open.repoFullName === cmd.repoFullName) return noop('already_bound');
      if (open.prNumber != null && open.prNumber !== cmd.prNumber) return rejected('epoch_has_another_pr');
      return applied('pr_bound', [{
        op: 'update', epochId: open.id, expectVersion: open.version,
        set: { prNumber: cmd.prNumber, repoFullName: cmd.repoFullName, ownerTaskId: cmd.ownerTaskId ?? open.ownerTaskId },
      }]);
    }

    case 'Merged': {
      const target = v.epochs.find((e) => e.prNumber === cmd.prNumber && (e.repoFullName == null || e.repoFullName === cmd.repoFullName))
        ?? (() => {
          const open = writableEpoch(v);
          return open && open.prNumber == null && cmd.headRef === open.branch ? open : null;
        })();
      if (!target) return rejected('unknown_epoch');
      if (target.state === 'merged') return noop('already_merged');
      const ops: EpochOp[] = [{
        op: 'update', epochId: target.id, expectVersion: target.version,
        set: {
          state: 'merged', prNumber: cmd.prNumber, repoFullName: cmd.repoFullName,
          mergedAt: cmd.mergedAt, mergeCommitSha: cmd.mergeCommitSha, mergedHeadSha: cmd.mergedHeadSha,
        },
      }];
      // A merged epoch is terminal; the mission is not. Remaining work gets
      // exactly one successor, cut from the merge commit, in this statement.
      if (hasWork(v) && !v.terminal) {
        const next = successorOf(v, target, cmd.mergeCommitSha);
        ops.push({ op: 'insert', epoch: next });
        ops.push({ op: 'project_branch', missionId: v.missionId, fromBranch: v.integrationBranch, branch: next.branch });
        return applied('merged_rotated', ops);
      }
      return applied('merged', ops);
    }

    case 'EnsureWritable': {
      if (writableEpoch(v)) return noop('writable_exists');
      if (v.terminal) return rejected('mission_terminal');
      const last = latestEpoch(v)!;
      if (!cmd.trunkSha) return rejected('trunk_unknown');
      const next = successorOf(v, last, cmd.trunkSha);
      return applied('successor_cut', [
        { op: 'insert', epoch: next },
        { op: 'project_branch', missionId: v.missionId, fromBranch: v.integrationBranch, branch: next.branch },
      ]);
    }

    case 'BranchReady': {
      const e = byId(cmd.epochId);
      if (!e) return rejected('unknown_epoch');
      if (e.branchReadyAt) return noop('already_ready');
      return applied('branch_ready', [{ op: 'update', epochId: e.id, expectVersion: e.version, set: { branchReadyAt: cmd.at } }]);
    }

    case 'Settled': {
      const e = byId(cmd.epochId);
      if (!e) return rejected('unknown_epoch');
      if (e.state !== 'merged') return rejected('epoch_not_merged');
      if (e.retiredAt) return noop('already_retired');
      if (e.settledAt && sameSettlement(e.settlement, cmd.settlement)) return noop('already_settled');
      return applied('settled', [{
        op: 'update', epochId: e.id, expectVersion: e.version,
        set: { settlement: cmd.settlement, settledAt: cmd.at },
      }]);
    }

    case 'PrMovedOff': {
      // The newest epoch on that branch: an adopted re-cut shares its name with epoch 1.
      const e = [...v.epochs].sort((a, b) => b.epoch - a.epoch).find((x) => x.branch === cmd.branch) ?? null;
      if (!e) return rejected('unknown_epoch');
      if (e.retiredAt) return noop('already_retired');
      if ((e.movedPrs ?? []).includes(cmd.prNumber)) return noop('already_recorded');
      return applied('pr_moved_recorded', [{ op: 'update', epochId: e.id, expectVersion: e.version, set: { movedPrs: [...(e.movedPrs ?? []), cmd.prNumber] } }]);
    }

    case 'Retired': {
      const e = byId(cmd.epochId);
      if (!e) return rejected('unknown_epoch');
      if (e.state !== 'merged') return rejected('epoch_not_merged');
      if (e.retiredAt) return noop('already_retired');
      if (!e.settledAt) return rejected('not_settled');
      if (settlementHolds(e.settlement)) return rejected('settlement_held');
      return applied('retired', [{ op: 'update', epochId: e.id, expectVersion: e.version, set: { retiredAt: cmd.at } }]);
    }
  }
}

function sameSettlement(a: EpochSettlement | null, b: EpochSettlement): boolean {
  const key = (s: EpochSettlement | null) => JSON.stringify({
    settled: (s?.settled ?? []).map((p) => [p.prNumber, p.disposition]).sort(),
    held: (s?.held ?? []).map((p) => [p.prNumber, p.disposition]).sort(),
    unshippedHead: s?.unshippedHead ?? null,
  });
  return key(a) === key(b);
}

// ── What is still owed ──────────────────────────────────────────────────────

/** Does a later epoch use this epoch's branch (an adopted re-cut under the same name)? */
export const sharesBranchWithLater = (v: Pick<MissionEpochView, 'epochs'>, e: EpochSnapshot): boolean =>
  v.epochs.some((o) => o.epoch > e.epoch && o.branch === e.branch);

/** A merged epoch whose branch still has PRs to settle (or held ones). */
export const unsettledEpochs = (v: Pick<MissionEpochView, 'epochs'>): EpochSnapshot[] =>
  v.epochs.filter((e) => e.state === 'merged' && !e.retiredAt && !sharesBranchWithLater(v, e)
    && (!e.settledAt || settlementHolds(e.settlement)));

/**
 * Is `ref` the branch of an epoch that already reached trunk and that no open
 * epoch still uses? A PR based there can never reach trunk by merging: every
 * merge door refuses it and settlement moves it.
 */
export function shippedEpochOf(v: Pick<MissionEpochView, 'epochs'>, ref: string | null | undefined): EpochSnapshot | null {
  const r = ref?.trim();
  if (!r) return null;
  if (v.epochs.some((e) => e.state === 'open' && e.branch === r)) return null;
  return [...v.epochs].sort((a, b) => b.epoch - a.epoch).find((e) => e.state === 'merged' && e.branch === r) ?? null;
}

export type EpochStep =
  /** Create the open epoch's branch at `cutFromSha` (or confirm it is there). */
  | { step: 'cut_branch'; epochId: string; branch: string; fromSha: string | null }
  /** Settle the PRs left on a merged epoch's branch (again, while some are held). */
  | { step: 'settle'; epochId: string; branch: string; successorBranch: string | null }
  /** Delete a merged, settled epoch's branch (or confirm it is gone). */
  | { step: 'retire'; epochId: string; branch: string };

/**
 * The steps still owed, in order: cut the writable branch before anything is
 * moved onto it, settle before retiring, and never retire a branch a held PR
 * still needs or the writable epoch reuses (an adopted re-cut). Derived from
 * the rows, so a crash between a step and its record is redone, not lost.
 */
export function pendingEpochSteps(v: Pick<MissionEpochView, 'epochs'>): EpochStep[] {
  const out: EpochStep[] = [];
  const open = writableEpoch(v);
  if (open && !open.branchReadyAt && open.origin === 'cut') {
    out.push({ step: 'cut_branch', epochId: open.id, branch: open.branch, fromSha: open.cutFromSha });
  }
  const openReady = !open || open.origin !== 'cut' || !!open.branchReadyAt;
  for (const e of [...v.epochs].sort((a, b) => a.epoch - b.epoch)) {
    if (e.state !== 'merged' || e.retiredAt) continue;
    // A later epoch on the same branch (an adopted re-cut) owns that branch:
    // its settlement and its retirement. The earlier record owes nothing.
    if (sharesBranchWithLater(v, e)) continue;
    const successor = v.epochs.find((s) => s.predecessorId === e.id) ?? null;
    const held = settlementHolds(e.settlement);
    if ((!e.settledAt || held) && openReady) {
      out.push({ step: 'settle', epochId: e.id, branch: e.branch, successorBranch: successor?.branch ?? null });
    }
    if (e.settledAt && !held) out.push({ step: 'retire', epochId: e.id, branch: e.branch });
  }
  return out;
}

// ── What the writable epoch owes the outbox ─────────────────────────────────

/** Effects a mission epoch owes, drained apart from the PR deliveries' (they have no delivery row). */
export const EPOCH_EFFECT_KINDS = ['refresh_mission_branch'] as const;
export type EpochEffectKind = (typeof EPOCH_EFFECT_KINDS)[number];

/**
 * Who asked for a refresh. `start`: a mission task is being claimed, an
 * authorized start, so a paused or held mission is refreshed too. `backstop`:
 * unsolicited upkeep, which a paused, held or budget-exhausted mission never
 * gets (mission-branch-refresh.md, Eligibility).
 */
export type RefreshTrigger = 'start' | 'backstop';

/** Asks from one trigger inside this window owe one refresh between them (a burst of claims is one row). */
export const REFRESH_EFFECT_WINDOW_MS = 60_000;

export interface EpochEffectSpec {
  epochId: string;
  kind: EpochEffectKind;
  dedupeKey: string;
  payload: { branch: string; trigger: RefreshTrigger };
}

/**
 * The refresh the mission owes now, as one outbox row on its writable epoch:
 * merge trunk into that epoch's branch. A merged epoch owes none, nor does a
 * closed mission, a mission with no writable epoch, or a cut epoch whose
 * branch is not there yet (`cut_branch` is owed first, from the merge commit).
 * Time arrives on the call; the dedupe key folds every ask of one trigger in
 * one window into one row.
 */
export function owedRefresh(
  v: Pick<MissionEpochView, 'epochs' | 'terminal'>,
  p: { trigger: RefreshTrigger; nowMs: number },
): EpochEffectSpec | null {
  if (v.terminal) return null;
  const open = writableEpoch(v);
  if (!open) return null;
  if (open.origin === 'cut' && !open.branchReadyAt) return null;
  const window = Math.floor(p.nowMs / REFRESH_EFFECT_WINDOW_MS);
  return {
    epochId: open.id,
    kind: 'refresh_mission_branch',
    dedupeKey: `refresh_mission_branch:${open.id}:${p.trigger}:${window}`,
    payload: { branch: open.branch, trigger: p.trigger },
  };
}

/**
 * Is a claimed epoch effect still owed, read just before it runs? Only while
 * its epoch is the open one, on the branch it was owed for. A row queued
 * before the epoch merged is done as superseded, never run.
 */
export function epochEffectIsCurrent(
  epoch: Pick<EpochSnapshot, 'state' | 'branch'> | null,
  payload: { branch?: unknown },
): boolean {
  return !!epoch && epoch.state === 'open' && epoch.branch === payload.branch;
}

// ── When a delivery branch is finished ──────────────────────────────────────

/**
 * What the host read about an open delivery whose PR may have closed (task
 * fbc93ebd). Every field is a fresh read; a missing one is the cautious answer.
 */
export interface BranchFinishFacts {
  /** The delivery's PR, read from GitHub now, is closed and did not merge. */
  prClosedUnmerged: boolean;
  /** The merged PR recorded as carrying the closed PR's work (a supersession edge), if any. */
  supersededBy: number | null;
  /** Everything on the branch is already in trunk (a fresh content check); null when unread. */
  containedInTrunk: boolean | null;
  /** Another open PR from this branch into trunk: a successor delivery PR. */
  successorOpen: boolean;
}

export type FinishedReason =
  /** The mission is completed or archived. */
  | 'mission_terminal'
  /** The delivery's PR merged into trunk. */
  | 'shipped'
  /** A shipped delivery whose branch is confirmed gone. */
  | 'retired'
  /** The PR closed unmerged and its work is recorded as landed in another merged PR. */
  | 'superseded'
  /** The PR closed unmerged and everything on the branch is already in trunk. */
  | 'contained_in_trunk';

export type BranchFinished =
  | { finished: true; reason: FinishedReason; satisfiedByPr: number | null }
  | { finished: false; reason: 'branch_reused' | 'no_delivery_pr' | 'delivery_pr_live' | 'successor_open' | 'closed_work_unaccounted' };

/**
 * Is this delivery's branch finished: nothing will ever reach trunk from it
 * again, so a refresh onto it has nothing left to do?
 *
 * Closing the integration PR is not enough on its own: the branch is still the
 * mission's, a new PR can open from it, and a refresh onto it stays valid. It
 * is finished only when the mission is closed, the delivery shipped (or its
 * branch retired), or the closed PR was superseded with no successor: its
 * work is recorded as landed in another merged PR, or a content check shows
 * it is already in trunk, and no other PR from the branch into trunk is open.
 * `satisfiedByPr` is the merged PR that carries the branch's work, when one is
 * known. Pure: the host reads the facts.
 */
export function deliveryBranchFinished(
  v: Pick<MissionEpochView, 'terminal' | 'epochs'>,
  e: EpochSnapshot,
  facts: Partial<BranchFinishFacts> = {},
): BranchFinished {
  if (v.terminal) {
    return { finished: true, reason: 'mission_terminal', satisfiedByPr: e.state === 'merged' ? e.prNumber : facts.supersededBy ?? null };
  }
  if (e.retiredAt) return { finished: true, reason: 'retired', satisfiedByPr: e.prNumber };
  if (e.state === 'merged') {
    return sharesBranchWithLater(v, e) ? { finished: false, reason: 'branch_reused' } : { finished: true, reason: 'shipped', satisfiedByPr: e.prNumber };
  }
  if (e.prNumber == null) return { finished: false, reason: 'no_delivery_pr' };
  return openDeliveryFinished(facts);
}

/**
 * The open-delivery half of `deliveryBranchFinished`, for a delivery that has
 * a PR: a surface that holds only the PR's row (no epoch) asks this directly.
 */
export function openDeliveryFinished(facts: Partial<BranchFinishFacts>): BranchFinished {
  if (!facts.prClosedUnmerged) return { finished: false, reason: 'delivery_pr_live' };
  if (facts.successorOpen) return { finished: false, reason: 'successor_open' };
  if (facts.supersededBy != null) return { finished: true, reason: 'superseded', satisfiedByPr: facts.supersededBy };
  if (facts.containedInTrunk === true) return { finished: true, reason: 'contained_in_trunk', satisfiedByPr: null };
  return { finished: false, reason: 'closed_work_unaccounted' };
}

/** Why a finished branch is finished, as the clause after "the branch is finished:". */
export function finishedBranchWhy(f: Extract<BranchFinished, { finished: true }>, ctx: { prNumber: number | null; trunk: string }): string {
  const pr = ctx.prNumber != null ? `its PR #${ctx.prNumber}` : 'its PR';
  switch (f.reason) {
    case 'mission_terminal': return 'the mission is closed';
    case 'shipped': return `${pr} merged into \`${ctx.trunk}\``;
    case 'retired': return `${pr} merged into \`${ctx.trunk}\` and the branch is gone`;
    case 'superseded': return `${pr} closed without merging and its work landed in #${f.satisfiedByPr}`;
    case 'contained_in_trunk': return `${pr} closed without merging and everything on it is already in \`${ctx.trunk}\``;
  }
}

// ── Mission completion's input ──────────────────────────────────────────────

/**
 * What the epochs say about completion: the mission's integration work has
 * reached trunk only when no open epoch carries landed work. An open epoch
 * with nothing landed on it (just cut, or its work was cancelled) does not
 * hold completion. "A mission PR merged" is never sufficient on its own.
 */
export function epochCompletionHold(
  v: Pick<MissionEpochView, 'epochs'>,
  landedOnBranch: (branch: string, after: string | null) => number,
): { holds: false } | { holds: true; epoch: EpochSnapshot; landed: number; reason: 'unshipped_work' | 'unsettled' } {
  // A shipped delivery whose branch still has PRs to settle: their work has not reached trunk.
  const unsettled = unsettledEpochs(v)[0];
  if (unsettled) return { holds: true, epoch: unsettled, landed: 0, reason: 'unsettled' };
  const open = writableEpoch(v);
  if (!open) return { holds: false };
  const pred = open.predecessorId ? v.epochs.find((e) => e.id === open.predecessorId) ?? null : null;
  // A re-cut under the same name: only work that landed after the predecessor merged belongs to it.
  const after = pred && pred.branch === open.branch ? pred.mergedAt : null;
  const landed = landedOnBranch(open.branch, after);
  return landed > 0 ? { holds: true, epoch: open, landed, reason: 'unshipped_work' } : { holds: false };
}
