/**
 * The workflow kernel's transition table as a pure function
 * (docs/specs/workflow-state-kernel.md §6). `reduce(view, command)` reads a
 * snapshot of one delivery (row, rounds, ledger) and returns exactly one of
 * `apply` (with the CAS guard, patch, round/ledger writes and effects the
 * kernel commits in one statement), `duplicate`, `stale` or `rejected`.
 *
 * No I/O: every GitHub fact a transition needs arrives inside the command
 * (R2: the caller took a live read after the hint). Ids for rows the statement
 * inserts are drawn from `opts.newId` so the same statement can bind them.
 *
 * DARK: no route calls this yet (Phase 2 part 1/3).
 */
import type {
  ApplyDecision,
  AttemptOp,
  Command,
  CurrentView,
  Decision,
  DeliveryPatch,
  EffectSpec,
  LivePr,
  RoundOp,
} from './commands';
import {
  isHumanActor,
  isTerminal,
  type AttemptFamily,
  type AttemptMode,
  type AttemptSnapshot,
  type CompositionAttestation,
  type ConstituentEvidence,
  type DeliverySnapshot,
  type DeliveryState,
  type KernelView,
  type RoundKind,
  type RoundSnapshot,
} from './types';

export interface ReduceOptions {
  newId?: () => string;
}

const NON_TERMINAL: DeliveryState[] = [
  'WORKING', 'AWAITING_PUSH', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'FIXING', 'REPAIRING',
  'BLOCKED_ON_TRUNK', 'APPROVED', 'LANDING', 'ESCALATED', 'CLOSED_UNMERGED',
];

/** Default bound on mechanical attempts per head (§6.7). */
export const DEFAULT_MAX_MECHANICAL = 2;
/** `push_recovery` backoff (§9): 2m, 10m, 30m, then T22. */
export const PUSH_RECOVERY_BACKOFF_MS = [120_000, 600_000, 1_800_000] as const;

// ── Pure helpers exported for callers and tests ─────────────────────────────

/**
 * §9 `deliveryProof`: a local commit is never delivery. The remote must have
 * moved off the bound head AND contain the attempt's work.
 */
export function deliveryProof(i: {
  boundHeadSha: string | null;
  localHeadSha: string | null;
  liveHeadSha: string | null;
  liveContainsLocal?: boolean;
  contentDiffChanged?: boolean;
}): { holds: boolean; reason: string } {
  if (!i.liveHeadSha) return { holds: false, reason: 'no_live_head' };
  if (i.liveHeadSha === i.boundHeadSha) return { holds: false, reason: 'head_not_advanced' };
  if (i.localHeadSha) {
    if (i.liveHeadSha === i.localHeadSha || i.liveContainsLocal === true) return { holds: true, reason: 'live_head_contains_local' };
    return { holds: false, reason: 'live_head_missing_local' };
  }
  // Runner died before reporting L: proof is (1) plus a changed content diff,
  // or a caller-verified containment.
  if (i.contentDiffChanged === true || i.liveContainsLocal === true) return { holds: true, reason: 'head_advanced_content_changed' };
  return { holds: false, reason: 'local_head_unknown' };
}

/** What covers `head` for landing. Ordinary verdicts are exact-head (plus recorded equivalents). */
export function headCoverage(d: Pick<DeliverySnapshot, 'approvedHeads' | 'approvalBasis' | 'compositionHeads'>, head: string | null):
  'verdict' | 'human' | 'composition' | 'none' {
  if (!head) return 'none';
  if (d.approvedHeads.includes(head)) return d.approvalBasis === 'human' ? 'human' : 'verdict';
  if (d.compositionHeads.includes(head)) return 'composition';
  return 'none';
}

/** §5.7 rule 4: the one 1-based "attempt N of M" view of a ledger family. */
export function attemptView(attempts: AttemptSnapshot[], family: AttemptFamily, defaultMax = 3): { n: number; m: number } {
  const rows = attempts.filter((a) => a.family === family && a.mode === 'agent' && a.status !== 'skipped');
  if (rows.length === 0) return { n: 0, m: defaultMax };
  const latest = rows.reduce((x, y) => (y.attemptNo > x.attemptNo ? y : x));
  return { n: latest.attemptNo, m: latest.maxAttempts };
}

/**
 * Mechanical check of a composition attestation (release / integration PR).
 * Each constituent's verdict must be bound to the head it was made on, be a
 * decided approve, and the change must have landed at that head or at a head
 * its own delivery recorded as equivalent. Nothing here lets the aggregate
 * head borrow a verdict: the result can only ever mark the head as
 * composition-covered.
 */
export function verifyCompositionAttestation(
  att: CompositionAttestation,
  evidence: ConstituentEvidence[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!att.aggregateHeadSha || !att.baseSha) reasons.push('aggregate_head_missing');
  if (att.aggregateHeadSha && att.aggregateHeadSha === att.baseSha) reasons.push('aggregate_equals_base');
  if (att.method !== 'tree_equal' && att.method !== 'patch_set_equal') reasons.push('method_not_mechanical');
  if (att.constituents.length === 0) reasons.push('no_constituents');
  const seen = new Set<string>();
  for (const c of att.constituents) {
    if (seen.has(c.roundId)) { reasons.push(`duplicate_constituent:${c.roundId}`); continue; }
    seen.add(c.roundId);
    const ev = evidence.find((e) => e.roundId === c.roundId);
    if (!ev) { reasons.push(`constituent_unresolved:${c.roundId}`); continue; }
    if (ev.roundHeadSha !== c.reviewedHeadSha) reasons.push(`constituent_head_mismatch:${c.roundId}`);
    if (ev.roundStatus !== 'decided' || ev.effectiveVerdict !== 'approve') reasons.push(`constituent_not_approved:${c.roundId}`);
    const unrecorded = c.equivalentHeadShas.filter((h) => !ev.deliveryApprovedHeads.includes(h));
    if (unrecorded.length > 0) reasons.push(`constituent_equivalence_unrecorded:${c.roundId}`);
    const landedOk = c.landedSha === c.reviewedHeadSha
      || (c.equivalentHeadShas.includes(c.landedSha) && ev.deliveryApprovedHeads.includes(c.landedSha));
    if (!landedOk) reasons.push(`constituent_landed_unproven:${c.roundId}`);
  }
  if (att.novelDelta.result === 'present' && att.novelDelta.paths.length === 0) reasons.push('novel_delta_paths_missing');
  return { ok: reasons.length === 0, reasons };
}

/**
 * Idempotency keys that depend only on the command (and the delivery's
 * identity), so a replay is recognised even after `version` moved (§7.4).
 * Commands whose key embeds mutable state (the next round number) return
 * null; their replays are answered by the reducer's own preconditions.
 */
