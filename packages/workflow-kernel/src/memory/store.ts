/**
 * The Store port in memory, with the same rules as buildd's Postgres
 * statements (apps/web/src/lib/workflow/kernel.ts, effects.ts,
 * landing-lane.ts, facts.ts):
 *
 *  - a transition is all or nothing: the delivery CAS (version, allowed
 *    states, bound head and round, `authority = 'kernel'`), the transition
 *    row, effects (ON CONFLICT (dedupe_key) DO NOTHING), round and attempt
 *    writes and the fact link; a unique index violation writes nothing;
 *  - the unique indexes: one delivery per (workspace, owner), per (workspace,
 *    repo, PR); one transition per (delivery, idempotency key) and per
 *    (delivery, version); one round per (delivery, round) and one open round
 *    per (delivery, head, kind); one attempt per (delivery, family, mode, no);
 *    one fact per (workspace, fact key);
 *  - the outbox: claim takes due pending rows and lease-expired delivering
 *    rows, counting the attempt; renew, ack, fail and park are fenced to the
 *    attempt that ran; failures follow `effectRetry`;
 *  - the landing lane: one row per (repo, base), taken by compare-and-set,
 *    holding only while its lease runs and its delivery is in the refresh
 *    window.
 *
 * Time is the injected clock. Ids come from the injected generator.
 */
import type { ApplyDecision, AttemptOp, Command, EffectKind, RecordOnly, RoundOp } from '../commands';
import { effectRetry } from '../effects';
import { holdsLane, LANE_PARKED_OUTCOME } from '../landing-lane';
import type {
  ClaimedEffect, DeliveryRef, EffectAuthority, EffectSnapshot, FactInsert, FollowupEffect, LaneKey, Store, StoredFact, TransitionWrite,
} from '../ports';
import type { AttemptSnapshot, DeliverySnapshot, DeliveryState, KernelView, RoundSnapshot } from '../types';
import type { ControllableClock } from './clock';

export interface TransitionRecord {
  id: string;
  deliveryId: string;
  fromVersion: number;
  toVersion: number;
  fromState: DeliveryState | null;
  toState: DeliveryState;
  command: Command['type'];
  idempotencyKey: string;
  actor: string;
  evidence: Record<string, unknown>;
  bypass: Record<string, unknown> | null;
  at: string;
}

export type EffectStatus = 'pending' | 'delivering' | 'done' | 'dead';

export interface EffectRecord {
  id: string;
  deliveryId: string;
  transitionId: string;
  kind: EffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  notBefore: string;
  status: EffectStatus;
  attemptCount: number;
  leaseUntil: string | null;
  outcome: string | null;
  lastError: string | null;
  createdAt: string;
  seq: number;
}

export interface FactRecord {
  id: string;
  workspaceId: string;
  deliveryId: string | null;
  kind: string;
  factKey: string;
  source: string;
  repoFullName: string | null;
  prNumber: number | null;
  payload: Record<string, unknown>;
  appliedTransitionId: string | null;
  observedAt: string;
}

export interface LaneRecord { repoFullName: string; baseRef: string; deliveryId: string; headSha: string; grantedAt: string; leaseUntil: string }

type StoredDelivery = Omit<DeliverySnapshot, 'pushPendingLocalHead' | 'pushEntries' | 'pushPendingSince'>;
type StoredAttempt = AttemptSnapshot & { pushedHeadSha: string | null };

export class UniqueViolation extends Error {}

const ms = (iso: string) => Date.parse(iso);

/** The kernel's tables, in memory, with the Postgres unique indexes and CAS guard. */
export class MemoryStore implements Store {
  readonly deliveries = new Map<string, StoredDelivery>();
  readonly rounds: Array<RoundSnapshot & { deliveryId: string }> = [];
  readonly attempts: Array<StoredAttempt & { deliveryId: string }> = [];
  readonly transitionLog: TransitionRecord[] = [];
  readonly effectLog: EffectRecord[] = [];
  readonly facts: FactRecord[] = [];
  readonly lanes = new Map<string, LaneRecord>();
  private seq = 0;

