/**
 * Turn a recorded delivery back into the inputs the kernel saw, in order.
 *
 * Two kinds of step:
 *  - a FACT (`workflow_facts`): replayed through `ingestFact`, which re-derives
 *    the command itself; its live reads are answered from the fact payload.
 *  - a direct COMMAND (a transition with no fact behind it: a verdict, a fix
 *    dispatch, an attempt end, a CI failure...). The transition log stores the
 *    command's type, actor, idempotency key, evidence and bypass, not the
 *    command, so it is rebuilt from those plus the rows the same statement
 *    wrote. Where an input is not recorded anywhere and has to be read off the
 *    recorded outcome, the step lists it in `inferred`; where it cannot be
 *    rebuilt at all, `missing` says why and the replay stops there.
 *
 * Pure: no database, no clock.
 */
import type { Command, LivePr } from '../commands';
import type { AttemptSnapshot, KernelView } from '../types';
import type { CorpusDelivery, CorpusEffect, CorpusFact, CorpusTransition } from './corpus';

export type Step =
  | { kind: 'fact'; fact: CorpusFact; expected: CorpusTransition | null }
  | { kind: 'command'; expected: CorpusTransition };

/**
 * Facts that are not kernel input. `activity_note` is a legacy activity-log
 * entry diverted into the fact table (`divertNoteSql`, pr-activity-effects.ts):
 * it never reaches `ingestFact`, applies no transition and owes only a
 * `render:<delivery>:note:*` effect. Its key hashes the unsanitized entry, so
 * a replay could not reproduce it anyway. Not a step; counted in the report.
 */
export const OUT_OF_BAND_FACT_KINDS: ReadonlySet<string> = new Set(['activity_note']);

export function outOfBandFacts(c: CorpusDelivery): CorpusFact[] {
  return c.facts.filter((f) => OUT_OF_BAND_FACT_KINDS.has(f.kind));
}

/**
 * Provenance of an effect row: the transition's own decision, or a write that
 * came later and hung itself on it. The reducer's effects are inserted by the
 * same statement as the transition (kernel.ts, one `now()`), so they carry the
 * transition's exact `tUs`. Everything else attached to a transition is a later
 * statement: the drain's next `push_recovery` try (`insertFollowupEffectSql`),
 * the floor's owed effect (`enqueueEffectSql`, on the latest transition) and a
 * diverted note's render (`divertNoteSql`, likewise). None is reducer output.
 */
export function isDecisionEffect(e: CorpusEffect, t: CorpusTransition): boolean {
  return e.transitionId === t.id && e.tUs === t.tUs;
}

/** Effects some later statement attached to a recorded transition, in the order they were written. */
export function outOfBandEffects(c: CorpusDelivery): CorpusEffect[] {
  const byId = new Map(c.transitions.map((t) => [t.id, t]));
  return c.effects.filter((e) => { const t = byId.get(e.transitionId); return !t || !isDecisionEffect(e, t); }).sort((a, b) => a.tUs - b.tUs);
}

/** When a step's input arrived: the fact's observation, or the command's transition. */
export function stepTime(s: Step): number {
  return s.kind === 'fact' ? s.fact.tUs : s.expected.tUs;
}

/**
 * Recorded order: transitions by version; a fact applied by a transition is
 * that transition's step; an unapplied fact (duplicate, stale, rejected) sits
 * where it was observed, expecting no transition. Out-of-band facts are not
 * steps.
 */
export function buildSteps(c: CorpusDelivery): Step[] {
  const transitions = [...c.transitions].sort((a, b) => a.toVersion - b.toVersion);
  const byTransition = new Map<string, CorpusFact>();
  const loose: CorpusFact[] = [];
  for (const f of [...c.facts].sort((a, b) => a.tUs - b.tUs)) {
    if (OUT_OF_BAND_FACT_KINDS.has(f.kind)) continue;
    if (f.appliedTransitionId && transitions.some((t) => t.id === f.appliedTransitionId)) byTransition.set(f.appliedTransitionId, f);
    else loose.push(f);
  }
  const steps: Step[] = [];
  let li = 0;
  for (const t of transitions) {
    while (li < loose.length && loose[li].tUs < t.tUs) steps.push({ kind: 'fact', fact: loose[li++], expected: null });
    const f = byTransition.get(t.id);
    steps.push(f ? { kind: 'fact', fact: f, expected: t } : { kind: 'command', expected: t });
  }
  while (li < loose.length) steps.push({ kind: 'fact', fact: loose[li++], expected: null });
  return steps;
}