export function stableIdempotencyKey(cmd: Command, d: DeliverySnapshot | null): string | null {
  const pr = d?.repoFullName && d.prNumber != null ? `${d.repoFullName}#${d.prNumber}` : null;
  switch (cmd.type) {
    case 'DeliveryOpened': return `open:${cmd.ownerTaskId}`;
    case 'PrBound': return `bind:${cmd.repoFullName}#${cmd.prNumber}`;
    case 'HeadObserved': return pr ? `head:${pr}:${cmd.live.headSha}` : null;
    case 'AttemptEnded': return `end:${cmd.workerId}`;
    case 'ReviewVerdictRecorded': return `verdict:${cmd.roundId}`;
    case 'FixClaimed': return `claim:${cmd.attemptId}`;
    case 'HumanApproved': return pr ? `approve:${pr}:${cmd.reviewId}` : null;
    case 'LandingRequested': return pr ? `merge:${pr}:${cmd.headSha}` : null;
    case 'MergeCallResult': return pr ? `mergeresult:${pr}:${cmd.headSha}:${cmd.outcome}` : null;
    case 'PrMerged': return pr ? `merged:${pr}` : null;
    case 'PrClosedUnmerged': return pr ? `closed:${pr}:${cmd.live.updatedAt ?? 'unknown'}` : null;
    case 'PrReopened': return pr ? `reopen:${pr}:${cmd.live.updatedAt ?? 'unknown'}` : null;
    case 'SupersessionRecorded': return pr ? `supersede:${pr}` : null;
    case 'Abandon': return pr ? `abandon:${pr}` : null;
    case 'DeliveryFailed': return d ? `fail:${d.ownerTaskId}` : null;
    case 'TrunkRedObserved': return d ? `trunk:${cmd.incidentId}:${d.id}` : null;
    case 'TrunkRecovered': return d ? `trunkok:${cmd.incidentId}:${d.id}` : null;
    case 'CompositionAttested': return d ? `compose:${d.id}:${cmd.attestation.aggregateHeadSha}` : null;
    default: return null;
  }
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export function currentOf(view: KernelView): CurrentView {
  const d = view.delivery;
  return { state: d?.state ?? null, version: d?.version ?? 0, head: d?.currentHeadSha ?? null, round: d?.currentRound ?? 0 };
}

const OPEN_ROUND = new Set(['queued', 'reviewing']);
const OPEN_ATTEMPT = new Set(['queued', 'running']);

class Ctx {
  readonly d: DeliverySnapshot | null;
  readonly did: string;
  constructor(readonly view: KernelView, readonly cmd: Command, readonly newId: () => string) {
    this.d = view.delivery;
    this.did = this.d?.id ?? `task:${(cmd as { ownerTaskId?: string }).ownerTaskId ?? (cmd as { adoption?: { ownerTaskId: string } }).adoption?.ownerTaskId ?? 'unknown'}`;
  }
  cur(): CurrentView { return currentOf(this.view); }
  rejected(reason: string, extra: { missing?: string[]; record?: { rounds: RoundOp[]; attempts: AttemptOp[] } } = {}): Decision {
    return { result: 'rejected', reason, current: this.cur(), ...extra };
  }
  stale(reason: string, record?: { rounds: RoundOp[]; attempts: AttemptOp[] }): Decision {
    return record ? { result: 'stale', reason, current: this.cur(), record } : { result: 'stale', reason, current: this.cur() };
  }
  duplicate(reason: string): Decision { return { result: 'duplicate', reason, current: this.cur() }; }

  get prKey(): string { return `${this.d?.repoFullName}#${this.d?.prNumber}`; }

  roundById(id: string): RoundSnapshot | undefined { return this.view.rounds.find((r) => r.id === id); }
  currentRound(): RoundSnapshot | undefined {
    const d = this.d; if (!d) return undefined;
    return this.view.rounds.find((r) => r.round === d.currentRound);
  }
  openRounds(): RoundSnapshot[] { return this.view.rounds.filter((r) => OPEN_ROUND.has(r.status)); }
  openRoundAt(head: string): RoundSnapshot | undefined { return this.openRounds().find((r) => r.headSha === head); }
  decidedAt(head: string): RoundSnapshot | undefined { return this.view.rounds.find((r) => r.headSha === head && r.status === 'decided'); }
  lastDecided(): RoundSnapshot | undefined {
    return this.view.rounds.filter((r) => r.status === 'decided').sort((a, b) => b.round - a.round)[0];
  }
  attempt(id: string | null | undefined): AttemptSnapshot | undefined { return id ? this.view.attempts.find((a) => a.id === id) : undefined; }
  ledger(family: AttemptFamily, mode: AttemptMode): AttemptSnapshot[] {
    return this.view.attempts.filter((a) => a.family === family && a.mode === mode);
  }
  nextNo(family: AttemptFamily, mode: AttemptMode): number {
    return this.ledger(family, mode).reduce((m, a) => Math.max(m, a.attemptNo), 0) + 1;
  }
  openAttempt(families: AttemptFamily[], head?: string | null): AttemptSnapshot | undefined {
    return this.view.attempts.find((a) => families.includes(a.family) && OPEN_ATTEMPT.has(a.status) && (head === undefined || a.boundHeadSha === head));
  }

  /** Supersede every open round and queue round r+1 bound to `head` (T5 / §6.4). */
  startRound(head: string, opts: { kind?: RoundKind; scope?: Record<string, unknown> | null } = {}): {
    rounds: RoundOp[]; effects: EffectSpec[]; patch: DeliveryPatch; roundNo: number; roundId: string;
  } {
    const d = this.d!;
    const last = this.lastDecided();
    const n = d.currentRound + 1;
    const kind: RoundKind = opts.kind ?? (last && last.headSha !== head ? 'delta' : 'full');
    const id = this.newId();
    const rounds: RoundOp[] = this.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } }));
    rounds.push({ op: 'insert', id, round: n, headSha: head, kind, priorRound: last?.round ?? null, scope: opts.scope ?? null });
    return {
      rounds,
      effects: [{ kind: 'dispatch_review', dedupeKey: `dispatch_review:${d.id}:${n}`, payload: { roundId: id, round: n, headSha: head, kind, priorRound: last?.round ?? null, scope: opts.scope ?? null } }],
      patch: { currentRound: n },
      roundNo: n,
      roundId: id,
    };
  }

  apply(key: string, toState: DeliveryState, o: {
    states?: DeliveryState[]; guardHead?: boolean; guardRound?: boolean;
    patch?: DeliveryPatch; rounds?: RoundOp[]; attempts?: AttemptOp[]; effects?: EffectSpec[];
    evidence?: Record<string, unknown>; bypass?: Record<string, unknown> | null;
    create?: ApplyDecision['create'];
  } = {}): ApplyDecision {
    const d = this.d;
    const version = d?.version ?? 0;
    const patch = o.patch ?? {};
    const effects = [...(o.effects ?? [])];
    const prBound = (patch.prNumber ?? d?.prNumber) != null;
    if (prBound) {
      // §12.1: the activity comment is regenerated from canonical state; one
      // render per version, the handler drops all but the newest.
      effects.push({ kind: 'render_activity', dedupeKey: `render:${this.did}:${version + 1}`, payload: { version: version + 1 } });
    }
    return {
      result: 'apply',
      command: this.cmd.type,
      idempotencyKey: key,
      create: o.create,
      fromState: d?.state ?? null,
      toState,
      guard: {
        version,
        states: o.states ?? (d ? [d.state] : []),
        ...(o.guardHead ? { headSha: d?.currentHeadSha ?? null } : {}),
        ...(o.guardRound ? { round: d?.currentRound ?? 0 } : {}),
      },
      patch,
      rounds: o.rounds ?? [],
      attempts: o.attempts ?? [],
      effects,
      evidence: { actor: this.cmd.actor, ...(o.evidence ?? {}) },
      bypass: o.bypass ?? null,
    };
  }

  pushRecovery(local: string | null, tryNo = 1): EffectSpec {
    return {
      kind: 'push_recovery',
      dedupeKey: `push_recovery:${this.did}:${local ?? 'none'}:${tryNo}`,
      payload: { localHeadSha: local, try: tryNo, maxTries: PUSH_RECOVERY_BACKOFF_MS.length },
      delayMs: PUSH_RECOVERY_BACKOFF_MS[Math.min(tryNo, PUSH_RECOVERY_BACKOFF_MS.length) - 1],
    };
  }
}

function livePrOpen(live: LivePr | null | undefined): boolean {
  return !!live && live.state === 'open' && !live.merged;
}

