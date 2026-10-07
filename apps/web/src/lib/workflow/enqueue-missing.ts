/**
 * §11 permitted operation 2, "re-enqueue a missing effect": for each state the
 * kernel names the effect that MUST exist, and a sweep inserts the missing row
 * under the effect's own dedupe key. The keys are the reducer's, so an effect
 * that exists in any status (pending, done, dead) is never owed twice, and a
 * re-enqueued effect is handled exactly as the original would have been (its
 * handler revalidates, §10.5).
 *
 * `enqueueMissingEffects` is a pure function of (state, attributes, existing
 * effects). It never writes state and never decides one: an owed effect whose
 * premise has moved on (a newer head, a spent budget) is refused by the
 * transition its handler issues, not here.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { EffectSpec } from './commands';
import { PUSH_RECOVERY_BACKOFF_MS } from './reducer';
import type { KernelView, RoundSnapshot } from './types';

const OPEN_ATTEMPT = new Set(['queued', 'running']);

/** The effects `view`'s state owes and `existing` (the delivery's dedupe keys) does not hold. */
export function enqueueMissingEffects(view: KernelView, existing: ReadonlySet<string>): EffectSpec[] {
  const d = view.delivery;
  if (!d) return [];
  const owed: EffectSpec[] = [];
  const current = view.rounds.find((r) => r.round === d.currentRound);
  const lastDecidedBefore = (round: number): RoundSnapshot | undefined =>
    view.rounds.filter((r) => r.status === 'decided' && r.round < round).sort((a, b) => b.round - a.round)[0];

  switch (d.state) {
    case 'CHANGES_REQUESTED': {
      // A dispatch_fix for the current round (T6 / §6.5). A round not at the current head is a
      // head fact's business (T3 starts r+1), never a fix for the old head.
      if (!current || current.status !== 'decided' || current.effectiveVerdict !== 'request_changes' || current.headSha !== d.currentHeadSha) break;
      const fixes = view.attempts.filter((a) => a.family === 'review_fix' && a.mode === 'agent');
      if (fixes.some((a) => a.triggerReason === current.id && OPEN_ATTEMPT.has(a.status))) break;
      const n = fixes.reduce((m, a) => Math.max(m, a.attemptNo), 0) + 1;
      owed.push({
        kind: 'dispatch_fix', dedupeKey: `dispatch_fix:${d.id}:${current.id}:${n}`,
        payload: { roundId: current.id, round: current.round, headSha: current.headSha, attemptNo: n },
      });
      break;
    }
    case 'AWAITING_REVIEW': {
      // A queued round at the current head has a dispatch_review (startRound's key).
      if (!current || current.status !== 'queued' || current.headSha !== d.currentHeadSha) break;
      const prior = lastDecidedBefore(current.round)?.round ?? null;
      owed.push({
        kind: 'dispatch_review', dedupeKey: `dispatch_review:${d.id}:${current.round}`,
        payload: { roundId: current.id, round: current.round, headSha: current.headSha, kind: current.kind, priorRound: prior, scope: current.scope ?? null },
      });
      break;
    }
    case 'AWAITING_PUSH': {
      // A push_recovery chain for the pending local head; any try of it, done or not, counts.
      const local = view.attempts.find((a) => a.id === d.boundAttemptId)?.reportedShas.at(-1) ?? d.pushPendingLocalHead ?? null;
      const prefix = `push_recovery:${d.id}:${local ?? 'none'}:`;
      if ([...existing].some((k) => k.startsWith(prefix))) break;
      owed.push({
        kind: 'push_recovery', dedupeKey: `${prefix}1`,
        payload: { localHeadSha: local, try: 1, maxTries: PUSH_RECOVERY_BACKOFF_MS.length },
      });
      break;
    }
    default:
      break;
  }
  return owed.filter((e) => !existing.has(e.dedupeKey));
}

/** Every effect dedupe key the delivery holds, in any status. */
export function existingEffectsSql(deliveryId: string): SQL {
  return sql`-- workflow:existing_effects
SELECT dedupe_key FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid`;
}

/**
 * Insert one owed effect, attached to the delivery's latest transition and
 * only while the delivery is still at the version the sweep read: a delivery
 * that moved meanwhile owes whatever its new state owes, decided next pass.
 */
export function enqueueEffectSql(deliveryId: string, version: number, e: EffectSpec): SQL {
  return sql`-- workflow:enqueue_missing_effect
INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, not_before)
SELECT d.id, tr.id, ${e.kind}::text, ${e.dedupeKey}::text, ${JSON.stringify(e.payload)}::jsonb, now() + make_interval(secs => ${e.delayMs ?? 0}::bigint / 1000.0)
FROM workflow_deliveries d,
  LATERAL (SELECT id FROM workflow_transitions WHERE delivery_id = d.id ORDER BY to_version DESC LIMIT 1) tr
WHERE d.id = ${deliveryId}::uuid AND d.version = ${version}::int
ON CONFLICT (dedupe_key) DO NOTHING
RETURNING id`;
}
