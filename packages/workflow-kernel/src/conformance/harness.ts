/**
 * An in-memory host for the kernel's pure core
 * (docs/specs/workflow-kernel-library.md §2, conformance suite).
 *
 * A tiny store of delivery views and transitions with the same uniqueness and
 * CAS rules as the Postgres statements in apps/web (`transitionSql`,
 * `loadViewSql`, `applyCommand`), a controllable clock and deterministic ids.
 * It drives the reducer through commands exactly as a host does: read the
 * view, check the stable idempotency key, reduce, write the decision with the
 * version it read; on a guard miss or a uniqueness conflict re-read and decide
 * once more, then answer `stale`.
 *
 * Effects are recorded, never run: the suite asserts what the kernel owes, and
 * a test that wants an effect's outcome submits the command that outcome is.
 */
import type { ApplyDecision, AttemptOp, Command, CurrentView, EffectKind, RecordOnly, RoundOp } from '../commands';
import { currentOf, reduce, stableIdempotencyKey } from '../reducer';
import type { AttemptSnapshot, DeliverySnapshot, DeliveryState, KernelView, RoundSnapshot } from '../types';

// ── Clock and ids ───────────────────────────────────────────────────────────

export interface Clock {
  now(): string;
}

export interface ControllableClock extends Clock {
  advance(ms: number): void;
  set(iso: string): void;
}

export function controllableClock(start = '2026-01-01T00:00:00.000Z'): ControllableClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; },
    set: (iso) => { t = Date.parse(iso); },
  };
}

/** `id1`, `id2`, ... : the same run always allocates the same ids. */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

// ── Records ─────────────────────────────────────────────────────────────────

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

export interface EffectRecord {
  id: string;
  deliveryId: string;
  transitionId: string;
  kind: EffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  notBefore: string;
}

type StoredDelivery = Omit<DeliverySnapshot, 'pushPendingLocalHead' | 'pushEntries' | 'pushPendingSince'>;
type StoredAttempt = AttemptSnapshot & { pushedHeadSha: string | null };

export type DeliveryRef =
  | { deliveryId: string }
  | { workspaceId: string; ownerTaskId: string }
  | { workspaceId: string; repoFullName: string; prNumber: number };

export type CommandResult =
  | { result: 'applied'; transitionId: string; deliveryId: string; version: number; decision: ApplyDecision }
  | { result: 'duplicate'; transitionId: string | null; reason: string; current: CurrentView }
  | { result: 'stale'; reason: string; current: CurrentView }
  | { result: 'rejected'; reason: string; missing?: string[]; current: CurrentView };

class UniqueViolation extends Error {}

// ── Store ───────────────────────────────────────────────────────────────────

/** The kernel's tables, in memory, with the Postgres unique indexes and CAS guard. */
export class InMemoryStore {
  readonly deliveries = new Map<string, StoredDelivery>();
  readonly rounds: Array<RoundSnapshot & { deliveryId: string }> = [];
  readonly attempts: Array<StoredAttempt & { deliveryId: string }> = [];
  readonly transitions: TransitionRecord[] = [];
  readonly effects: EffectRecord[] = [];

  constructor(private readonly clock: Clock, private readonly newId: () => string) {}

  find(ref: DeliveryRef): StoredDelivery | null {
    for (const d of this.deliveries.values()) {
      if ('deliveryId' in ref ? d.id === ref.deliveryId
        : 'ownerTaskId' in ref ? d.workspaceId === ref.workspaceId && d.ownerTaskId === ref.ownerTaskId
        : d.workspaceId === ref.workspaceId && d.repoFullName === ref.repoFullName && d.prNumber === ref.prNumber) return d;
    }
    return null;
  }

  /** `loadViewSql`: the delivery with its push-entry readings, rounds by number, attempts by (family, mode, no). */
  loadView(ref: DeliveryRef): KernelView {
    const d = this.find(ref);
    if (!d) return { delivery: null, rounds: [], attempts: [] };
    const entries = this.transitions
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

  findTransition(deliveryId: string, key: string): TransitionRecord | null {
    return this.transitions.find((t) => t.deliveryId === deliveryId && t.idempotencyKey === key) ?? null;
  }

  /**
   * `transitionSql`: one all-or-nothing write. Returns null when the CAS guard
   * did not match; throws UniqueViolation (nothing written) on a unique index.
   */
  applyTransition(dec: ApplyDecision, deliveryId: string | null): { transitionId: string; deliveryId: string; version: number } | null {
    // Stage on copies so a violation part-way writes nothing.
    const deliveries = new Map([...this.deliveries].map(([k, v]) => [k, structuredClone(v)]));
    const rounds = structuredClone(this.rounds);
    const attempts = structuredClone(this.attempts);
    const transitions = [...this.transitions];
    const effects = [...this.effects];
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
      effects.push({
        id: this.newId(), deliveryId: d.id, transitionId: t.id, kind: e.kind, dedupeKey: e.dedupeKey,
        payload: structuredClone(e.payload), notBefore: new Date(Date.parse(now) + (e.delayMs ?? 0)).toISOString(),
      });
    }
    applyRoundOps(rounds, d.id, dec.rounds);
    applyAttemptOps(attempts, d.id, dec.attempts);

    this.deliveries.clear();
    for (const [k, v] of deliveries) this.deliveries.set(k, v);
    this.rounds.splice(0, this.rounds.length, ...rounds);
    this.attempts.splice(0, this.attempts.length, ...attempts);
    this.transitions.splice(0, this.transitions.length, ...transitions);
    this.effects.splice(0, this.effects.length, ...effects);
    return { transitionId: t.id, deliveryId: d.id, version: d.version };
  }

