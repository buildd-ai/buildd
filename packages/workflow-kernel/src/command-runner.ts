/**
 * The command runner (docs/specs/workflow-state-kernel.md §7.2) over the Store
 * port: read the view, check the stable idempotency key, reduce, write the
 * decision with the version it read; on a CAS miss or a uniqueness conflict
 * re-read and decide ONCE more, then answer `stale`.
 *
 * buildd's apps/web `applyCommand` is this with the Postgres store; the
 * conformance suite runs it on the in-memory store.
 */
import type { Command } from './commands';
import type { CommandResult, DeliveryRef, Store } from './ports';
import { currentOf, reduce, stableIdempotencyKey } from './reducer';

export interface ApplyOptions {
  ref?: DeliveryRef;
  /** The fact this command applies; the transition links it (`applied_transition_id`). */
  factId?: string | null;
  newId?: () => string;
}

/** The ref a command addresses when the caller names none: opening and adoption address the owner. */
export function commandRef(cmd: Command, ref: DeliveryRef | undefined): DeliveryRef {
  if (ref) return ref;
  if (cmd.type === 'DeliveryOpened') return { workspaceId: cmd.workspaceId, ownerTaskId: cmd.ownerTaskId };
  if (cmd.type === 'PrBound' && cmd.adoption) return { workspaceId: cmd.adoption.workspaceId, ownerTaskId: cmd.adoption.ownerTaskId };
  throw new Error(`applyCommand: a delivery ref is required for ${cmd.type}`);
}

export async function applyCommandOn(store: Store, cmd: Command, opts: ApplyOptions = {}): Promise<CommandResult> {
  const ref = commandRef(cmd, opts.ref);
  let view = await store.loadView(ref);

  for (let pass = 0; pass < 2; pass++) {
    const d = view.delivery;
    // §14: a delivery released to legacy is never decided by the kernel again,
    // whoever asks (a draining effect's report, a sweep, a door that raced the release).
    if (d?.authority === 'legacy') return { result: 'rejected', reason: 'legacy_owns', current: currentOf(view) };
    const key = stableIdempotencyKey(cmd, d);
    if (d && key) {
      const hit = await store.findTransition(d.id, key);
      if (hit) return { result: 'duplicate', transitionId: hit.id, reason: 'idempotency_key_seen', current: currentOf(view) };
    }

    const decision = reduce(view, cmd, { newId: opts.newId });
    if (decision.result === 'duplicate') return { result: 'duplicate', transitionId: null, reason: decision.reason, current: decision.current };
    if (decision.result === 'stale' || decision.result === 'rejected') {
      if (d && decision.record) await store.recordOnly(d.id, decision.record);
      return decision.result === 'stale'
        ? { result: 'stale', reason: decision.reason, current: decision.current }
        : { result: 'rejected', reason: decision.reason, missing: decision.missing, current: decision.current };
    }

    // A replayed key (or a racing single-flight insert) aborts the write
    // atomically; nothing was written. Either conflict: re-read and decide again.
    const w = await store.applyTransition(decision, { deliveryId: d?.id ?? null, factId: opts.factId ?? null });
    if (w.status === 'applied') {
      return { result: 'applied', transitionId: w.transitionId, deliveryId: w.deliveryId, version: w.version, decision };
    }
    view = await store.loadView(d ? { deliveryId: d.id } : ref);
    if (decision.create && view.delivery) {
      // Lost the open race: the delivery exists; T1 / adoption replay is a duplicate.
      return { result: 'duplicate', transitionId: null, reason: 'delivery_exists', current: currentOf(view) };
    }
  }
  return { result: 'stale', reason: 'cas_conflict', current: currentOf(view) };
}
