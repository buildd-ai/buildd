/**
 * The outbox drain (docs/specs/workflow-state-kernel.md §10) over the Store
 * port: claim due rows, renew each one's lease before its turn, re-check that
 * its transition still describes the delivery, run the handler, then ack,
 * park, or fail with backoff (15s doubling to 30m, `dead` at 8 attempts).
 *
 * Read-your-write (§7.5, §10.4): before a gated handler runs, the effect's
 * transition must still describe the delivery (same version, or the same
 * state); otherwise the effect is done as `skipped:superseded`.
 *
 * The kill switch (§14): an effect claimed for a delivery the kernel no longer
 * owns (released to legacy, or switched off — read from `Policy` for the
 * delivery's workspace, never from the store — which the drain releases there
 * and then) still drains, except the kinds in `KERNEL_ONLY_EFFECTS`: those act on
 * GitHub for the kernel's own landing and repair loop and are done as
 * `skipped:legacy_owns`.
 *
 * Handlers are the package's (`handlers/`, on the host's ports) plus the
 * families the host still owns; the drain only needs their shape.
 */
import type { EffectKind } from './commands';
import type { ClaimedEffect, EffectSnapshot, Policy, Store } from './ports';

export const EFFECT_LEASE_MS = 120_000;
export const EFFECT_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Effects whose permanent failure escalates the delivery (§10.3): the spec's
 * three, plus the ones whose state has no other exit while they are dead
 * (`verify_merge` holds LANDING; the dispatches hold CHANGES_REQUESTED and
 * AWAITING_REVIEW, and the floor never re-owes a key that exists).
 */
export const CRITICAL_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'merge_call', 'verify_merge', 'push_recovery', 'post_review', 'dispatch_fix', 'dispatch_review',
  'refresh_branch', 'renumber_migration',
]);

/**
 * Effects that stay true whatever the delivery did since: projections,
 * notifications, post-merge work, read-only verification, cancellations.
 * Everything else (dispatch, merge, push, refresh) acts only while its
 * transition still describes the delivery.
 */
export const UNGATED_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'render_activity', 'stamp_pr_rows', 'notify', 'mission_note', 'wake_mission', 'release_attribution',
  'finalize_mission_pr', 'emit_pr_merged', 'verify_merge', 'cancel_open_attempts', 'scan_supersession',
  'project_supersession', 'post_review', 'escalate_exhaustion', 'gate_event', 'capture_ci_evidence',
  // Re-reads the delivery and publishes its newest answer (an older version's row skips itself).
  'publish_landing_status',
  // Once per merge, read from the merged delivery.
  'dispatch_external_merge_fix',
]);

/**
 * Effects that act on GitHub or the PR branch on the kernel's behalf, whose
 * answer only the kernel can read (a merge answered `behind` becomes a
 * refresh, a refresh becomes a new head). Once a delivery is legacy's they
 * never run: an emergency rollback must be able to stop a merge (§14). The
 * other kinds drain: projections and notifications, and the dispatches, which
 * file legacy-shaped review and fix tasks for decisions already committed.
 */
export const KERNEL_ONLY_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'merge_call', 'refresh_branch', 'renumber_migration', 'push_recovery',
]);

export function effectBackoffMs(attemptCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1), BACKOFF_CAP_MS);
}

/** What a failed attempt becomes: dead at the cap, else pending again after the backoff. Every store applies exactly this. */
export function effectRetry(attemptCount: number): { dead: boolean; retryInMs: number } {
  return { dead: attemptCount >= EFFECT_MAX_ATTEMPTS, retryInMs: effectBackoffMs(attemptCount) };
}

/** §10.4: does the transition that queued this effect still describe the delivery? */
export function effectIsCurrent(e: Pick<ClaimedEffect, 'kind' | 'delivery' | 'transition'>): boolean {
  if (UNGATED_EFFECTS.has(e.kind)) return true;
  if (!e.delivery || !e.transition) return false;
  if (e.delivery.version === e.transition.toVersion) return true;
  return e.delivery.state === e.transition.toState;
}

/**
 * `park`: the handler cannot act yet and nothing is wrong (the landing lane is
 * held). The row stays pending without spending an attempt.
 */
export type EffectHandler = (e: ClaimedEffect) => Promise<{ outcome?: string; park?: { delayMs: number } } | void>;
export type EffectHandlers = Partial<Record<EffectKind, EffectHandler>>;

export interface DeadEffect { id: string; deliveryId: string; kind: EffectKind; critical: boolean; dedupeKey: string; lastError: string }

export interface DrainSummary {
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  /** Claimed in this batch but re-claimed by another drain before their turn (batch lease ran out): not run here. */
  lost: number;
  /** Effects that went dead; `critical` ones were escalated through `onDead` (§10.3). */
  dead: DeadEffect[];
}

export interface DrainLog {
  log(msg: string): void;
  error(msg: string, err: unknown): void;
}

const consoleLog: DrainLog = {
  log: (msg) => console.log(msg),
  error: (msg, err) => console.error(msg, err),
};

export interface DrainOptions {
  handlers: EffectHandlers;
  /** Where the kill switch is read (`kernelEnabled`), once per workspace per drain. */
  policy: Policy;
  limit?: number;
  deliveryId?: string | null;
  /** What runs for each effect that just went dead. Its failure never fails the drain. */
  onDead?: (dead: DeadEffect) => Promise<void>;
  leaseMs?: number;
  log?: DrainLog;
}

