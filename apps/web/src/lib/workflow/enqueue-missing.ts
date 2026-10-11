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
 * transition its handler issues, not here. A `dead` key still counts as held,
 * except where a case says otherwise (AWAITING_PUSH, LANDING): there the dead
 * effect was the state's only exit.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { EffectSpec } from './commands';
import { currentPushEntry, PUSH_RECOVERY_BACKOFF_MS, pushChainId } from './reducer';
import type { KernelView, RoundSnapshot } from './types';

const OPEN_ATTEMPT = new Set(['queued', 'running']);

const LIVE_EFFECT = new Set(['pending', 'delivering']);

/**
 * The effects `view`'s state owes and `existing` (the delivery's dedupe keys) does not hold.
 * `status` maps a key to its row status when the caller read it (existingEffectsSql does):
 * the cases that must tell a dead or a still-running effect from a finished one use it.
 */
export function enqueueMissingEffects(view: KernelView, existing: ReadonlySet<string>, status: ReadonlyMap<string, string> = new Map()): EffectSpec[] {
  const d = view.delivery;
  if (!d) return [];
  const isLive = (k: string) => LIVE_EFFECT.has(status.get(k) ?? '');
  const isDead = (k: string) => status.get(k) === 'dead';
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
      const payload = { roundId: current.id, round: current.round, headSha: current.headSha, kind: current.kind, priorRound: prior, scope: current.scope ?? null };
      const base = `dispatch_review:${d.id}:${current.round}`;
      if (!existing.has(base)) {
        owed.push({ kind: 'dispatch_review', dedupeKey: base, payload });
        break;
      }
      // a6cbd241: the round's dispatches all finished and none asked a reviewer (one acked
      // `skipped:superseded` because the delivery was briefly elsewhere, then came back to this
      // round). A finished key still holds its own slot, so the round owes a fresh one. Only
      // when every dispatch for the round is known `done`: a live one is the round's exit, a
      // dead one is EffectDead's business, and an unread status proves nothing.
      if (current.reviewerTaskId) break;
      const keys = [...existing].filter((k) => k === base || k.startsWith(`${base}:`));
      if (!keys.every((k) => status.get(k) === 'done')) break;
      owed.push({ kind: 'dispatch_review', dedupeKey: `${base}:floor:v${d.version}`, payload });
      break;
    }
    case 'AWAITING_PUSH': {
      // A push_recovery try still to run owns the next move: pending or delivering, in any chain of
      // this delivery (the attempt's end keys its chain by the L it reported, which need not be the
      // head this sweep reads, so a chain under another L still counts). A key whose status the
      // caller did not read counts as live.
      const local = view.attempts.find((a) => a.id === d.boundAttemptId)?.reportedShas.at(-1) ?? d.pushPendingLocalHead ?? null;
      // The chain of this visit (10658a4c): a later visit at the same L is its own chain.
      const prefix = `push_recovery:${d.id}:${pushChainId(local, currentPushEntry(d))}:`;
      const tries = [...existing].filter((k) => k.startsWith(`push_recovery:${d.id}:`));
      if (tries.some((k) => !status.has(k) || isLive(k))) break;
      const chain = tries.filter((k) => k.startsWith(prefix));
      const maxTries = PUSH_RECOVERY_BACKOFF_MS.length;
      // 67d34094: a chain that died owes its last try, which re-reads GitHub and, with the head
      // still unmoved, is T22 (ESCALATED(push_undeliverable)). A dead key never blocks it.
      // 9e27996d: so does a chain that ended with no try left to run and no exit taken (every try
      // done, the delivery still here): AWAITING_PUSH is never left without an owner (§4).
      owed.push(chain.length === 0
        ? { kind: 'push_recovery', dedupeKey: `${prefix}1`, payload: { localHeadSha: local, try: 1, maxTries } }
        : { kind: 'push_recovery', dedupeKey: `${prefix}final`, payload: { localHeadSha: local, try: maxTries, maxTries } });
      break;
    }
    case 'LANDING': {
      // 67d34094: LANDING has an exit only while its merge call or read-back runs. With neither
      // live (dead, or done with the delivery somehow still here), owe one more read-back: it
      // re-reads the PR and is T17 (merged), a head fact, or MergeCallResult(not_merged) → APPROVED.
      // The floor's own fact import already ran T17 for a PR it saw merged.
      const landingKeys = [...existing].filter((k) => k.startsWith(`merge_call:${d.id}:`) || k.startsWith(`verify_merge:${d.id}:`));
      if (landingKeys.some(isLive) || !d.currentHeadSha) break;
      owed.push({
        kind: 'verify_merge', dedupeKey: `verify_merge:${d.id}:${d.currentHeadSha}:floor:v${d.version}`,
        payload: { headSha: d.currentHeadSha, outcome: 'indeterminate', landingVersion: d.version, source: 'floor' },
      });
      break;
    }
    default:
      break;
  }
  return owed.filter((e) => !existing.has(e.dedupeKey));
}

/** Every effect dedupe key the delivery holds, in any status, with that status. */
export function existingEffectsSql(deliveryId: string): SQL {
  return sql`-- workflow:existing_effects
SELECT dedupe_key, status FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid`;
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