  constructor(readonly clock: ControllableClock, private readonly newId: () => string) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  private find(ref: DeliveryRef): StoredDelivery | null {
    for (const d of this.deliveries.values()) {
      if ('deliveryId' in ref ? d.id === ref.deliveryId
        : 'ownerTaskId' in ref ? d.workspaceId === ref.workspaceId && d.ownerTaskId === ref.ownerTaskId
        : d.workspaceId === ref.workspaceId && d.repoFullName === ref.repoFullName && d.prNumber === ref.prNumber) return d;
    }
    return null;
  }

  /** `loadViewSql`: the delivery with its push-entry readings, rounds by number, attempts by (family, mode, no). */
  viewSync(ref: DeliveryRef): KernelView {
    const d = this.find(ref);
    if (!d) return { delivery: null, rounds: [], attempts: [] };
    const entries = this.transitionLog
      .filter((t) => t.deliveryId === d.id && t.toState === 'AWAITING_PUSH' && t.fromState !== 'AWAITING_PUSH')
      .sort((a, b) => a.toVersion - b.toVersion);
    const last = entries[entries.length - 1];
    const local = last?.evidence.localHeadSha;
    const delivery: DeliverySnapshot = {
      ...structuredClone(d),
      pushPendingLocalHead: local == null ? null : String(local),
      pushEntries: entries.length,
      pushPendingSince: last ? last.toVersion : null,
    };
    const rounds = this.rounds.filter((r) => r.deliveryId === d.id).sort((a, b) => a.round - b.round).map(({ deliveryId: _, ...r }) => structuredClone(r));
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const attempts = this.attempts
      .filter((a) => a.deliveryId === d.id)
      .sort((a, b) => cmp(a.family, b.family) || cmp(a.mode, b.mode) || a.attemptNo - b.attemptNo)
      .map(({ deliveryId: _, pushedHeadSha: __, ...a }) => structuredClone(a));
    return { delivery, rounds, attempts };
  }

  async loadView(ref: DeliveryRef): Promise<KernelView> { return this.viewSync(ref); }

  async findTransition(deliveryId: string, key: string): Promise<{ id: string } | null> {
    const t = this.transitionLog.find((x) => x.deliveryId === deliveryId && x.idempotencyKey === key);
    return t ? { id: t.id } : null;
  }

  /** Inspection for tests: the transitions of one delivery, in version order. */
  transitions(deliveryId: string): TransitionRecord[] {
    return this.transitionLog.filter((t) => t.deliveryId === deliveryId).sort((a, b) => a.toVersion - b.toVersion);
  }

  /** Inspection for tests: the effects owed for one delivery, in the order they were written. */
  effects(deliveryId: string, kind?: EffectKind): EffectRecord[] {
    return this.effectLog.filter((e) => e.deliveryId === deliveryId && (!kind || e.kind === kind));
  }

  // ── Transitions ──────────────────────────────────────────────────────────

  async applyTransition(dec: ApplyDecision, ref: { deliveryId: string | null; factId?: string | null }): Promise<TransitionWrite> {
    try {
      const row = this.applyTransitionSync(dec, ref.deliveryId, ref.factId ?? null);
      return row ? { status: 'applied', ...row } : { status: 'conflict', cause: 'guard' };
    } catch (err) {
      if (err instanceof UniqueViolation) return { status: 'conflict', cause: 'unique' };
      throw err;
    }
  }