function withSnapshot(e: ClaimedEffect, s: EffectSnapshot, kernelOn: boolean): ClaimedEffect {
  const recorded = s.authority === 'legacy' ? 'legacy' : 'kernel';
  return { ...e, delivery: s.delivery, transition: s.transition, authority: recorded === 'kernel' && !kernelOn ? 'switched_off' : recorded };
}

/** Keeps a running handler's lease alive (fenced to its attempt), so a slow handler is not re-claimed under it. */
async function withLeaseHeartbeat<T>(store: Store, e: ClaimedEffect, leaseMs: number, log: DrainLog, run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    store.renewEffectLease(e.id, e.attemptCount, leaseMs).catch((err) => log.error(`[workflow] renewing lease of effect ${e.id} (${e.kind}) failed:`, err));
  }, leaseMs / 3);
  (timer as { unref?: () => void }).unref?.();
  try { return await run(); } finally { clearInterval(timer); }
}

/** Drain up to `limit` due effects once. Handlers MUST be idempotent (§10.2). */
export async function drainEffects(store: Store, opts: DrainOptions): Promise<DrainSummary> {
  const leaseMs = opts.leaseMs ?? EFFECT_LEASE_MS;
  const log = opts.log ?? consoleLog;
  const rows = await store.claimDueEffects({ limit: opts.limit ?? 25, leaseMs, deliveryId: opts.deliveryId ?? null });
  const summary: DrainSummary = { claimed: rows.length, done: 0, skipped: 0, failed: 0, lost: 0, dead: [] };
  const released = new Set<string>();
  const switches = new Map<string, Promise<boolean>>();
  // No delivery row (or no workspace on it) reads as on: the snapshot's null delivery gates the effect instead.
  const kernelOn = (workspaceId: string | null | undefined): Promise<boolean> => {
    if (!workspaceId) return Promise.resolve(true);
    let p = switches.get(workspaceId);
    if (!p) switches.set(workspaceId, (p = opts.policy.forWorkspace(workspaceId).then((x) => x.kernelEnabled)));
    return p;
  };
  for (const claimed of rows) {
    // §10.3: renew this row's lease, fenced to this attempt, before touching it. Nothing back
    // means the batch lease ran out and another drain holds the row now: its attempt answers.
    const renewed = await store.renewEffectLease(claimed.id, claimed.attemptCount, leaseMs);
    if (!renewed) {
      summary.lost++;
      continue;
    }
    const e = withSnapshot(claimed, renewed, renewed.authority === 'legacy' ? true : await kernelOn(renewed.delivery?.workspaceId));
    if (e.authority === 'switched_off' && !released.has(e.deliveryId)) {
      // §14: the first kernel touch after switch-off releases the delivery (sticky).
      if (await store.releaseToLegacy(e.deliveryId)) log.log(`[workflow] delivery ${e.deliveryId} released to legacy (workflowKernel kill switch, effect drain)`);
      released.add(e.deliveryId);
    }
    if (e.authority !== 'kernel' && KERNEL_ONLY_EFFECTS.has(e.kind)) {
      await store.ackEffect(e.id, e.attemptCount, 'skipped:legacy_owns');
      summary.skipped++;
      continue;
    }
    if (!effectIsCurrent(e)) {
      await store.ackEffect(e.id, e.attemptCount, 'skipped:superseded');
      summary.skipped++;
      continue;
    }
    const handler = opts.handlers[e.kind];
    try {
      if (!handler) throw new Error(`no handler for ${e.kind}`);
      const res = await withLeaseHeartbeat(store, e, leaseMs, log, () => handler(e));
      const outcome = (res && res.outcome) || 'ok';
      if (res && res.park) {
        // Counted as skipped: it did nothing this pass, and it is still owed.
        if (await store.parkEffect(e.id, e.attemptCount, outcome, res.park.delayMs)) summary.skipped++; else summary.lost++;
        continue;
      }
      // A handler that outlived its lease (heartbeat lost) settles nothing: the re-claiming attempt answers.
      if (!(await store.ackEffect(e.id, e.attemptCount, outcome))) summary.lost++;
      else if (outcome.startsWith('skipped')) summary.skipped++; else summary.done++;
    } catch (err) {
      const lastError = String((err as Error)?.message ?? err);
      const status = await store.failEffect(e.id, e.attemptCount, lastError);
      if (!status) summary.lost++;
      else if (status === 'dead') {
        const dead: DeadEffect = { id: e.id, deliveryId: e.deliveryId, kind: e.kind, critical: CRITICAL_EFFECTS.has(e.kind), dedupeKey: e.dedupeKey, lastError: lastError.slice(0, 500) };
        summary.dead.push(dead);
        // §10.3: a dead effect is never left for someone to notice. Escalation failing must not
        // fail the drain: the row is dead either way, and the floor still sees it.
        if (opts.onDead) {
          try { await opts.onDead(dead); } catch (escErr) { log.error(`[workflow] escalating dead effect ${e.id} (${e.kind}) failed:`, escErr); }
        }
      } else summary.failed++;
    }
  }
  return summary;
}
