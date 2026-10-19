/**
 * The incident sequences of docs/specs/workflow-kernel-library.md as
 * conformance scenarios, so every host's adapter is proven against them and
 * not only the package's reducer tests: the #3787 double ingest of a merged
 * epoch, the #4663/#4670 refresh with unique work left on a merged branch,
 * the docs/specs/workflow-state-kernel.md §15 replay of #3754, and the whole
 * #4686 chain. Same contract as scenarios.ts: host-independent expectations,
 * assertions throw, no test runner imported.
 *
 * The epoch scenarios drive `reduceMissionEpochs` and apply its ops through
 * the host's `EpochHost`, re-reading and reducing again when a write loses,
 * the way buildd's `applyMissionEpochCommand` does.
 */
import type { CommandResult } from '../ports';
import {
  classifySettlement, pendingEpochSteps, reduceMissionEpochs, settlementHolds, writableEpoch,
  type EpochResult, type EpochSnapshot, type MissionEpochCommand, type MissionEpochView, type SettlementCandidate,
} from '../delivery-epochs';
import { deriveDeliveryView } from '../projections';
import { ConformanceFailure, Delivery, drainKernel, eq, fakePorts, type ConformanceHost, type ConformanceScenario } from './scenarios';

const AT = '2026-10-14T12:00:00.000Z';
const TRUNK = 'dev';

function ok(cond: unknown, label: string): void {
  if (!cond) throw new ConformanceFailure(label);
}

function pick<T extends object>(o: T | null | undefined, keys: Array<keyof T>): Partial<T> | null {
  if (!o) return null;
  return Object.fromEntries(keys.map((k) => [k, o[k]])) as Partial<T>;
}

function outcome(r: CommandResult): { result: string; reason?: string; to?: string } {
  return { result: r.result, ...('reason' in r ? { reason: r.reason } : {}), ...(r.result === 'applied' ? { to: r.decision.toState } : {}) };
}

function applied(r: CommandResult, to: string, label: string): void {
  eq(outcome(r), { result: 'applied', to }, label);
}

function notApplied(r: CommandResult, result: 'duplicate' | 'stale' | 'rejected', reason: string, label: string): void {
  eq(outcome(r), { result, reason }, label);
}

const evidenceOf = (r: CommandResult): Record<string, unknown> =>
  r.result === 'applied' ? (r.decision.evidence as Record<string, unknown>) : {};

// ── One mission's epochs, driven as a host drives them ──────────────────────

class Mission {
  missionId!: string;
  readonly root: string;
  /** What the host would count as work not yet on trunk. */
  work: MissionEpochView['work'] = { unfinishedTasks: 1, openTaskPrs: 0 };
  terminal = false;

  constructor(readonly host: ConformanceHost) {
    this.root = `mission/${host.uniqueRepo().replace(/[^a-z0-9-]/gi, '-')}`;
  }

  async seed(): Promise<this> {
    this.missionId = await this.host.epochs.seedMission(this.root);
    return this;
  }

  async view(): Promise<MissionEpochView> {
    const { integrationBranch, epochs } = await this.host.epochs.load(this.missionId);
    return { missionId: this.missionId, integrationBranch, terminal: this.terminal, scopeVersion: 1, epochs, work: this.work };
  }