  /**
   * `transitionSql`: one all-or-nothing write. Returns null when the CAS guard
   * did not match; throws UniqueViolation (nothing written) on a unique index.
   */
  applyTransitionSync(dec: ApplyDecision, deliveryId: string | null, factId: string | null = null): { transitionId: string; deliveryId: string; version: number } | null {
    // Stage on copies so a violation part-way writes nothing.
    const deliveries = new Map([...this.deliveries].map(([k, v]) => [k, structuredClone(v)]));
    const rounds = structuredClone(this.rounds);
    const attempts = structuredClone(this.attempts);
    const transitions = [...this.transitionLog];
    const effects = [...this.effectLog];
    const now = this.clock.now();

    let d: StoredDelivery;
    if (dec.create) {
      const exists = [...deliveries.values()].some((x) => x.workspaceId === dec.create!.workspaceId && x.ownerTaskId === dec.create!.ownerTaskId);
      if (exists) return null; // ON CONFLICT DO NOTHING: no row, the caller re-reads.
      d = {
        id: this.newId(), workspaceId: dec.create.workspaceId, ownerTaskId: dec.create.ownerTaskId,
        repoFullName: null, prNumber: null, baseRef: null, state: dec.toState, stateReason: null, version: 1,
        currentHeadSha: null, currentRound: 0, maxRounds: dec.create.maxRounds, boundAttemptId: null, resumeState: null,
        trunkIncidentId: null, approvedHeads: [], approvalBasis: null, compositionHeads: [], ci: null, ciHeadSha: null,
        mergeable: null, mergeableHeadSha: null, mergedAt: null, mergeCommitSha: null, supersededByPr: null,
        supersededByUrl: null, supersededReason: null, recordedBy: null, policyEvidence: null, authority: 'kernel',
      };
      const { maxRounds: _, ...patch } = dec.patch;
      assignDefined(d, patch);
    } else {
      if (!deliveryId) throw new Error('applyTransition: deliveryId required for a non-creating transition');
      const cur = deliveries.get(deliveryId);
      if (!cur) return null;
      const g = dec.guard;
      if (cur.authority !== 'kernel' || cur.version !== g.version || !g.states.includes(cur.state)) return null;
      if (g.headSha !== undefined && cur.currentHeadSha !== g.headSha) return null;
      if (g.round !== undefined && cur.currentRound !== g.round) return null;
      d = cur;
      d.state = dec.toState;
      d.version += 1;
      assignDefined(d, dec.patch);
    }
    // workflow_deliveries_pr_unique
    if (d.prNumber != null && [...deliveries.values()].some((x) => x.id !== d.id && x.workspaceId === d.workspaceId && x.repoFullName === d.repoFullName && x.prNumber === d.prNumber)) {
      throw new UniqueViolation('workflow_deliveries_pr_unique');
    }
    deliveries.set(d.id, d);

    // workflow_transitions_idempotency_unique / _version_unique
    if (transitions.some((t) => t.deliveryId === d.id && (t.idempotencyKey === dec.idempotencyKey || t.toVersion === d.version))) {
      throw new UniqueViolation('workflow_transitions_idempotency_unique');
    }
    const t: TransitionRecord = {
      id: this.newId(), deliveryId: d.id, fromVersion: d.version - 1, toVersion: d.version, fromState: dec.fromState,
      toState: dec.toState, command: dec.command, idempotencyKey: dec.idempotencyKey,
      actor: String(dec.evidence.actor ?? 'kernel'), evidence: structuredClone(dec.evidence),
      bypass: dec.bypass ? structuredClone(dec.bypass) : null, at: now,
    };
    transitions.push(t);

    for (const e of dec.effects) {
      if (effects.some((x) => x.dedupeKey === e.dedupeKey)) continue; // ON CONFLICT (dedupe_key) DO NOTHING
      effects.push(this.newEffect(d.id, t.id, e.kind, e.dedupeKey, e.payload, e.delayMs ?? 0, now));
    }
    applyRoundOps(rounds, d.id, dec.rounds);
    applyAttemptOps(attempts, d.id, dec.attempts);

    this.deliveries.clear();
    for (const [k, v] of deliveries) this.deliveries.set(k, v);
    this.rounds.splice(0, this.rounds.length, ...rounds);
    this.attempts.splice(0, this.attempts.length, ...attempts);
    this.transitionLog.splice(0, this.transitionLog.length, ...transitions);
    this.effectLog.splice(0, this.effectLog.length, ...effects);
    if (factId) {
      const f = this.facts.find((x) => x.id === factId);
      if (f) { f.appliedTransitionId = t.id; f.deliveryId = d.id; }
    }
    return { transitionId: t.id, deliveryId: d.id, version: d.version };
  }

  async recordOnly(deliveryId: string, record: RecordOnly): Promise<void> {
    const rounds = structuredClone(this.rounds);
    const attempts = structuredClone(this.attempts);
    applyRoundOps(rounds, deliveryId, record.rounds);
    applyAttemptOps(attempts, deliveryId, record.attempts);
    this.rounds.splice(0, this.rounds.length, ...rounds);
    this.attempts.splice(0, this.attempts.length, ...attempts);
  }