/** Ids the recorded statement allocated (rounds first, then attempts): one `now()`, one `tUs`. */
export function allocatedIds(c: CorpusDelivery, t: CorpusTransition): string[] {
  return [
    ...c.rounds.filter((r) => r.tUs === t.tUs).sort((a, b) => a.round - b.round).map((r) => r.id),
    ...c.attempts.filter((a) => a.tUs === t.tUs).sort((a, b) => a.attemptNo - b.attemptNo).map((a) => a.id),
  ];
}

/** The effects that answer a refused mechanical repair with `ConflictObserved{mechanicalRefused: true}`. */
const REFUSING_EFFECTS: ReadonlySet<string> = new Set(['effect:refresh_branch', 'effect:renumber_migration']);

const OPEN_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);
const ENDED_STATUSES: ReadonlySet<string> = new Set(['ended', 'cancelled', 'skipped']);

/** An attempt end the transition log does not carry, to write before a step. */
export interface OutOfBandAttemptEnd { attemptId: string; status: string; outcome: string | null; timed: boolean }

/**
 * Attempt rows the record shows ended by a statement that wrote no transition,
 * still open in the replay before the step at `beforeUs`. The case that has
 * one: a repair worker that ends after its attempt stopped being bound
 * (AttemptEnded `unbound`, reducer.ts) ends the row and is answered `stale`.
 *
 * With the recorded end time (`endedUs`): ended out of band when no recorded
 * transition shares that statement's `tUs`, and due once that time has passed.
 * Without it (a corpus exported before it was recorded) the time is unknown:
 * an `ended` row that was claimed (`running`) and that the replay no longer
 * binds is ended before the next step, the earliest the unbound path could
 * have written it, and the report lists it as inferred. A `queued` row that is
 * not bound is waiting for its claim (a review fix binds at FixClaimed), not
 * for an end. A cancellation or skip is always a transition's
 * write (`cancel_open`) and is left to that transition.
 */
export function outOfBandAttemptEnds(c: CorpusDelivery, view: KernelView, beforeUs: number): OutOfBandAttemptEnd[] {
  const statements = new Set(c.transitions.map((t) => t.tUs));
  const out: OutOfBandAttemptEnd[] = [];
  for (const a of c.attempts) {
    if (!ENDED_STATUSES.has(a.status)) continue;
    const replayed = view.attempts.find((x) => x.id === a.id);
    if (!replayed || !OPEN_STATUSES.has(replayed.status)) continue;
    const end = { attemptId: a.id, status: a.status, outcome: a.outcome };
    if (typeof a.endedUs === 'number') {
      if (!statements.has(a.endedUs) && a.endedUs < beforeUs) out.push({ ...end, timed: true });
    } else if (a.status === 'ended' && replayed.status === 'running' && view.delivery?.boundAttemptId !== a.id) {
      out.push({ ...end, timed: false });
    }
  }
  return out;
}

export interface ReconstructCtx {
  /** The replay's delivery as it stands before this step. */
  view: KernelView;
  corpus: CorpusDelivery;
  /** Recorded fact id → the id the replay's own fact got. */
  factIds: Map<string, string>;
}

export type Reconstructed = { ok: true; cmd: Command; inferred: string[] } | { ok: false; missing: string };

type J = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const liveChecksOf = (v: unknown): { complete: boolean; failing: string[] } | null => {
  const o = v as { complete?: unknown; failing?: unknown } | null;
  return o && typeof o === 'object' && typeof o.complete === 'boolean' && Array.isArray(o.failing) && o.failing.every((f) => typeof f === 'string')
    ? { complete: o.complete, failing: o.failing as string[] } : null;
};