  /** Reduce and apply one command; a lost write re-reads and reduces again. */
  async send(cmd: MissionEpochCommand): Promise<EpochResult> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = reduceMissionEpochs(await this.view(), cmd);
      if (r.result !== 'applied') return r;
      if (await this.host.epochs.apply(r.ops)) return r;
    }
    throw new ConformanceFailure(`${cmd.type} did not converge after four reads`);
  }

  async epochs(): Promise<EpochSnapshot[]> { return (await this.view()).epochs; }
  async epoch(n: number): Promise<EpochSnapshot> { return (await this.epochs()).find((e) => e.epoch === n)!; }

  adopt(): Promise<EpochResult> { return this.send({ type: 'Adopt', actor: 'test', at: AT }); }
  bind(prNumber: number, repo: string, ownerTaskId: string | null = null): Promise<EpochResult> {
    return this.send({ type: 'PrBound', actor: 'test', at: AT, prNumber, repoFullName: repo, ownerTaskId, headRef: this.root });
  }
  mergedCmd(prNumber: number, repo: string, mergeCommitSha: string): MissionEpochCommand {
    return { type: 'Merged', actor: 'webhook', at: AT, prNumber, repoFullName: repo, headRef: this.root, mergeCommitSha, mergedHeadSha: 'B1', mergedAt: AT };
  }
}

const res = (r: EpochResult) => ({ result: r.result, reason: r.reason });
const shape = (es: EpochSnapshot[]) => es.map((e) => pick(e, ['epoch', 'branch', 'state', 'origin', 'prNumber', 'cutFromSha', 'mergeCommitSha']));

// ── Scenarios ───────────────────────────────────────────────────────────────