  // ── Facts ────────────────────────────────────────────────────────────────

  async insertFact(f: FactInsert): Promise<{ id: string } | null> {
    if (this.facts.some((x) => x.workspaceId === f.workspaceId && x.factKey === f.factKey)) return null; // ON CONFLICT DO NOTHING
    const id = this.newId();
    this.facts.push({
      id, workspaceId: f.workspaceId, deliveryId: null, kind: f.kind, factKey: f.factKey, source: f.source,
      repoFullName: f.repoFullName ?? null, prNumber: f.prNumber ?? null, payload: structuredClone(f.payload),
      appliedTransitionId: null, observedAt: this.clock.now(),
    });
    return { id };
  }

  async findFact(workspaceId: string, factKey: string): Promise<StoredFact | null> {
    const f = this.facts.find((x) => x.workspaceId === workspaceId && x.factKey === factKey);
    return f ? { id: f.id, appliedTransitionId: f.appliedTransitionId, payload: structuredClone(f.payload) } : null;
  }

  // ── Outbox ───────────────────────────────────────────────────────────────

  private newEffect(deliveryId: string, transitionId: string, kind: EffectKind, dedupeKey: string, payload: Record<string, unknown>, delayMs: number, now: string): EffectRecord {
    return {
      id: this.newId(), deliveryId, transitionId, kind, dedupeKey, payload: structuredClone(payload),
      notBefore: new Date(ms(now) + delayMs).toISOString(), status: 'pending', attemptCount: 0, leaseUntil: null,
      outcome: null, lastError: null, createdAt: now, seq: ++this.seq,
    };
  }

  private snapshot(e: EffectRecord): EffectSnapshot {
    const d = this.deliveries.get(e.deliveryId);
    const t = this.transitionLog.find((x) => x.id === e.transitionId);
    // As the Postgres claim: the row's own authority; the kill switch is the drain's `Policy`.
    const authority: EffectAuthority = d?.authority === 'legacy' ? 'legacy' : 'kernel';
    return {
      delivery: d ? { state: d.state, version: d.version, workspaceId: d.workspaceId } : null,
      transition: t ? { toState: t.toState, toVersion: t.toVersion } : null,
      authority,
    };
  }

  private held(id: string, attemptCount: number): EffectRecord | null {
    const e = this.effectLog.find((x) => x.id === id);
    return e && e.status === 'delivering' && e.attemptCount === attemptCount ? e : null;
  }

  async claimDueEffects(o: { limit: number; leaseMs: number; deliveryId?: string | null }): Promise<ClaimedEffect[]> {
    const now = this.clock.ms();
    const due = this.effectLog
      .filter((e) => (e.status === 'pending' && ms(e.notBefore) <= now) || (e.status === 'delivering' && e.leaseUntil != null && ms(e.leaseUntil) < now))
      .filter((e) => !o.deliveryId || e.deliveryId === o.deliveryId)
      .sort((a, b) => ms(a.notBefore) - ms(b.notBefore) || a.seq - b.seq)
      .slice(0, o.limit);
    return due.map((e) => {
      e.status = 'delivering';
      e.attemptCount += 1;
      e.leaseUntil = new Date(now + o.leaseMs).toISOString();
      return {
        id: e.id, deliveryId: e.deliveryId, transitionId: e.transitionId, kind: e.kind, dedupeKey: e.dedupeKey,
        payload: structuredClone(e.payload), attemptCount: e.attemptCount, ...this.snapshot(e),
      };
    });
  }

  async renewEffectLease(id: string, attemptCount: number, leaseMs: number): Promise<EffectSnapshot | null> {
    const e = this.held(id, attemptCount);
    if (!e) return null;
    e.leaseUntil = new Date(this.clock.ms() + leaseMs).toISOString();
    return this.snapshot(e);
  }

  async ackEffect(id: string, attemptCount: number, outcome: string): Promise<boolean> {
    const e = this.held(id, attemptCount);
    if (!e) return false;
    e.status = 'done'; e.outcome = outcome.slice(0, 200); e.leaseUntil = null;
    return true;
  }