/** `prefix:a:b:c` → ['a','b','c']; repo names and SHAs carry no colons. */
function keyParts(key: string, prefix: string): string[] | null {
  return key.startsWith(`${prefix}:`) ? key.slice(prefix.length + 1).split(':') : null;
}

/** The effects the transition's own statement wrote. */
function effectsOf(c: CorpusDelivery, t: CorpusTransition): CorpusEffect[] {
  return c.effects.filter((e) => isDecisionEffect(e, t));
}

/** A live read the transition only checked the head of: an open PR at that head. */
function synthLive(view: KernelView, headSha: string): LivePr {
  const d = view.delivery;
  return { state: 'open', merged: false, headSha, headRepoFullName: d?.repoFullName ?? null, baseRef: d?.baseRef ?? null };
}

/** The §9 inputs behind a recorded `deliveryProof` result. */
function proofInputs(proof: unknown): { liveContainsLocal: boolean; contentDiffChanged?: boolean } | undefined {
  const reason = str((proof as J | null)?.reason);
  if (reason === 'live_head_contains_local') return { liveContainsLocal: true };
  if (reason === 'head_advanced_content_changed') return { liveContainsLocal: false, contentDiffChanged: true };
  if (reason === 'live_head_missing_local') return { liveContainsLocal: false };
  if (reason === 'local_head_unknown') return { liveContainsLocal: false, contentDiffChanged: false };
  return undefined;
}