  /** `recordOnlySql`: audit writes kept when no transition applies. */
  recordOnly(deliveryId: string, record: RecordOnly): void {
    const rounds = structuredClone(this.rounds);
    const attempts = structuredClone(this.attempts);
    applyRoundOps(rounds, deliveryId, record.rounds);
    applyAttemptOps(attempts, deliveryId, record.attempts);
    this.rounds.splice(0, this.rounds.length, ...rounds);
    this.attempts.splice(0, this.attempts.length, ...attempts);
  }
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

// ── Host ────────────────────────────────────────────────────────────────────

/** The in-memory host: `applyCommand`'s read → reduce → CAS write loop over an InMemoryStore. */
export class InMemoryKernel {
  readonly clock: ControllableClock;
  readonly newId: () => string;
  readonly store: InMemoryStore;

  constructor(opts: { clock?: ControllableClock; newId?: () => string } = {}) {
    this.clock = opts.clock ?? controllableClock();
    this.newId = opts.newId ?? sequentialIds();
    this.store = new InMemoryStore(this.clock, this.newId);
  }

  submit(cmd: Command, ref?: DeliveryRef): CommandResult {
    const r = refFor(cmd, ref);
    let view = this.store.loadView(r);
    for (let pass = 0; pass < 2; pass++) {
      const d = view.delivery;
      if (d?.authority === 'legacy') return { result: 'rejected', reason: 'legacy_owns', current: currentOf(view) };
      const key = stableIdempotencyKey(cmd, d);
      if (d && key) {
        const hit = this.store.findTransition(d.id, key);
        if (hit) return { result: 'duplicate', transitionId: hit.id, reason: 'idempotency_key_seen', current: currentOf(view) };
      }
      const decision = reduce(view, cmd, { newId: this.newId });
      if (decision.result === 'duplicate') return { result: 'duplicate', transitionId: null, reason: decision.reason, current: decision.current };
      if (decision.result === 'stale' || decision.result === 'rejected') {
        if (d && decision.record) this.store.recordOnly(d.id, decision.record);
        return decision.result === 'stale'
          ? { result: 'stale', reason: decision.reason, current: decision.current }
          : { result: 'rejected', reason: decision.reason, missing: decision.missing, current: decision.current };
      }
      let row: ReturnType<InMemoryStore['applyTransition']> = null;
      try {
        row = this.store.applyTransition(decision, d?.id ?? null);
      } catch (err) {
        if (!(err instanceof UniqueViolation)) throw err;
      }
      if (row) return { result: 'applied', transitionId: row.transitionId, deliveryId: row.deliveryId, version: row.version, decision };
      view = this.store.loadView(d ? { deliveryId: d.id } : r);
      if (decision.create && view.delivery) return { result: 'duplicate', transitionId: null, reason: 'delivery_exists', current: currentOf(view) };
    }
    return { result: 'stale', reason: 'cas_conflict', current: currentOf(view) };
  }

  view(ref: DeliveryRef): KernelView {
    return this.store.loadView(ref);
  }

  /** Effects the kernel owes for a delivery, in the order they were written. */
  effects(deliveryId: string, kind?: EffectKind): EffectRecord[] {
    return this.store.effects.filter((e) => e.deliveryId === deliveryId && (!kind || e.kind === kind));
  }

  transitions(deliveryId: string): TransitionRecord[] {
    return this.store.transitions.filter((t) => t.deliveryId === deliveryId);
  }
}

function refFor(cmd: Command, ref: DeliveryRef | undefined): DeliveryRef {
  if (ref) return ref;
  if (cmd.type === 'DeliveryOpened') return { workspaceId: cmd.workspaceId, ownerTaskId: cmd.ownerTaskId };
  if (cmd.type === 'PrBound' && cmd.adoption) return { workspaceId: cmd.adoption.workspaceId, ownerTaskId: cmd.adoption.ownerTaskId };
  throw new Error(`submit: a delivery ref is required for ${cmd.type}`);
}