export function reduce(view: KernelView, cmd: Command, opts: ReduceOptions = {}): Decision {
  const c = new Ctx(view, cmd, opts.newId ?? (() => crypto.randomUUID()));
  const d = c.d;

  if (cmd.type !== 'DeliveryOpened' && !(cmd.type === 'PrBound' && cmd.adoption && !d)) {
    if (!d) return c.rejected('no_delivery');
    if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== d.version) return c.stale('version_moved');
  }

  switch (cmd.type) {
    // T1
    case 'DeliveryOpened': {
      if (d) return c.duplicate('delivery_exists');
      if (!cmd.requiresPr) return c.rejected('not_pr_deliverable');
      return c.apply(`open:${cmd.ownerTaskId}`, 'WORKING', {
        create: { workspaceId: cmd.workspaceId, ownerTaskId: cmd.ownerTaskId, maxRounds: cmd.maxRounds ?? 3 },
        states: [],
      });
    }

    // T2
    case 'PrBound': {
      const key = `bind:${cmd.repoFullName}#${cmd.prNumber}`;
      if (d && d.prNumber != null) {
        if (d.prNumber === cmd.prNumber && d.repoFullName === cmd.repoFullName) return c.duplicate('pr_already_bound_same');
        return c.rejected('pr_already_bound');
      }
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      if (cmd.live.headRepoFullName && cmd.live.headRepoFullName !== cmd.repoFullName) return c.rejected('fork_pr');
      const bindPatch: DeliveryPatch = { repoFullName: cmd.repoFullName, prNumber: cmd.prNumber, baseRef: cmd.live.baseRef };
      if (!d) {
        // Adoption: a PR buildd did not open gets a delivery and a first round.
        const a = cmd.adoption!;
        const roundId = c.newId();
        return c.apply(key, 'AWAITING_REVIEW', {
          create: { workspaceId: a.workspaceId, ownerTaskId: a.ownerTaskId, maxRounds: a.maxRounds ?? 3 },
          states: [],
          patch: { ...bindPatch, currentHeadSha: cmd.live.headSha, currentRound: 1 },
          rounds: [{ op: 'insert', id: roundId, round: 1, headSha: cmd.live.headSha, kind: 'full', priorRound: null }],
          effects: [{ kind: 'dispatch_review', dedupeKey: `dispatch_review:task:${a.ownerTaskId}:1`, payload: { roundId, round: 1, headSha: cmd.live.headSha, kind: 'full' } }],
          evidence: { live: cmd.live, adoption: true },
        });
      }
      if (d.state !== 'WORKING' && d.state !== 'AWAITING_PUSH') return c.rejected('state_not_allowed');
      return c.apply(key, d.state, { patch: bindPatch, evidence: { live: cmd.live } });
    }

    // T3 / T11 / T13 — §6.4
    case 'HeadObserved': return headObserved(c, cmd);

    // T4 — §6.5
    case 'AttemptEnded': return attemptEnded(c, cmd);

    // T5
    case 'ReviewRequested': {
      const dd = d!;
      const allowed: DeliveryState[] = ['WORKING', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'ESCALATED'];
      if (!allowed.includes(dd.state)) return c.rejected('state_not_allowed');
      if (dd.state === 'WORKING' && dd.prNumber == null) return c.rejected('pr_not_bound');
      if (cmd.headSha !== dd.currentHeadSha || cmd.live.headSha !== cmd.headSha) return c.rejected('round_head_not_current');
      if (c.openRoundAt(cmd.headSha)) return c.rejected('review_in_flight');
      if (cmd.forced && !(isHumanActor(cmd.actor) || cmd.actor === 'force')) return c.rejected('force_requires_human');
      if (c.decidedAt(cmd.headSha) && !cmd.forced) return c.rejected('head_already_reviewed');
      const r = c.startRound(cmd.headSha);
      const attempts: AttemptOp[] = dd.state === 'CHANGES_REQUESTED' ? [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }] : [];
      return c.apply(`round:${dd.id}:${cmd.headSha}:${r.roundNo}`, 'AWAITING_REVIEW', {
        guardHead: true, guardRound: true, patch: r.patch, rounds: r.rounds, attempts, effects: r.effects,
        bypass: cmd.forced ? { forced: true, actor: cmd.actor } : null,
      });
    }

    // T6
    case 'ReviewVerdictRecorded': {
      const dd = d!;
      const round = c.roundById(cmd.roundId);
      if (!round) return c.rejected('unknown_round');
      if (round.status === 'decided') {
        return round.verdict === cmd.verdict ? c.duplicate('verdict_already_recorded') : c.stale('round_closed');
      }
      if (cmd.headBound !== round.headSha) return c.rejected('verdict_head_mismatch');
      if (round.status === 'superseded' && round.verdict == null) {
        // The head moved while the reviewer ran: keep the verdict on its own round for audit.
        return c.stale('round_superseded', { rounds: [{
          op: 'update', roundId: round.id, whenStatus: ['superseded'],
          set: { verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, decided: true },
        }], attempts: [] });
      }
      if (!OPEN_ROUND.has(round.status)) return c.stale('round_closed');
      const keep: RoundOp = {
        op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'],
        set: { status: 'superseded', verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, decided: true },
      };
      if (dd.state !== 'AWAITING_REVIEW' || round.headSha !== dd.currentHeadSha || round.round !== dd.currentRound) {
        // A verdict for a superseded head/round: kept for audit, never applied.
        return c.stale('round_superseded', { rounds: [keep], attempts: [] });
      }
      const decide: RoundOp = {
        op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'],
        set: { status: 'decided', verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict, confidence: cmd.confidence ?? null, decided: true },
      };
      const key = `verdict:${round.id}`;
      const common = { guardHead: true, guardRound: true, evidence: { roundId: round.id, headSha: round.headSha, verdict: cmd.verdict, effectiveVerdict: cmd.effectiveVerdict } };
      const postReview = (event: 'APPROVE' | 'REQUEST_CHANGES'): EffectSpec => ({
        kind: 'post_review', dedupeKey: `post_review:${dd.id}:${round.id}`, payload: { commitId: round.headSha, event, roundId: round.id },
      });
      if (cmd.effectiveVerdict === 'approve') {
        return c.apply(key, 'APPROVED', {
          ...common,
          patch: { approvedHeads: [round.headSha], approvalBasis: 'verdict', stateReason: null },
          rounds: [decide],
          attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
          effects: [postReview('APPROVE'), { kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${dd.id}:${round.id}`, payload: { families: ['review_fix'], reason: 'approved' } }],
        });
      }
      if (cmd.effectiveVerdict === 'escalate') {
        return c.apply(key, 'ESCALATED', {
          ...common,
          patch: { stateReason: 'review_escalated' },
          rounds: [decide],
          effects: [{ kind: 'mission_note', dedupeKey: `mission_note:${dd.id}:${round.id}`, payload: { reason: 'review_escalated', roundId: round.id } }],
        });
      }
      if (dd.currentRound >= dd.maxRounds) {
        return c.apply(key, 'ESCALATED', {
          ...common,
          patch: { stateReason: 'review_exhausted' },
          rounds: [decide],
          effects: [postReview('REQUEST_CHANGES'), { kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:${round.headSha}`, payload: { family: 'review_fix', rounds: dd.currentRound } }],
        });
      }
      return c.apply(key, 'CHANGES_REQUESTED', {
        ...common,
        patch: { stateReason: null },
        rounds: [decide],
        effects: [postReview('REQUEST_CHANGES'), {
          kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${dd.id}:${round.id}:${c.nextNo('review_fix', 'agent')}`,
          payload: { roundId: round.id, round: round.round, headSha: round.headSha, attemptNo: c.nextNo('review_fix', 'agent') },
        }],
      });
    }

    // T7
    case 'ReviewBudgetExhausted': {
      const dd = d!;
      if (dd.state !== 'CHANGES_REQUESTED' && dd.state !== 'FIXING') return c.stale('state_moved');
      if (dd.currentRound < dd.maxRounds) return c.rejected('budget_not_exhausted');
      return c.apply(`exhaust:${dd.id}:${dd.currentHeadSha}`, 'ESCALATED', {
        patch: { stateReason: 'review_exhausted', boundAttemptId: null },
        effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:${dd.currentHeadSha}`, payload: { family: 'review_fix', rounds: dd.currentRound } }],
      });
    }

    // T8
    case 'FixDispatched': {
      const dd = d!;
      if (dd.state !== 'CHANGES_REQUESTED') return c.stale('state_moved');
      const round = c.roundById(cmd.roundId);
      if (!round || round.round !== dd.currentRound || round.headSha !== dd.currentHeadSha || round.effectiveVerdict !== 'request_changes') {
        return c.rejected('newer_verdict_supersedes_fix');
      }
      // §10.5 dispatch-time revalidation: nothing is allocated for a target that no longer needs work.
      if (!livePrOpen(cmd.revalidation.live)) return c.rejected('fix_not_needed', { missing: ['pr_open'] });
      if (cmd.revalidation.live.headSha !== round.headSha) return c.rejected('fix_not_needed', { missing: ['head_current'] });
      if (cmd.revalidation.newerApprove) return c.rejected('fix_not_needed', { missing: ['not_approved'] });
      const inflight = c.view.attempts.find((a) => a.family === 'review_fix' && a.triggerReason === round.id && OPEN_ATTEMPT.has(a.status));
      if (inflight) return c.duplicate('fix_in_flight');
      const n = c.nextNo('review_fix', 'agent');
      if (n > cmd.maxAttempts) return c.rejected('budget_exhausted');
      const id = c.newId();
      return c.apply(`fix:${dd.id}:${round.id}:${n}`, 'CHANGES_REQUESTED', {
        guardHead: true, guardRound: true,
        attempts: [{ op: 'insert', id, family: 'review_fix', attemptNo: n, mode: 'agent', boundHeadSha: round.headSha, triggerReason: round.id, taskId: cmd.taskId, trigger: 'automatic', status: 'queued', maxAttempts: cmd.maxAttempts }],
        evidence: { roundId: round.id, attemptId: id, attemptNo: n, live: cmd.revalidation.live },
      });
    }

    // T9
    case 'FixClaimed': {
      const dd = d!;
      const a = c.attempt(cmd.attemptId);
      if (!a || a.family !== 'review_fix') return c.rejected('unknown_attempt');
      if (dd.state === 'FIXING' && dd.boundAttemptId === a.id) return c.duplicate('already_claimed');
      if (dd.state !== 'CHANGES_REQUESTED') return c.stale('state_moved');
      if (a.status !== 'queued') return c.rejected('attempt_not_queued');
      const skip = (reason: string): Decision => c.rejected(reason, {
        record: { rounds: [], attempts: [{ op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'skipped', outcome: 'noop', ended: true } }] },
      });
      const round = c.currentRound();
      if (!round || a.triggerReason !== round.id || a.boundHeadSha !== dd.currentHeadSha) return skip('fix_superseded');
      if (!livePrOpen(cmd.revalidation.live) || cmd.revalidation.live.headSha !== a.boundHeadSha || cmd.revalidation.approved) return skip('fix_not_needed');
      return c.apply(`claim:${a.id}`, 'FIXING', {
        guardHead: true, guardRound: true,
        patch: { boundAttemptId: a.id },
        attempts: [{ op: 'update', attemptId: a.id, whenStatus: ['queued'], set: { status: 'running' } }],
        evidence: { attemptId: a.id, roundId: round.id, live: cmd.revalidation.live },
      });
    }

    // T10
    case 'CiFailedObserved': {
      const dd = d!;
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const allowed: DeliveryState[] = ['AWAITING_REVIEW', 'APPROVED', 'LANDING', 'CHANGES_REQUESTED'];
      if (!allowed.includes(dd.state)) return c.stale('state_not_allowed');
      if (cmd.openTrunkIncidentId) {
        return reduce(view, { type: 'TrunkRedObserved', actor: cmd.actor, incidentId: cmd.openTrunkIncidentId, signature: cmd.signature, headSha: cmd.headSha, thresholdMet: true }, opts);
      }
      const key = `ci:${dd.id}:${cmd.headSha}`;
      const ciPatch: DeliveryPatch = { ci: 'red', ciHeadSha: cmd.headSha };
      if (dd.state === 'CHANGES_REQUESTED') {
        // The owed review fix will push a new head; record the CI fact only.
        return c.apply(key, 'CHANGES_REQUESTED', { guardHead: true, patch: ciPatch, evidence: { signature: cmd.signature } });
      }
      if (c.openAttempt(['ci'], cmd.headSha)) return c.rejected('fix_in_flight');
      const n = c.nextNo('ci', 'agent');
      if (n > cmd.maxAttempts) {
        return c.apply(key, 'ESCALATED', {
          guardHead: true, patch: { ...ciPatch, stateReason: 'ci_exhausted' },
          effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${dd.id}:ci:${cmd.headSha}`, payload: { family: 'ci', attempts: n - 1 } }],
          evidence: { signature: cmd.signature },
        });
      }
      const id = c.newId();
      return c.apply(key, 'REPAIRING', {
        guardHead: true,
        patch: { ...ciPatch, stateReason: 'ci', boundAttemptId: id },
        attempts: [{ op: 'insert', id, family: 'ci', attemptNo: n, mode: 'agent', boundHeadSha: cmd.headSha, triggerReason: cmd.signature, triggerFactId: cmd.triggerFactId ?? null, taskId: null, trigger: cmd.trigger ?? 'automatic', status: 'queued', maxAttempts: cmd.maxAttempts }],
        effects: [{ kind: 'dispatch_ci_fix', dedupeKey: `dispatch_ci_fix:${dd.id}:${cmd.headSha}:${n}`, payload: { attemptId: id, attemptNo: n, headSha: cmd.headSha, signature: cmd.signature } }],
        evidence: { signature: cmd.signature, attemptNo: n },
      });
    }

    // T12
    case 'ConflictObserved': {
      const dd = d!;
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const allowed: DeliveryState[] = ['AWAITING_REVIEW', 'APPROVED', 'LANDING', 'CHANGES_REQUESTED', 'REPAIRING'];
      if (!allowed.includes(dd.state)) return c.stale('state_not_allowed');
      if (dd.state === 'REPAIRING' && !cmd.mechanicalRefused) return c.rejected('fix_in_flight');
      if (cmd.isDependencyBot) return c.rejected('dependency_bot_pr');
      const kind = cmd.migrationCollision ? 'migration' : cmd.mergeable === 'behind' ? 'behind' : 'conflict';
      return conflictRepair(c, cmd.headSha, kind, {
        key: `conflict:${dd.id}:${cmd.headSha}`,
        mechanicalRefused: cmd.mechanicalRefused === true,
        maxMechanical: cmd.maxMechanical ?? DEFAULT_MAX_MECHANICAL,
        maxAgent: cmd.maxAgentAttempts,
        patch: { mergeable: cmd.mergeable, mergeableHeadSha: cmd.headSha },
      });
    }

    // T14
    case 'HumanApproved': {
      const dd = d!;
      if (!['ESCALATED', 'CHANGES_REQUESTED', 'AWAITING_REVIEW'].includes(dd.state)) return c.stale('state_not_allowed');
      if (cmd.commitId !== dd.currentHeadSha) return c.stale('review_on_older_commit');
      if (!cmd.hasMergePermission) return c.rejected('no_merge_permission');
      return c.apply(`approve:${c.prKey}:${cmd.reviewId}`, 'APPROVED', {
        guardHead: true,
        patch: { approvedHeads: [cmd.commitId], approvalBasis: 'human', stateReason: null },
        attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
        effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:approve:${cmd.reviewId}`, payload: { event: 'human_approved', reviewId: cmd.reviewId } }],
        evidence: { reviewId: cmd.reviewId, commitId: cmd.commitId },
      });
    }

    // T15
    case 'LandingRequested': {
      const dd = d!;
      if (cmd.headSha !== dd.currentHeadSha || cmd.live.headSha !== cmd.headSha) return c.stale('head_moved');
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      const overrideDoor = cmd.door === 'dashboard_override' && !!cmd.override;
      if (dd.state !== 'APPROVED' && !(overrideDoor && (dd.state === 'CHANGES_REQUESTED' || dd.state === 'ESCALATED'))) return c.rejected('state_not_allowed');
      if (cmd.rails.redCi || cmd.rails.denyPaths) return c.rejected('rail_not_overridable', { missing: cmd.rails.reasons });
      if (!cmd.rails.passed && !overrideDoor) return c.rejected('rails_failed', { missing: cmd.rails.reasons });
      if (dd.state === 'APPROVED' && headCoverage(dd, cmd.headSha) === 'none') return c.rejected('head_not_approved');
      return c.apply(`merge:${c.prKey}:${cmd.headSha}`, 'LANDING', {
        guardHead: true,
        effects: [{ kind: 'merge_call', dedupeKey: `merge_call:${dd.id}:${cmd.headSha}`, payload: { headSha: cmd.headSha, door: cmd.door } }],
        evidence: { door: cmd.door, coverage: headCoverage(dd, cmd.headSha), rails: cmd.rails },
        bypass: overrideDoor ? { door: cmd.door, reason: cmd.override!.reason, actor: cmd.actor } : null,
      });
    }

    // T16
    case 'MergeCallResult': {
      const dd = d!;
      if (dd.state !== 'LANDING') return c.stale('state_moved');
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const key = `mergeresult:${c.prKey}:${cmd.headSha}:${cmd.outcome}`;
      if (cmd.outcome === 'merged' || cmd.outcome === 'indeterminate') {
        // The merged fact comes from a live read (verify_merge → PrMerged), never from this response.
        return c.apply(key, 'LANDING', {
          guardHead: true,
          effects: [{ kind: 'verify_merge', dedupeKey: `verify_merge:${dd.id}:${cmd.headSha}:${cmd.outcome}`, payload: { headSha: cmd.headSha } }],
          evidence: { outcome: cmd.outcome, detail: cmd.detail ?? null },
        });
      }
      if (cmd.outcome === 'refused') {
        return c.apply(key, 'ESCALATED', {
          guardHead: true, patch: { stateReason: 'landing_needs_human' },
          effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:landing:${cmd.headSha}`, payload: { event: 'landing_needs_human', detail: cmd.detail ?? null } }],
          evidence: { outcome: cmd.outcome, detail: cmd.detail ?? null },
        });
      }
      return conflictRepair(c, cmd.headSha, cmd.outcome, {
        key, mechanicalRefused: false, maxMechanical: DEFAULT_MAX_MECHANICAL, maxAgent: 3, patch: {},
      });
    }

    // T17
    case 'PrMerged': {
      const dd = d!;
      if (dd.state === 'MERGED') return c.duplicate('already_merged');
      if (isTerminal(dd.state)) return c.stale('terminal');
      if (!cmd.live.merged) return c.rejected('not_merged');
      const mergedHead = cmd.live.headSha;
      const coverage = headCoverage(dd, mergedHead);
      const rc = c.view.rounds.some((r) => r.headSha === mergedHead && r.status === 'decided' && r.effectiveVerdict === 'request_changes');
      const reviewClass = coverage !== 'none' ? `covered:${coverage}` : rc ? 'merged_over_verdict' : 'merged_unreviewed';
      const fx = (kind: EffectSpec['kind']): EffectSpec => ({ kind, dedupeKey: `${kind}:${dd.id}:merged`, payload: { mergeCommitSha: cmd.live.mergeCommitSha ?? null } });
      return c.apply(`merged:${c.prKey}`, 'MERGED', {
        states: NON_TERMINAL,
        patch: { mergedAt: cmd.live.mergedAt ?? null, mergeCommitSha: cmd.live.mergeCommitSha ?? null, boundAttemptId: null, resumeState: null },
        rounds: c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } })),
        attempts: [{ op: 'cancel_open', families: ['review_fix', 'ci', 'conflict', 'migration'], status: 'cancelled' }],
        effects: [fx('stamp_pr_rows'), fx('cancel_open_attempts'), fx('emit_pr_merged'), fx('wake_mission'), fx('release_attribution'), fx('finalize_mission_pr')],
        evidence: { live: cmd.live, reviewClass },
      });
    }

    // T18
    case 'PrClosedUnmerged': {
      const dd = d!;
      if (dd.state === 'CLOSED_UNMERGED') return c.duplicate('already_closed');
      if (isTerminal(dd.state)) return c.stale('terminal');
      if (cmd.live.state !== 'closed' || cmd.live.merged) return c.rejected('not_closed_unmerged');
      const fx = (kind: EffectSpec['kind']): EffectSpec => ({ kind, dedupeKey: `${kind}:${dd.id}:closed:${cmd.live.updatedAt ?? 'unknown'}`, payload: { closeCause: cmd.closeCause } });
      return c.apply(`closed:${c.prKey}:${cmd.live.updatedAt ?? 'unknown'}`, 'CLOSED_UNMERGED', {
        states: NON_TERMINAL,
        patch: { stateReason: cmd.closeCause, boundAttemptId: null, resumeState: null },
        rounds: c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } })),
        attempts: [{ op: 'cancel_open', families: ['review_fix', 'ci', 'conflict', 'migration'], status: 'cancelled' }],
        effects: [fx('cancel_open_attempts'), fx('scan_supersession'), fx('mission_note'), fx('stamp_pr_rows')],
        evidence: { live: cmd.live },
      });
    }

    // T19
    case 'PrReopened': {
      const dd = d!;
      if (dd.state !== 'CLOSED_UNMERGED') return isTerminal(dd.state) ? c.stale('terminal') : c.duplicate('not_closed');
      if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
      const head = cmd.live.headSha;
      const r = c.startRound(head);
      return c.apply(`reopen:${c.prKey}:${cmd.live.updatedAt ?? 'unknown'}`, 'AWAITING_REVIEW', {
        patch: { ...r.patch, currentHeadSha: head, stateReason: null }, rounds: r.rounds, effects: r.effects, evidence: { live: cmd.live },
      });
    }

    // T20
    case 'SupersessionRecorded': {
      const dd = d!;
      if (dd.state === 'SUPERSEDED') {
        return dd.supersededByPr === cmd.target.prNumber ? c.duplicate('edge_exists_same') : c.rejected('edge_exists');
      }
      if (dd.state !== 'CLOSED_UNMERGED') return c.rejected('not_closed_unmerged');
      if (cmd.target.prNumber === dd.prNumber && cmd.target.repoFullName === dd.repoFullName) return c.rejected('same_pr');
      if (!cmd.target.merged) return c.rejected('target_not_merged');
      if (!cmd.authorised) return c.rejected('not_authorised');
      if (!cmd.reason.trim()) return c.rejected('reason_required');
      return c.apply(`supersede:${c.prKey}`, 'SUPERSEDED', {
        patch: { supersededByPr: cmd.target.prNumber, supersededByUrl: cmd.target.url, supersededReason: cmd.reason, recordedBy: cmd.actor },
        effects: [
          { kind: 'project_supersession', dedupeKey: `project_supersession:${dd.id}`, payload: { target: cmd.target } },
          { kind: 'wake_mission', dedupeKey: `wake_mission:${dd.id}:superseded`, payload: {} },
        ],
        evidence: { target: cmd.target, reason: cmd.reason },
      });
    }

    // T21
    case 'Abandon': {
      const dd = d!;
      if (dd.state === 'ABANDONED') return c.duplicate('already_abandoned');
      if (dd.state !== 'CLOSED_UNMERGED') return c.rejected('not_closed_unmerged');
      if (!isHumanActor(cmd.actor)) return c.rejected('human_required');
      if (!cmd.reason.trim()) return c.rejected('reason_required');
      return c.apply(`abandon:${c.prKey}`, 'ABANDONED', {
        patch: { stateReason: cmd.reason },
        effects: [{ kind: 'wake_mission', dedupeKey: `wake_mission:${dd.id}:abandoned`, payload: {} }],
        evidence: { reason: cmd.reason },
      });
    }

    // T22
    case 'PushRecoveryExhausted': {
      const dd = d!;
      if (dd.state !== 'AWAITING_PUSH') return c.stale('state_moved');
      return c.apply(`pushdead:${dd.id}:${cmd.localHeadSha ?? 'none'}`, 'ESCALATED', {
        patch: { stateReason: 'push_undeliverable' },
        effects: [{ kind: 'notify', dedupeKey: `notify:${dd.id}:pushdead:${cmd.localHeadSha ?? 'none'}`, payload: { event: 'push_undeliverable', localHeadSha: cmd.localHeadSha, baseRef: dd.baseRef } }],
      });
    }

    // T23
    case 'HumanResolve': {
      const dd = d!;
      if (dd.state !== 'ESCALATED') return c.stale('state_moved');
      if (!isHumanActor(cmd.actor)) return c.rejected('human_required');
      if (cmd.expectedVersion === undefined) return c.rejected('expected_version_required');
      const key = `resolve:${dd.id}:${dd.version}`;
      const bypass = { choice: cmd.choice, reason: cmd.reason ?? null, actor: cmd.actor, escalation: dd.stateReason };
      if (cmd.choice === 'approve') {
        if (!dd.currentHeadSha) return c.rejected('no_head');
        return c.apply(key, 'APPROVED', { patch: { approvedHeads: [dd.currentHeadSha], approvalBasis: 'human', stateReason: null }, bypass });
      }
      if (cmd.choice === 'dismiss') {
        if (!cmd.reason?.trim()) return c.rejected('reason_required');
        if (!dd.currentHeadSha) return c.rejected('no_head');
        const r = c.startRound(dd.currentHeadSha, { kind: 'full' });
        return c.apply(key, 'AWAITING_REVIEW', { patch: { ...r.patch, stateReason: null }, rounds: r.rounds, effects: r.effects, bypass });
      }
      const round = c.currentRound();
      return c.apply(key, 'CHANGES_REQUESTED', {
        patch: { stateReason: null, boundAttemptId: null },
        effects: [{
          kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${dd.id}:${round?.id ?? 'none'}:human:${dd.version}`,
          payload: { roundId: round?.id ?? null, round: dd.currentRound, headSha: dd.currentHeadSha, trigger: 'human', choice: cmd.choice },
        }],
        bypass,
      });
    }

    // T24
    case 'DeliveryFailed': {
      const dd = d!;
      if (dd.state === 'FAILED') return c.duplicate('already_failed');
      if (dd.state !== 'WORKING' && dd.state !== 'AWAITING_PUSH') return c.rejected('state_not_allowed');
      if (dd.prNumber != null) return c.rejected('pr_bound');
      return c.apply(`fail:${dd.ownerTaskId}`, 'FAILED', { patch: { stateReason: cmd.reason, boundAttemptId: null } });
    }

    // T25
    case 'TrunkRedObserved': {
      const dd = d!;
      if (dd.state === 'BLOCKED_ON_TRUNK') return dd.trunkIncidentId === cmd.incidentId ? c.duplicate('already_blocked') : c.stale('blocked_on_other_incident');
      if (cmd.headSha !== dd.currentHeadSha) return c.stale('head_not_current');
      const allowed = dd.state === 'AWAITING_REVIEW' || dd.state === 'APPROVED' || dd.state === 'LANDING' || (dd.state === 'REPAIRING' && dd.stateReason === 'ci');
      if (!allowed) return c.stale('state_not_allowed');
      if (!cmd.thresholdMet) return c.rejected('threshold_not_met');
      const covered = headCoverage(dd, dd.currentHeadSha) !== 'none';
      const resume: DeliveryState = dd.state === 'LANDING' ? 'APPROVED'
        : dd.state === 'REPAIRING' ? (covered ? 'APPROVED' : 'AWAITING_REVIEW')
          : dd.state;
      return c.apply(`trunk:${cmd.incidentId}:${dd.id}`, 'BLOCKED_ON_TRUNK', {
        guardHead: true,
        patch: { resumeState: resume, trunkIncidentId: cmd.incidentId, stateReason: cmd.signature, boundAttemptId: null, ci: 'red', ciHeadSha: cmd.headSha },
        attempts: [{ op: 'cancel_open', families: ['ci'], status: 'skipped' }],
        effects: [
          // One trunk fix per incident, never per PR: the key carries no delivery.
          { kind: 'dispatch_trunk_fix', dedupeKey: `dispatch_trunk_fix:${cmd.incidentId}`, payload: { incidentId: cmd.incidentId, signature: cmd.signature } },
          { kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${dd.id}:trunk:${cmd.incidentId}`, payload: { families: ['ci'], reason: 'blocked_on_trunk' } },
        ],
        evidence: { incidentId: cmd.incidentId, signature: cmd.signature },
      });
    }

    // T26
    case 'TrunkRecovered': {
      const dd = d!;
      if (dd.state !== 'BLOCKED_ON_TRUNK' || dd.trunkIncidentId !== cmd.incidentId) return c.stale('not_blocked_on_incident');
      if (cmd.baseStillRed) return c.rejected('trunk_still_red');
      const resume = dd.resumeState ?? 'AWAITING_REVIEW';
      const head = dd.currentHeadSha;
      const effects: EffectSpec[] = cmd.headPredatesFix && head
        ? [{ kind: 'refresh_branch', dedupeKey: `refresh_branch:${dd.id}:${head}:trunk:${cmd.incidentId}`, payload: { headSha: head, reason: 'trunk_recovered' } }]
        : [];
      let patch: DeliveryPatch = { resumeState: null, trunkIncidentId: null, stateReason: null, ci: null, ciHeadSha: null };
      let rounds: RoundOp[] = [];
      if (resume === 'AWAITING_REVIEW' && head && !c.openRoundAt(head) && !c.decidedAt(head)) {
        const r = c.startRound(head);
        patch = { ...patch, ...r.patch }; rounds = r.rounds; effects.push(...r.effects);
      }
      return c.apply(`trunkok:${cmd.incidentId}:${dd.id}`, resume, { patch, rounds, effects, evidence: { incidentId: cmd.incidentId } });
    }

    // T27
    case 'ReviewRoundFailed': {
      const dd = d!;
      if (dd.state !== 'AWAITING_REVIEW') return c.stale('state_moved');
      const round = c.roundById(cmd.roundId);
      if (!round || !OPEN_ROUND.has(round.status) || round.round !== dd.currentRound) return c.stale('round_not_current');
      const n = round.failureCount + 1;
      const key = `roundfail:${round.id}:${n}`;
      const gate: EffectSpec = { kind: 'gate_event', dedupeKey: `gate_event:${round.id}:${n}`, payload: { slug: 'review_round_failed', reason: cmd.reason, failure: n } };
      if (n <= cmd.maxContractRetries) {
        // Re-queued at the same head with the same round number — never a new round.
        return c.apply(key, 'AWAITING_REVIEW', {
          guardRound: true,
          rounds: [{ op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'], set: { status: 'queued', failureCount: n, clearReviewer: true } }],
          effects: [{ kind: 'dispatch_review', dedupeKey: `dispatch_review:${dd.id}:${round.round}:retry${n}`, payload: { roundId: round.id, round: round.round, headSha: round.headSha, kind: round.kind, retry: n } }, gate],
          evidence: { roundId: round.id, reason: cmd.reason },
        });
      }
      return c.apply(key, 'ESCALATED', {
        guardRound: true,
        patch: { stateReason: 'review_unavailable' },
        rounds: [{ op: 'update', roundId: round.id, whenStatus: ['queued', 'reviewing'], set: { status: 'failed', failureCount: n } }],
        effects: [gate],
        evidence: { roundId: round.id, reason: cmd.reason },
      });
    }

    // Composition attestation (release / integration PR built from reviewed changes)
    case 'CompositionAttested': {
      const dd = d!;
      const att = cmd.attestation;
      if (att.repoFullName !== dd.repoFullName || att.prNumber !== dd.prNumber) return c.rejected('attestation_pr_mismatch');
      if (att.aggregateHeadSha !== dd.currentHeadSha) return c.stale('head_not_current');
      if (dd.state !== 'AWAITING_REVIEW') return c.stale('state_not_allowed');
      if (att.novelDelta.result === 'unverifiable') return c.rejected('composition_unverifiable', { missing: [att.novelDelta.reason] });
      const v = verifyCompositionAttestation(att, cmd.constituents);
      if (!v.ok) return c.rejected('composition_not_verified', { missing: v.reasons });
      const evidence = {
        factId: cmd.factId ?? null,
        method: att.method,
        baseSha: att.baseSha,
        aggregateHeadSha: att.aggregateHeadSha,
        constituents: att.constituents.map((x) => ({ roundId: x.roundId, prNumber: x.prNumber, reviewedHeadSha: x.reviewedHeadSha, landedSha: x.landedSha })),
        novelDelta: att.novelDelta,
      };
      const key = `compose:${dd.id}:${att.aggregateHeadSha}`;
      if (att.novelDelta.result === 'none') {
        // Covered by composition, NOT by a verdict: approved_heads is untouched
        // and no round is decided at this head.
        return c.apply(key, 'APPROVED', {
          guardHead: true,
          patch: { compositionHeads: [...dd.compositionHeads, att.aggregateHeadSha], approvalBasis: 'composition', stateReason: null },
          rounds: c.openRounds().map((r) => ({ op: 'update', roundId: r.id, whenStatus: ['queued', 'reviewing'], set: { status: 'superseded' } })),
          evidence,
        });
      }
      const r = c.startRound(att.aggregateHeadSha, { kind: 'delta', scope: { novelDeltaPaths: att.novelDelta.paths, composition: true } });
      return c.apply(key, 'AWAITING_REVIEW', { guardHead: true, guardRound: true, patch: r.patch, rounds: r.rounds, effects: r.effects, evidence });
    }
  }
}

// ── T3 ──────────────────────────────────────────────────────────────────────

function headObserved(c: Ctx, cmd: Extract<Command, { type: 'HeadObserved' }>): Decision {
  const d = c.d!;
  if (isTerminal(d.state)) return c.stale('terminal');
  if (d.prNumber == null) return c.rejected('pr_not_bound');
  if (!livePrOpen(cmd.live)) return c.rejected('pr_not_open');
  const h = cmd.live.headSha; // §6.3: the live head, never the payload head.
  if (h === d.currentHeadSha) return c.duplicate('head_unchanged');
  const key = `head:${c.prKey}:${h}`;
  const evidence = { live: cmd.live, hintedHeadSha: cmd.hintedHeadSha ?? null, previousHead: d.currentHeadSha };
  const record = (): Decision => c.apply(key, d.state, { patch: { currentHeadSha: h }, evidence });
  const toReview = (extra: { attempts?: AttemptOp[]; effects?: EffectSpec[]; patch?: DeliveryPatch } = {}): Decision => {
    const r = c.startRound(h);
    return c.apply(key, 'AWAITING_REVIEW', {
      patch: { ...r.patch, currentHeadSha: h, stateReason: null, boundAttemptId: null, ...(extra.patch ?? {}) },
      rounds: r.rounds, attempts: extra.attempts, effects: [...r.effects, ...(extra.effects ?? [])], evidence,
    });
  };
  const carry = (): Decision | null => {
    if (!cmd.carryForward) return null;
    const p: DeliveryPatch = d.approvalBasis === 'composition'
      ? { compositionHeads: [...d.compositionHeads, h] }
      : { approvedHeads: [...d.approvedHeads, h] };
    return c.apply(key, 'APPROVED', { patch: { ...p, currentHeadSha: h, stateReason: null }, evidence: { ...evidence, carryForward: cmd.carryForward } });
  };

  switch (d.state) {
    case 'WORKING':
      return record();
    case 'AWAITING_PUSH':
    case 'REPAIRING': {
      const a = c.attempt(d.boundAttemptId);
      const proof = deliveryProof({
        boundHeadSha: a?.boundHeadSha ?? d.currentHeadSha,
        localHeadSha: a?.reportedShas.at(-1) ?? null,
        liveHeadSha: h,
        liveContainsLocal: cmd.proof?.liveContainsLocal,
        contentDiffChanged: cmd.proof?.contentDiffChanged,
      });
      if (!proof.holds) {
        if (d.state === 'REPAIRING') return record();
        return c.apply(key, 'AWAITING_PUSH', { patch: { currentHeadSha: h }, evidence: { ...evidence, proof } });
      }
      const attempts: AttemptOp[] = a ? [{ op: 'update', attemptId: a.id, whenStatus: ['queued', 'running', 'ended'], set: { outcome: 'delivered', pushedHeadSha: h } }] : [];
      if (d.state === 'REPAIRING' && headCoverage(d, d.currentHeadSha) !== 'none') {
        const cf = carry();
        if (cf && cf.result === 'apply') return { ...cf, attempts };
      }
      return toReview({ attempts });
    }
    case 'AWAITING_REVIEW':
      return toReview();
    case 'CHANGES_REQUESTED':
      return toReview({
        attempts: [{ op: 'cancel_open', families: ['review_fix'], status: 'cancelled' }],
        effects: [{ kind: 'cancel_open_attempts', dedupeKey: `cancel_open_attempts:${d.id}:head:${h}`, payload: { families: ['review_fix'], reason: 'head_moved' } }],
      });
    case 'FIXING': {
      // Mid-fix pushes are normal; the round advances at AttemptEnded. Record
      // the SHA as provenance for the running attempt (§6.9).
      const a = c.attempt(d.boundAttemptId);
      return c.apply(key, 'FIXING', {
        patch: { currentHeadSha: h },
        attempts: a ? [{ op: 'update', attemptId: a.id, whenStatus: ['queued', 'running'], set: { appendReportedSha: h } }] : [],
        evidence,
      });
    }
    case 'APPROVED':
      return carry() ?? toReview();
    case 'LANDING':
      return carry() ?? toReview();
    case 'ESCALATED':
      return d.stateReason?.startsWith('review_') ? toReview() : record();
    default:
      // BLOCKED_ON_TRUNK, CLOSED_UNMERGED: record the head; T26 / T19 re-evaluate.
      return record();
  }
}

// ── T4 ──────────────────────────────────────────────────────────────────────

function attemptEnded(c: Ctx, cmd: Extract<Command, { type: 'AttemptEnded' }>): Decision {
  const d = c.d!;
  const key = `end:${cmd.workerId}`;
  if (!['WORKING', 'FIXING', 'REPAIRING'].includes(d.state)) return c.stale('attempt_not_bound');
  const L = cmd.localHeadSha;
  const live = cmd.live;
  const evidence = { outcome: cmd.outcome, localHeadSha: L, commitCount: cmd.commitCount, live };

  if (d.state === 'WORKING') {
    if (cmd.taskId !== d.ownerTaskId) return c.stale('attempt_not_bound');
    const prOpen = d.prNumber != null && livePrOpen(live);
    const contains = prOpen && (!L || live!.headSha === L || cmd.proof?.liveContainsLocal === true);
    const success = cmd.outcome === 'success';
    if ((success || cmd.outcome === 'unproven') && contains) {
      const h = live!.headSha;
      if (cmd.reviewRequired === false) return c.apply(key, 'WORKING', { patch: { currentHeadSha: h }, evidence });
      if (c.openRoundAt(h)) return c.apply(key, 'AWAITING_REVIEW', { patch: { currentHeadSha: h }, evidence });
      if (c.decidedAt(h)) return c.apply(key, 'WORKING', { patch: { currentHeadSha: h }, evidence: { ...evidence, note: 'head_already_reviewed' } });
      const r = c.startRound(h);
      return c.apply(key, 'AWAITING_REVIEW', { patch: { ...r.patch, currentHeadSha: h }, rounds: r.rounds, effects: r.effects, evidence });
    }
    if (success || (cmd.outcome === 'unproven' && cmd.commitCount > 0)) {
      // A local commit is never delivery (§9).
      return c.apply(key, 'AWAITING_PUSH', { effects: [c.pushRecovery(L)], evidence });
    }
    if (cmd.taskRetryBudgetLeft) return c.apply(key, 'WORKING', { evidence: { ...evidence, requeue: true } });
    if (d.prNumber == null) return c.apply(key, 'FAILED', { patch: { stateReason: `attempt_${cmd.outcome}` }, evidence });
    if (cmd.commitCount > 0 && !contains) {
      return c.apply(key, 'ESCALATED', { patch: { stateReason: 'push_undeliverable' }, effects: [c.pushRecovery(L)], evidence });
    }
    const h = live?.headSha ?? d.currentHeadSha;
    if (h && livePrOpen(live) && !c.openRoundAt(h) && !c.decidedAt(h)) {
      const r = c.startRound(h);
      return c.apply(key, 'AWAITING_REVIEW', { patch: { ...r.patch, currentHeadSha: h }, rounds: r.rounds, effects: r.effects, evidence });
    }
    return c.apply(key, 'WORKING', { evidence });
  }

  // FIXING / REPAIRING: the bound repair attempt.
  const a = c.attempt(cmd.attemptId);
  if (!a || a.id !== d.boundAttemptId) return c.stale('attempt_not_bound');
  const end = (outcome: 'delivered' | 'unproven' | 'failed', pushed?: string | null): AttemptOp => ({
    op: 'update', attemptId: a.id, whenStatus: ['queued', 'running'],
    set: { status: 'ended', outcome, ended: true, ...(pushed ? { pushedHeadSha: pushed } : {}), ...(L ? { appendReportedSha: L } : {}) },
  });

  if (cmd.outcome === 'success' || (cmd.outcome === 'unproven' && cmd.commitCount > 0)) {
    const proof = deliveryProof({
      boundHeadSha: a.boundHeadSha,
      localHeadSha: L,
      liveHeadSha: livePrOpen(live) ? live!.headSha : null,
      liveContainsLocal: cmd.proof?.liveContainsLocal,
      contentDiffChanged: cmd.proof?.contentDiffChanged,
    });
    if (!proof.holds) {
      // #3754: FIXING → AWAITING_REVIEW is not reachable without §9 proof.
      return c.apply(key, 'AWAITING_PUSH', { attempts: [end('unproven')], effects: [c.pushRecovery(L)], evidence: { ...evidence, proof } });
    }
    const h = live!.headSha;
    if (d.state === 'REPAIRING' && cmd.carryForward && headCoverage(d, a.boundHeadSha) !== 'none') {
      const p: DeliveryPatch = d.approvalBasis === 'composition'
        ? { compositionHeads: [...d.compositionHeads, h] }
        : { approvedHeads: [...d.approvedHeads, h] };
      return c.apply(key, 'APPROVED', {
        patch: { ...p, currentHeadSha: h, boundAttemptId: null, stateReason: null },
        attempts: [end('delivered', h)], evidence: { ...evidence, proof, carryForward: cmd.carryForward },
      });
    }
    const r = c.startRound(h);
    return c.apply(key, 'AWAITING_REVIEW', {
      patch: { ...r.patch, currentHeadSha: h, boundAttemptId: null, stateReason: null },
      rounds: r.rounds, attempts: [end('delivered', h)], effects: r.effects, evidence: { ...evidence, proof },
    });
  }

  // failed / lost / unproven-with-nothing: back to the owing state, or exhaust.
  const exhausted = a.attemptNo >= a.maxAttempts;
  if (d.state === 'FIXING') {
    if (exhausted) {
      return c.apply(key, 'ESCALATED', {
        patch: { stateReason: 'review_exhausted', boundAttemptId: null }, attempts: [end('failed')],
        effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:review_fix:${a.attemptNo}`, payload: { family: 'review_fix', attempts: a.attemptNo } }],
        evidence,
      });
    }
    const round = c.currentRound();
    return c.apply(key, 'CHANGES_REQUESTED', {
      patch: { boundAttemptId: null }, attempts: [end('failed')],
      effects: [{
        kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${d.id}:${round?.id ?? 'none'}:${a.attemptNo + 1}`,
        payload: { roundId: round?.id ?? null, round: d.currentRound, headSha: a.boundHeadSha, attemptNo: a.attemptNo + 1 },
      }],
      evidence,
    });
  }
  // REPAIRING
  if (exhausted) {
    const reason = a.family === 'ci' ? 'ci_exhausted' : 'conflict_exhausted';
    return c.apply(key, 'ESCALATED', {
      patch: { stateReason: reason, boundAttemptId: null }, attempts: [end('failed')],
      effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:${a.family}:${a.mode}:${a.attemptNo}`, payload: { family: a.family, attempts: a.attemptNo } }],
      evidence,
    });
  }
  const id = c.newId();
  const n = a.attemptNo + 1;
  const kind: EffectSpec['kind'] = a.family === 'ci' ? 'dispatch_ci_fix' : a.mode === 'mechanical' ? (a.family === 'migration' ? 'renumber_migration' : 'refresh_branch') : 'dispatch_conflict_fix';
  return c.apply(key, 'REPAIRING', {
    patch: { boundAttemptId: id },
    attempts: [end('failed'), { op: 'insert', id, family: a.family, attemptNo: n, mode: a.mode, boundHeadSha: a.boundHeadSha, triggerReason: a.triggerReason, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: a.maxAttempts }],
    effects: [{ kind, dedupeKey: `${kind}:${d.id}:${a.boundHeadSha}:${a.mode}:${n}`, payload: { attemptId: id, attemptNo: n, headSha: a.boundHeadSha } }],
    evidence,
  });
}