export function reconstructCommand(t: CorpusTransition, ctx: ReconstructCtx): Reconstructed {
  const { view, corpus } = ctx;
  const d = view.delivery;
  const E = t.evidence ?? {};
  const B = t.bypass ?? null;
  const actor = t.actor;
  const inferred: string[] = [];
  const ok = (cmd: Command): Reconstructed => ({ ok: true, cmd, inferred });
  const miss = (why: string): Reconstructed => ({ ok: false, missing: `${t.command}: ${why}` });
  const attemptRow = (id: unknown) => corpus.attempts.find((a) => a.id === id);
  const fx = effectsOf(corpus, t);
  const head = d?.currentHeadSha ?? null;

  switch (t.command) {
    case 'AttemptEnded': {
      const workerId = keyParts(t.idempotencyKey, 'end')?.join(':');
      if (!workerId || !d) return miss('no worker id in the key, or no delivery');
      const live = (E.live ?? null) as LivePr | null;
      const L = str(E.localHeadSha);
      const outcome = str(E.outcome) as 'success' | 'failed' | 'lost' | 'unproven' | null;
      if (!outcome) return miss('no outcome in evidence');
      let proof = proofInputs(E.proof);
      if (!proof && d.state === 'WORKING' && L && live && L !== live.headSha) {
        // The owner path does not record the compare answer; it is read off the outcome.
        proof = { liveContainsLocal: t.toState !== 'AWAITING_PUSH' };
        inferred.push('proof.liveContainsLocal');
      }
      const requeue = E.requeue === true;
      if (requeue) inferred.push('taskRetryBudgetLeft');
      return ok({
        type: 'AttemptEnded', actor, workerId, taskId: d.ownerTaskId, attemptId: d.boundAttemptId ?? undefined,
        outcome, localHeadSha: L, commitCount: num(E.commitCount) ?? 0, live,
        ...(proof ? { proof } : {}),
        ...(E.carryForward ? { carryForward: E.carryForward as 'content_equivalent' | 'own_refresh' } : {}),
        taskRetryBudgetLeft: requeue,
        reviewRequired: E.policy !== 'no_review',
        // e9f1674b: the hand-off's live check read; its budget is in the evidence only when it acted.
        ...(liveChecksOf(E.liveChecks) ? { ci: { liveChecks: liveChecksOf(E.liveChecks)!, signature: str(E.signature) ?? 'ci_failed', maxAttempts: num(E.max) ?? 0 } } : {}),
      });
    }
    case 'ReviewRequested': {
      const parts = keyParts(t.idempotencyKey, 'round');
      const h = parts?.[1];
      if (!h) return miss('no head in the key');
      return ok({ type: 'ReviewRequested', actor, headSha: h, live: synthLive(view, h), ...(B?.forced ? { forced: true } : {}) });
    }
    case 'ReviewVerdictRecorded': {
      const round = corpus.rounds.find((r) => r.id === E.roundId);
      if (!round || !E.verdict || !E.effectiveVerdict) return miss('no round or verdict');
      return ok({
        type: 'ReviewVerdictRecorded', actor, roundId: round.id, verdict: E.verdict as never, effectiveVerdict: E.effectiveVerdict as never,
        headBound: str(E.headSha) ?? round.headSha, confidence: round.confidence,
      });
    }
    case 'ReviewBudgetExhausted': return ok({ type: 'ReviewBudgetExhausted', actor });
    case 'FixDispatched': {
      const roundId = str(E.roundId);
      if (!roundId) return miss('no round');
      const a = attemptRow(E.attemptId);
      const human = E.trigger === 'human' || B?.trigger === 'human';
      const maxAttempts = num(E.max) ?? num(B?.budgetFrom) ?? a?.maxAttempts ?? null;
      if (maxAttempts == null) return miss('no attempt budget');
      const round = corpus.rounds.find((r) => r.id === roundId);
      const live = (E.live as LivePr | undefined) ?? (round ? synthLive(view, round.headSha) : null);
      if (!live) return miss('no live read');
      return ok({
        type: 'FixDispatched', actor, roundId, taskId: a?.taskId ?? `unallocated:${roundId}`, maxAttempts,
        ...(human ? { trigger: 'human' as const } : {}), revalidation: { live, newerApprove: false },
      });
    }
    case 'FixClaimed': {
      const attemptId = str(E.attemptId);
      const live = E.live as LivePr | undefined;
      if (!attemptId || !live) return miss('no attempt or live read');
      return ok({
        type: 'FixClaimed', actor, attemptId,
        revalidation: { live, approved: false, ciGreen: E.skipped === 'ci_green', conflictResolved: E.skipped === 'conflict_resolved' },
      });
    }
    case 'RepairNotNeeded': {
      const attemptId = str(E.attemptId);
      if (!attemptId) return miss('no attempt');
      return ok({ type: 'RepairNotNeeded', actor, attemptId, reason: str(E.skipped) ?? 'state_moved', live: (E.live ?? null) as LivePr | null });
    }
    case 'BudgetExtended': {
      if (!head) return miss('no head');
      return ok({
        type: 'BudgetExtended', actor, family: 'ci', headSha: head, signature: str(E.signature) ?? '',
        maxAttempts: num(E.budgetFrom) ?? 3, reason: str(B?.reason) ?? 'replay',
      });
    }
    case 'CiFailedObserved': {
      const parts = keyParts(t.idempotencyKey, 'ci');
      const h = parts?.[1];
      if (!h) return miss('no head in the key');
      const inserted = corpus.attempts.find((a) => a.tUs === t.tUs && a.family === 'ci');
      let maxAttempts = num(E.max) ?? inserted?.maxAttempts ?? null;
      if (maxAttempts == null) { maxAttempts = 3; inferred.push('maxAttempts'); }
      const triggerFactId = inserted?.triggerFactId ? ctx.factIds.get(inserted.triggerFactId) ?? null : null;
      return ok({
        type: 'CiFailedObserved', actor, headSha: h, signature: str(E.signature) ?? '', maxAttempts,
        preflightMiss: str(E.preflightMiss), trigger: inserted?.trigger === 'human' ? 'human' : 'automatic', triggerFactId,
        ...(liveChecksOf(E.liveChecks) ? { liveChecks: liveChecksOf(E.liveChecks) } : {}),
      });
    }
    case 'ConflictObserved': {
      const parts = keyParts(t.idempotencyKey, 'conflict');
      const h = parts?.[1];
      const kind = str(E.repairKind);
      if (!h || !kind) return miss('no head or repair kind');
      const inserted = corpus.attempts.find((a) => a.tUs === t.tUs);
      const effect = fx.find((e) => ['refresh_branch', 'renumber_migration', 'dispatch_conflict_fix', 'escalate_exhaustion'].includes(e.kind));
      const p = (effect?.payload ?? {}) as J;
      const mechanical = E.mode === 'mechanical';
      // Who sent it is recorded: a mechanical repair's own effect hands a refusal to an agent
      // (conflict-retry-effects.ts `refusedToAgent`, always mechanicalRefused), the door never does.
      // Only an actor neither says is read off the replay's ledger.
      const openMech = view.attempts.some((a: AttemptSnapshot) => a.mode === 'mechanical' && a.boundHeadSha === h && (a.status === 'queued' || a.status === 'running'));
      const refusedBy = REFUSING_EFFECTS.has(actor) ? true : actor.startsWith('door:') ? false : null;
      if (refusedBy == null && !mechanical) inferred.push('mechanicalRefused');
      const maxAgent = mechanical ? num(p.maxAgent) : num(p.maxAttempts) ?? (inserted?.mode === 'agent' ? inserted.maxAttempts : null) ?? num(p.attempts);
      if (maxAgent == null) inferred.push('maxAgentAttempts');
      return ok({
        type: 'ConflictObserved', actor, headSha: h,
        mergeable: kind === 'behind' ? 'behind' : 'dirty',
        migrationCollision: kind === 'migration',
        mechanicalRefused: !mechanical && (refusedBy ?? openMech),
        ...(mechanical && inserted ? { maxMechanical: inserted.maxAttempts } : {}),
        maxAgentAttempts: maxAgent ?? 3,
        refusal: (p.refusal ?? null) as J | null,
        detail: (p.detail ?? null) as J | null,
      });
    }
    case 'MechanicalRepairFailed': {
      const attemptId = str(E.attemptId);
      if (!attemptId) return miss('no attempt');
      return ok({ type: 'MechanicalRepairFailed', actor, attemptId, reason: str(E.reason) ?? '' });
    }
    case 'TreadmillCycleRestarted': return ok({ type: 'TreadmillCycleRestarted', actor });
    case 'HumanApproved': {
      if (!E.reviewId || !E.commitId) return miss('no review or commit');
      return ok({ type: 'HumanApproved', actor, reviewId: String(E.reviewId), commitId: String(E.commitId), hasMergePermission: true });
    }
    case 'LandingRequested': {
      const parts = keyParts(t.idempotencyKey, 'merge');
      const h = parts && parts.length >= 3 ? parts[parts.length - 2] : null;
      if (!h || !E.door || !E.rails) return miss('no head, door or rails');
      const call = fx.find((e) => e.kind === 'merge_call');
      return ok({
        type: 'LandingRequested', actor, door: String(E.door), headSha: h, live: synthLive(view, h),
        rails: E.rails as { passed: boolean },
        override: B ? { reason: str(B.reason) ?? '', ...(B.kinds ? { kinds: B.kinds as never } : {}), ...(B.grantedBy ? { grantedBy: String(B.grantedBy) } : {}) } : null,
        ...(call?.payload.mergeMethod ? { mergeMethod: call.payload.mergeMethod as 'merge' | 'squash' | 'rebase' } : {}),
      });
    }
    case 'MergeCallResult': {
      const parts = keyParts(t.idempotencyKey, 'mergeresult');
      const h = parts && parts.length >= 4 ? parts[parts.length - 3] : null;
      if (!h || !E.outcome) return miss('no head or outcome');
      return ok({
        type: 'MergeCallResult', actor, headSha: h, outcome: E.outcome as never,
        ...(E.detail != null ? { detail: String(E.detail) } : {}),
        ...(num(E.landingVersion) != null ? { landingVersion: num(E.landingVersion)! } : {}),
      });
    }
    case 'PrMerged':
    case 'PrReopened': {
      const live = E.live as LivePr | undefined;
      if (!live) return miss('no live read');
      return ok({ type: t.command, actor, live } as Command);
    }
    case 'PrClosedUnmerged': {
      const live = E.live as LivePr | undefined;
      if (!live) return miss('no live read');
      const cause = fx.map((e) => e.payload.closeCause).find((x) => typeof x === 'string');
      return ok({ type: 'PrClosedUnmerged', actor, live, closeCause: (cause ?? 'unknown') as never });
    }
    case 'SupersessionRecorded': {
      if (!E.target) return miss('no target');
      return ok({ type: 'SupersessionRecorded', actor, target: E.target as never, reason: str(E.reason) ?? '', authorised: true });
    }
    case 'Abandon': return ok({ type: 'Abandon', actor, reason: str(E.reason) ?? '' });
    case 'PushRecoveryExhausted': {
      // A later visit's chain names its entry version (`{L}@v{N}`, 10658a4c); the local head is before it.
      const local = (keyParts(t.idempotencyKey, 'pushdead')?.[1] ?? 'none').replace(/@v\d+$/, '');
      return ok({ type: 'PushRecoveryExhausted', actor, localHeadSha: local === 'none' ? null : local });
    }
    case 'EffectDead': {
      if (!E.effectId || !E.effectKind) return miss('no effect');
      return ok({
        type: 'EffectDead', actor, effectId: String(E.effectId), effectKind: E.effectKind as never,
        dedupeKey: String(E.dedupeKey ?? ''), lastError: str(E.lastError),
      });
    }
    case 'HumanResolve': {
      if (!B?.choice || !d) return miss('no choice in bypass');
      const choice = B.choice as 'approve' | 'request_changes' | 'apply_recommendation' | 'dismiss';
      const instr = fx.find((e) => e.kind === 'dispatch_fix')?.payload.humanInstructions;
      return ok({
        type: 'HumanResolve', actor, choice, expectedVersion: d.version,
        ...(B.reason != null ? { reason: String(B.reason) } : {}),
        ...(typeof instr === 'string' ? { instructions: instr } : {}),
        ...(choice === 'approve' ? { commitId: str(E.commitId) ?? undefined, hasMergePermission: true } : {}),
      });
    }
    case 'DeliveryFailed': {
      // The reason is only on the delivery row; the final row has it when FAILED is final.
      const reason = corpus.delivery.state === 'FAILED' ? corpus.delivery.stateReason : null;
      if (reason == null) return miss('the failure reason is not recorded');
      inferred.push('reason');
      return ok({ type: 'DeliveryFailed', actor, reason });
    }
    case 'TrunkRedObserved': {
      if (!E.incidentId || !head) return miss('no incident or head');
      return ok({ type: 'TrunkRedObserved', actor, incidentId: String(E.incidentId), signature: str(E.signature) ?? '', headSha: head, thresholdMet: true });
    }
    case 'TrunkRecovered': {
      if (!E.incidentId) return miss('no incident');
      return ok({
        type: 'TrunkRecovered', actor, incidentId: String(E.incidentId), baseStillRed: false,
        headPredatesFix: fx.some((e) => e.kind === 'refresh_branch'),
      });
    }
    case 'ReviewRoundFailed': {
      const roundId = str(E.roundId);
      if (!roundId || !E.reason) return miss('no round or reason');
      // The contract-retry cap is configuration, not recorded: read off where the round went.
      inferred.push('maxContractRetries');
      // A reviewer's failure carries its reviewer (the key's identity); a recording from before that, or a kernel-side one, does not.
      const reviewerTaskId = str(E.reviewerTaskId);
      return ok({
        type: 'ReviewRoundFailed', actor, roundId, reason: E.reason as never, maxContractRetries: t.toState === 'AWAITING_REVIEW' ? Number.MAX_SAFE_INTEGER : 0,
        ...(reviewerTaskId ? { reviewerTaskId } : {}),
      });
    }
    case 'PolicyEvidenceRecorded': {
      if (!E.policyEvidence) return miss('no policy evidence');
      return ok({ type: 'PolicyEvidenceRecorded', actor, evidence: E.policyEvidence as never });
    }
    default:
      // DeliveryOpened, PrBound, HeadObserved and CompositionAttested arrive as facts.
      return miss('only replayable from its fact, and no fact applied it');
  }
}