  async failEffect(id: string, attemptCount: number, error: string): Promise<'pending' | 'dead' | null> {
    const e = this.held(id, attemptCount);
    if (!e) return null;
    const r = effectRetry(attemptCount);
    e.status = r.dead ? 'dead' : 'pending';
    e.lastError = error.slice(0, 500);
    e.notBefore = new Date(this.clock.ms() + r.retryInMs).toISOString();
    e.leaseUntil = null;
    return e.status as 'pending' | 'dead';
  }

  async parkEffect(id: string, attemptCount: number, outcome: string, delayMs: number): Promise<boolean> {
    const e = this.held(id, attemptCount);
    if (!e) return false;
    e.status = 'pending'; e.attemptCount = Math.max(e.attemptCount - 1, 0); e.outcome = outcome.slice(0, 200);
    e.notBefore = new Date(this.clock.ms() + delayMs).toISOString(); e.leaseUntil = null;
    return true;
  }

  /** `linkRoundReviewerSql`: only a round with no reviewer yet takes one. */
  async linkRoundReviewer(roundId: string, taskId: string): Promise<void> {
    const r = this.rounds.find((x) => x.id === roundId);
    if (r && r.reviewerTaskId == null) r.reviewerTaskId = taskId;
  }

  /** `linkAttemptTaskSql`: only a row with no task yet takes one. */
  async linkAttemptTask(attemptId: string, taskId: string): Promise<void> {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (a && a.taskId == null) a.taskId = taskId;
  }

  async insertFollowupEffect(f: FollowupEffect): Promise<boolean> {
    if (this.effectLog.some((x) => x.dedupeKey === f.dedupeKey)) return false;
    this.effectLog.push(this.newEffect(f.deliveryId, f.transitionId, f.kind, f.dedupeKey, f.payload, f.delayMs ?? 0, this.clock.now()));
    return true;
  }

  async releaseToLegacy(deliveryId: string): Promise<boolean> {
    const d = this.deliveries.get(deliveryId);
    if (!d || d.authority !== 'kernel') return false;
    d.authority = 'legacy';
    return true;
  }

  // ── Landing lane ─────────────────────────────────────────────────────────

  private laneHolds(l: LaneRecord): boolean {
    const d = this.deliveries.get(l.deliveryId);
    return ms(l.leaseUntil) > this.clock.ms() && !!d && holdsLane(d);
  }

  async acquireLane(k: LaneKey & { deliveryId: string; headSha: string; holdMs: number }): Promise<boolean> {
    const key = laneKey(k);
    const cur = this.lanes.get(key);
    const now = this.clock.now();
    const leaseUntil = new Date(this.clock.ms() + k.holdMs).toISOString();
    if (!cur) {
      this.lanes.set(key, { repoFullName: k.repoFullName, baseRef: k.baseRef, deliveryId: k.deliveryId, headSha: k.headSha, grantedAt: now, leaseUntil });
      return true;
    }
    if (cur.deliveryId !== k.deliveryId && this.laneHolds(cur)) return false;
    this.lanes.set(key, { ...cur, deliveryId: k.deliveryId, headSha: k.headSha, grantedAt: cur.deliveryId === k.deliveryId ? cur.grantedAt : now, leaseUntil });
    return true;
  }

  async laneHolder(k: LaneKey): Promise<{ deliveryId: string; prNumber: number | null } | null> {
    const l = this.lanes.get(laneKey(k));
    if (!l || !this.laneHolds(l)) return null;
    return { deliveryId: l.deliveryId, prNumber: this.deliveries.get(l.deliveryId)?.prNumber ?? null };
  }

  async releaseSettledLanes(deliveryId: string): Promise<LaneKey[]> {
    const out: LaneKey[] = [];
    for (const [key, l] of [...this.lanes]) {
      if (l.deliveryId !== deliveryId || this.laneHolds(l)) continue;
      this.lanes.delete(key);
      out.push({ repoFullName: l.repoFullName, baseRef: l.baseRef });
    }
    return out;
  }