// ── T12 / T16 shared: mechanical first, agent on refusal (§6.7) ─────────────

function conflictRepair(c: Ctx, head: string, kind: 'conflict' | 'behind' | 'migration', o: {
  key: string; mechanicalRefused: boolean; maxMechanical: number; maxAgent: number; patch: DeliveryPatch;
}): Decision {
  const d = c.d!;
  const family: AttemptFamily = kind === 'migration' ? 'migration' : 'conflict';
  const attempts: AttemptOp[] = [];
  const mechAtHead = c.ledger(family, 'mechanical').filter((a) => a.boundHeadSha === head);
  const openMech = mechAtHead.find((a) => OPEN_ATTEMPT.has(a.status));
  if (!o.mechanicalRefused && openMech) return c.rejected('fix_in_flight');
  if (o.mechanicalRefused && openMech) {
    attempts.push({ op: 'update', attemptId: openMech.id, whenStatus: ['queued', 'running'], set: { status: 'ended', outcome: 'failed', ended: true } });
  }
  const evidence = { repairKind: kind, headSha: head };
  if (!o.mechanicalRefused && mechAtHead.length < o.maxMechanical) {
    const id = c.newId();
    const n = c.nextNo(family, 'mechanical');
    const effectKind: EffectSpec['kind'] = kind === 'migration' ? 'renumber_migration' : 'refresh_branch';
    attempts.push({ op: 'insert', id, family, attemptNo: n, mode: 'mechanical', boundHeadSha: head, triggerReason: kind, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: o.maxMechanical });
    return c.apply(o.key + `:m${n}`, 'REPAIRING', {
      guardHead: true,
      patch: { ...o.patch, stateReason: kind, boundAttemptId: id },
      attempts,
      effects: [{ kind: effectKind, dedupeKey: `${effectKind}:${d.id}:${head}:mechanical:${n}`, payload: { attemptId: id, attemptNo: n, headSha: head, expectedHead: head } }],
      evidence: { ...evidence, mode: 'mechanical' },
    });
  }
  if (c.ledger(family, 'agent').some((a) => OPEN_ATTEMPT.has(a.status))) return c.rejected('fix_in_flight');
  const n = c.nextNo(family, 'agent');
  if (n > o.maxAgent) {
    return c.apply(o.key + ':exhausted', 'ESCALATED', {
      guardHead: true, patch: { ...o.patch, stateReason: 'conflict_exhausted', boundAttemptId: null }, attempts,
      effects: [{ kind: 'escalate_exhaustion', dedupeKey: `exhaust:${d.id}:${family}:${head}`, payload: { family, attempts: n - 1 } }],
      evidence,
    });
  }
  const id = c.newId();
  attempts.push({ op: 'insert', id, family, attemptNo: n, mode: 'agent', boundHeadSha: head, triggerReason: kind, taskId: null, trigger: 'automatic', status: 'queued', maxAttempts: o.maxAgent });
  return c.apply(o.key + `:a${n}`, 'REPAIRING', {
    guardHead: true,
    patch: { ...o.patch, stateReason: kind, boundAttemptId: id },
    attempts,
    effects: [{ kind: 'dispatch_conflict_fix', dedupeKey: `dispatch_conflict_fix:${d.id}:${head}:${n}`, payload: { attemptId: id, attemptNo: n, headSha: head, repairKind: kind } }],
    evidence: { ...evidence, mode: 'agent' },
  });
}