export const INCIDENT_SCENARIOS: ConformanceScenario[] = [
  {
    name: '#3787 (AC-20): a merged epoch ingested twice, in turn and from one read, rotates to exactly one successor cut from the merge commit',
    async run(host) {
      const repo = host.uniqueRepo();
      const m = await new Mission(host).seed();
      eq(res(await m.adopt()), { result: 'applied', reason: 'adopted' }, 'the in-flight mission is adopted as epoch 1');
      eq(res(await m.bind(10, repo)), { result: 'applied', reason: 'pr_bound' }, 'its PR is bound');

      // Two webhook deliveries of the same merge read the mission before either writes.
      const before = await m.view();
      const a = reduceMissionEpochs(before, m.mergedCmd(10, repo, 'M10'));
      const b = reduceMissionEpochs(before, m.mergedCmd(10, repo, 'M10'));
      eq([res(a), res(b)], [{ result: 'applied', reason: 'merged_rotated' }, { result: 'applied', reason: 'merged_rotated' }], 'both reads decide to rotate');
      eq(await host.epochs.apply(a.ops), true, 'the first write applies');
      eq(await host.epochs.apply(b.ops), false, 'the second, from the same read, writes nothing (the epoch row\'s compare-and-set)');
      eq(res(await m.send(m.mergedCmd(10, repo, 'M10'))), { result: 'noop', reason: 'already_merged' }, 'the loser re-reads: already merged');
      eq(res(await m.send(m.mergedCmd(10, repo, 'M10'))), { result: 'noop', reason: 'already_merged' }, 'a later redelivery: already merged');

      const succ = `${m.root}-delivery-2`;
      eq(shape(await m.epochs()), [
        { epoch: 1, branch: m.root, state: 'merged', origin: 'adopted', prNumber: 10, cutFromSha: null, mergeCommitSha: 'M10' },
        { epoch: 2, branch: succ, state: 'open', origin: 'cut', prNumber: null, cutFromSha: 'M10', mergeCommitSha: null },
      ], 'one successor, cut from the merge commit');
      eq((await m.view()).integrationBranch, succ, 'the mission\'s branch moved to the successor in the same statement');
      eq((await m.epoch(2)).predecessorId, (await m.epoch(1)).id, 'the successor names the merged epoch');
      eq(pendingEpochSteps(await m.view()).map((s) => s.step), ['cut_branch'], 'the successor branch is owed before anything settles onto it');

      // The indexes refuse a second successor and a second open epoch however they are asked for.
      const e1 = await m.epoch(1);
      const again = { ...(await m.epoch(2)), epoch: 3, branch: `${m.root}-delivery-3` };
      const { id: _id, version: _v, settlement: _s, movedPrs: _mp, ...fields } = again;
      eq(await host.epochs.apply([{ op: 'insert', epoch: { ...fields, predecessorId: e1.id, state: 'merged' } }]), false, 'a second successor of epoch 1 is refused');
      eq(await host.epochs.apply([{ op: 'insert', epoch: { ...fields, predecessorId: null } }]), false, 'a second open epoch is refused');
      eq((await m.epochs()).length, 2, 'still two epochs');
    },
  },
  {
    name: '#4663/#4670 (AC-23): a refresh PR with unique work left on a merged epoch\'s branch is held, never retargeted to trunk, and keeps the branch until a person decides',
    async run(host) {
      const repo = host.uniqueRepo();
      const m = await new Mission(host).seed();
      await m.adopt();
      await m.bind(10, repo);
      eq(res(await m.send(m.mergedCmd(10, repo, 'M10'))), { result: 'applied', reason: 'merged_rotated' }, 'the epoch merges with work left');
      const succ = await m.epoch(2);
      eq(res(await m.send({ type: 'BranchReady', actor: 'test', at: AT, epochId: succ.id })), { result: 'applied', reason: 'branch_ready' }, 'the successor branch is cut');

      // GitHub deletes the merged branch and moves every PR on it to trunk.
      for (const n of [21, 22, 23]) {
        eq(res(await m.send({ type: 'PrMovedOff', actor: 'webhook:pull_request.edited', at: AT, branch: m.root, prNumber: n })), { result: 'applied', reason: 'pr_moved_recorded' }, `PR #${n} recorded as moved off the delivery`);
      }
      eq(res(await m.send({ type: 'PrMovedOff', actor: 'webhook:pull_request.edited', at: AT, branch: m.root, prNumber: 21 })), { result: 'noop', reason: 'already_recorded' }, 'a redelivered retarget is recorded once');
      eq((await m.epoch(1)).movedPrs, [21, 22, 23], 'the move is kept on the merged epoch');
      eq(pendingEpochSteps(await m.view()).map((s) => s.step), ['settle'], 'its settlement is owed');

      const candidates: SettlementCandidate[] = [
        { prNumber: 21, kind: 'refresh', baseRef: TRUNK, headSha: 'R21', contained: false },
        { prNumber: 22, kind: 'task', baseRef: TRUNK, headSha: 'T22', contained: false },
        { prNumber: 23, kind: 'refresh', baseRef: TRUNK, headSha: 'R23', contained: true },
      ];
      const classified = classifySettlement(candidates, { mergeCommitSha: 'M10', successorBranch: succ.branch });
      eq(classified.map((p) => [p.prNumber, p.disposition, p.target ?? null]), [
        [21, 'hold', null], [22, 'retarget', succ.branch], [23, 'close_redundant', null],
      ], 'the unique refresh is held, the task work moves to the successor, the shipped refresh closes');
      ok(classified.every((p) => p.target !== TRUNK), 'nothing is retargeted to trunk');
      const settlement = { settled: classified.filter((p) => p.disposition !== 'hold'), held: classified.filter((p) => p.disposition === 'hold'), satisfiedByPr: 10 };
      eq(res(await m.send({ type: 'Settled', actor: 'test', at: AT, epochId: (await m.epoch(1)).id, settlement })), { result: 'applied', reason: 'settled' }, 'the settlement is recorded');
      eq(res(await m.send({ type: 'Settled', actor: 'test', at: AT, epochId: (await m.epoch(1)).id, settlement })), { result: 'noop', reason: 'already_settled' }, 'the same settlement again writes nothing');

      const e1 = await m.epoch(1);
      eq((e1.settlement?.held ?? []).map((p) => p.prNumber), [21], 'the held refresh is on the record the host reads back');
      ok(settlementHolds(e1.settlement), 'the settlement holds the branch');
      eq(pendingEpochSteps(await m.view()).map((s) => s.step), ['settle'], 'no retirement is owed while a PR is held; it is settled again');
      eq(res(await m.send({ type: 'Retired', actor: 'test', at: AT, epochId: e1.id })), { result: 'rejected', reason: 'settlement_held' }, 'the branch is not deleted under the held PR');

      // A person closes the refresh: the next pass holds nothing, and the branch retires once.
      const decided = { ...settlement, held: [], settled: [...settlement.settled, { ...settlement.held[0]!, disposition: 'close_redundant' as const, reason: 'a person closed it' }] };
      eq(res(await m.send({ type: 'Settled', actor: 'test', at: AT, epochId: e1.id, settlement: decided })), { result: 'applied', reason: 'settled' }, 'the person\'s decision is recorded');
      eq(pendingEpochSteps(await m.view()).map((s) => s.step), ['retire'], 'now the branch may go');
      eq(res(await m.send({ type: 'Retired', actor: 'test', at: AT, epochId: e1.id })), { result: 'applied', reason: 'retired' }, 'retired');
      eq(res(await m.send({ type: 'Retired', actor: 'test', at: AT, epochId: e1.id })), { result: 'noop', reason: 'already_retired' }, 'retired once');
      eq(pendingEpochSteps(await m.view()), [], 'nothing owed');
    },
  },
  {
    name: '§15 (#3754): a fix that "succeeds" with its commit unpushed never re-reviews H1: AWAITING_PUSH, and the re-review of the reviewed head is rejected head_already_reviewed',
    async run(host) {
      // Steps 1–4: opened at H1, round 1 asks for changes, the fix is claimed.
      const upTo4 = async (pr: number) => {
        const s = await new Delivery(host, pr).open();
        applied(await s.push('H1'), 'WORKING', 'step 1: HeadObserved(H1)');
        eq(pick(await s.d(), ['state', 'currentHeadSha', 'prNumber']), { state: 'WORKING', currentHeadSha: 'H1', prNumber: pr }, 'step 1: PR bound at H1');
        applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'step 2: the builder attempt ends');
        eq(pick(await s.latestRound(), ['round', 'headSha', 'status']), { round: 1, headSha: 'H1', status: 'queued' }, 'step 2: round 1 at H1');
        applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'step 3: request changes');
        eq((await host.effects(s.deliveryId)).filter((e) => e.kind === 'post_review').map((e) => e.payload.commitId), ['H1'], 'step 3: posted at H1');
        ok((await s.effectKinds()).includes('dispatch_fix'), 'step 3: the fix is owed');
        return { s, fix: await s.startFix() };
      };
      const reReview = (s: Delivery, actor = 'kernel') => s.submit({ type: 'ReviewRequested', actor, headSha: 'H1', live: s.live('H1') });

      // Step 5: the worker committed L2 locally and reported success; GitHub still shows H1.
      const { s, fix } = await upTo4(3754);
      const r5 = await s.fixEnded(fix, { outcome: 'success', localHeadSha: 'L2', commitCount: 1, live: s.live('H1') });
      applied(r5, 'AWAITING_PUSH', 'step 5: FIXING → AWAITING_REVIEW is not reachable');
      eq((evidenceOf(r5).proof as { holds?: boolean } | undefined)?.holds, false, 'step 5: no proof that the head advanced');
      eq(pick((await s.view()).attempts.find((a) => a.id === fix), ['status', 'outcome']), { status: 'ended', outcome: 'unproven' }, 'step 5: the fix is unproven, not delivered');
      ok((await s.effectKinds()).includes('push_recovery'), 'step 5: push recovery is owed');
      const v5 = (await s.d()).version;

      // Step 6: the old code queued a second round at H1 after "fix ended".
      notApplied(await reReview(s), 'rejected', 'state_not_allowed', 'step 6: T5 is not allowed from AWAITING_PUSH');
      eq((await s.view()).rounds.length, 1, 'step 6: no round 2');
      // Step 7 (the PR body edited) is no command at all: nothing moved.
      eq((await s.d()).version, v5, 'steps 6–7: nothing written');

      // Step 8: recovery pushes L2.
      applied(await s.push('L2'), 'AWAITING_REVIEW', 'step 8: the pushed head is proof');
      eq(pick(await s.latestRound(), ['round', 'headSha', 'kind', 'status']), { round: 2, headSha: 'L2', kind: 'delta', status: 'queued' }, 'step 8: round 2 at L2, a delta from H1');
      // Step 10: approve L2, land pinned at L2, merged.
      applied(await s.verdict('approve'), 'APPROVED', 'step 10: approve L2');
      eq((await s.d()).approvedHeads, ['L2'], 'step 10: only L2 approved');
      applied(await s.land('L2'), 'LANDING', 'step 10: landing');
      eq((await host.effects(s.deliveryId)).filter((e) => e.kind === 'merge_call').map((e) => e.payload.headSha), ['L2'], 'step 10: merge pinned at L2');
      applied(await s.submit({ type: 'MergeCallResult', actor: 'kernel', headSha: 'L2', outcome: 'merged' }), 'LANDING', 'step 10: merge answer');
      applied(await s.merged('L2'), 'MERGED', 'step 10: merged');

      // Step 9 instead of 8: recovery cannot push; a person sees the branch.
      const nine = await upTo4(3755);
      await nine.s.fixEnded(nine.fix, { outcome: 'success', localHeadSha: 'L2', commitCount: 1, live: nine.s.live('H1') });
      applied(await nine.s.submit({ type: 'PushRecoveryExhausted', actor: 'kernel', localHeadSha: 'L2' }), 'ESCALATED', 'step 9: push recovery spent');
      eq((await nine.s.d()).stateReason, 'push_undeliverable', 'step 9: escalated as undeliverable, not "in review"');

      // Step 5 with the completion gate's refusal: the attempt ends without success, back to
      // CHANGES_REQUESTED; the re-review at H1 that followed is the one §15 rejects.
      const gated = await upTo4(3756);
      applied(await gated.s.fixEnded(gated.fix, { outcome: 'failed', localHeadSha: null, commitCount: 0, live: gated.s.live('H1') }), 'CHANGES_REQUESTED', 'step 5: delivery_not_advanced, the blocker stays');
      const vg = (await gated.s.d()).version;
      notApplied(await reReview(gated.s), 'rejected', 'head_already_reviewed', 'step 6: round 1 already decided at H1');
      notApplied(await reReview(gated.s, 'agent:fix'), 'rejected', 'head_already_reviewed', 'step 6: whoever asks');
      eq((await gated.s.view()).rounds.length, 1, 'step 6: no round 2, no second reviewer run');
      eq((await gated.s.d()).version, vg, 'step 6: nothing written');
      eq((await gated.s.d()).approvedHeads, [], 'nothing approved');
    },
  },
  {
    name: '#4686 end to end: the mission PR opens with a delivery, changes are requested, a coordination repair ends with no edits and is not accepted, a person merges on GitHub over it',
    async run(host) {
      // The mission PR opens: its epoch records the PR and the PR gets a kernel delivery (§6).
      const s = await new Delivery(host, 4686).open();
      const m = await new Mission(host).seed();
      await m.adopt();
      eq(res(await m.bind(s.prNumber, s.repo, s.ownerTaskId)), { result: 'applied', reason: 'pr_bound' }, 'the epoch records the mission PR');
      applied(await s.push('H1'), 'WORKING', 'its head is read');
      eq(pick(await s.d(), ['state', 'prNumber', 'repoFullName', 'currentHeadSha']), { state: 'WORKING', prNumber: 4686, repoFullName: s.repo, currentHeadSha: 'H1' }, 'the mission PR has a delivery');
      // Its coordination owner keeps running, so the PR is reviewed now (T5 from WORKING).
      applied(await s.submit({ type: 'ReviewRequested', actor: 'mission_pr:opened:coordination_owner', headSha: 'H1', live: s.live('H1') }), 'AWAITING_REVIEW', 'reviewed while the owner runs');

      applied(await s.verdictWith('request_changes', { findings: [{ path: 'src/header.tsx', title: 'the header copy says "Needs you"' }] }), 'CHANGES_REQUESTED', 'changes requested');
      eq(await s.findingStates(), { 'src/header.tsx': 'open' }, 'one open finding');

      // The coordination repair made no edits and has no verified no-op evidence: its completion
      // is refused (AC-19), so the attempt ends unproven rather than accepted.
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { outcome: 'unproven', localHeadSha: null, commitCount: 0, live: s.live('H1') }), 'CHANGES_REQUESTED', 'a repair with no edits is not accepted');
      eq(pick((await s.view()).attempts.find((a) => a.id === fix), ['status', 'outcome']), { status: 'ended', outcome: 'noop' }, 'shown as no change, and it counted');
      eq(await s.findingStates(), { 'src/header.tsx': 'open' }, 'the finding stays open');
      eq((await s.d()).approvedHeads, [], 'nothing approved');
      eq((await s.view()).rounds.map((r) => pick(r, ['headSha', 'verdict'])), [{ headSha: 'H1', verdict: 'request_changes' }], 'the verdict still stands');

      // A person merges on GitHub over the open finding.
      const merged = await s.submit({ type: 'PrMerged', actor: 'webhook', live: { ...s.mergedLive('H1'), mergedBy: 'a-person' } });
      applied(merged, 'MERGED', 'merged on GitHub');
      eq(pick(evidenceOf(merged), ['external', 'mergedBy', 'merged_over_open_findings', 'reviewClass']),
        { external: true, mergedBy: 'a-person', merged_over_open_findings: true, reviewClass: 'merged_over_verdict' }, 'recorded as merged over the open finding');
      eq(await s.findingStates(), { 'src/header.tsx': 'open' }, 'the finding is kept, still open');
      const f = fakePorts(host);
      await drainKernel(host, s, f.ports);
      const fixes = () => f.work.filed.filter((w) => w.role === 'external_merge_fix');
      eq(fixes().length, 1, 'one trunk fix filed');
      const owed = (await host.effects(s.deliveryId)).find((e) => e.kind === 'dispatch_external_merge_fix');
      eq((owed?.payload.findings as Array<{ path: string }> | undefined)?.map((x) => x.path), ['src/header.tsx'], 'the trunk fix names the finding');
      notApplied(await s.submit({ type: 'PrMerged', actor: 'webhook', live: { ...s.mergedLive('H1'), mergedBy: 'a-person' } }), 'duplicate', 'idempotency_key_seen', 'the webhook replayed');
      await drainKernel(host, s, f.ports);
      eq(fixes().length, 1, 'still one trunk fix');
      eq(pick(await s.d(), ['state', 'approvedHeads', 'approvalBasis']), { state: 'MERGED', approvedHeads: [], approvalBasis: null }, 'nothing approved');
      eq(deriveDeliveryView({ view: await s.view() })!.headline, 'Merged', 'shown as merged, never approved');

      // The same merge reaches the epoch: it is the delivery's record, and the work left rotates.
      eq(res(await m.send(m.mergedCmd(s.prNumber, s.repo, 'M1'))), { result: 'applied', reason: 'merged_rotated' }, 'the epoch merges');
      eq(shape(await m.epochs()).map((e) => [e!.epoch, e!.state, e!.prNumber]), [[1, 'merged', 4686], [2, 'open', null]], 'one merged record, one successor');
      eq((await m.epoch(1)).ownerTaskId, s.ownerTaskId, 'the epoch\'s PR is owned by the delivery\'s owner');
      eq(writableEpoch(await m.view())?.cutFromSha, 'M1', 'the successor starts from the merge');
    },
  },
];