  async wakeNextLaneWaiter(k: LaneKey): Promise<string | null> {
    const next = this.effectLog
      .filter((e) => {
        const d = this.deliveries.get(e.deliveryId);
        return e.kind === 'refresh_branch' && e.status === 'pending' && (e.outcome ?? '').startsWith(LANE_PARKED_OUTCOME)
          && d?.repoFullName === k.repoFullName && d?.baseRef === k.baseRef;
      })
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.seq - b.seq)[0];
    if (!next) return null;
    next.notBefore = this.clock.now();
    return next.deliveryId;
  }
}

function laneKey(k: LaneKey): string {
  return `${k.repoFullName}\u0000${k.baseRef}`;
}

function assignDefined(target: object, patch: object): void {
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (target as Record<string, unknown>)[k] = structuredClone(v);
}

function applyRoundOps(rounds: Array<RoundSnapshot & { deliveryId: string }>, deliveryId: string, ops: RoundOp[]): void {
  for (const o of ops) {
    if (o.op === 'insert') {
      // workflow_review_rounds_round_unique / _open_per_head
      if (rounds.some((r) => r.deliveryId === deliveryId && r.round === o.round)) throw new UniqueViolation('workflow_review_rounds_round_unique');
      if (rounds.some((r) => r.deliveryId === deliveryId && r.headSha === o.headSha && r.kind === o.kind && (r.status === 'queued' || r.status === 'reviewing'))) {
        throw new UniqueViolation('workflow_review_rounds_open_per_head');
      }
      rounds.push({
        deliveryId, id: o.id, round: o.round, headSha: o.headSha, kind: o.kind, status: 'queued', verdict: null,
        effectiveVerdict: null, failureCount: 0, reviewerTaskId: null, scope: o.scope ?? null,
      });
      continue;
    }
    const r = rounds.find((x) => x.deliveryId === deliveryId && x.id === o.roundId && o.whenStatus.includes(x.status));
    if (!r) continue;
    if (o.set.status !== undefined) r.status = o.set.status;
    if (o.set.verdict !== undefined) r.verdict = o.set.verdict;
    if (o.set.effectiveVerdict !== undefined) r.effectiveVerdict = o.set.effectiveVerdict;
    if (o.set.failureCount !== undefined) r.failureCount = o.set.failureCount;
    if (o.set.clearReviewer) r.reviewerTaskId = null;
  }
}

function applyAttemptOps(attempts: Array<StoredAttempt & { deliveryId: string }>, deliveryId: string, ops: AttemptOp[]): void {
  for (const o of ops) {
    if (o.op === 'insert') {
      // workflow_attempts_no_unique
      if (attempts.some((a) => a.deliveryId === deliveryId && a.family === o.family && a.mode === o.mode && a.attemptNo === o.attemptNo)) {
        throw new UniqueViolation('workflow_attempts_no_unique');
      }
      attempts.push({
        deliveryId, id: o.id, family: o.family, attemptNo: o.attemptNo, mode: o.mode, boundHeadSha: o.boundHeadSha,
        triggerReason: o.triggerReason, taskId: o.taskId, status: o.status, outcome: null, maxAttempts: o.maxAttempts,
        reportedShas: [], trigger: o.trigger, pushedHeadSha: null,
      });
    } else if (o.op === 'update') {
      const a = attempts.find((x) => x.deliveryId === deliveryId && x.id === o.attemptId && o.whenStatus.includes(x.status));
      if (!a) continue;
      if (o.set.status !== undefined) a.status = o.set.status;
      if (o.set.outcome !== undefined) a.outcome = o.set.outcome;
      if (o.set.pushedHeadSha !== undefined) a.pushedHeadSha = o.set.pushedHeadSha;
      if (o.set.appendReportedSha !== undefined && !a.reportedShas.includes(o.set.appendReportedSha)) a.reportedShas.push(o.set.appendReportedSha);
    } else {
      for (const a of attempts) {
        if (a.deliveryId !== deliveryId || (a.status !== 'queued' && a.status !== 'running') || !o.families.includes(a.family)) continue;
        if (o.headSha && a.boundHeadSha !== o.headSha) continue;
        a.status = o.status;
        a.outcome = 'noop';
      }
    }
  }
}
