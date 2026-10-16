/**
 * A merge GitHub reports for a delivery the kernel already resolved without one (ABANDONED or
 * SUPERSEDED): docs/specs/workflow-kernel-library.md §1 AC-4, S4a review.
 *
 * The state machine has no edge out of those terminal states (T17 answers `stale: terminal`), and
 * this slice does not add one, so the merge is not applied: the worker rows keep the close the
 * delivery projected, and the fact funnel will not stamp a merge over it (pr-fact-scope.ts).
 * Before S4a the legacy writers would have stamped it silently. Now it is recorded loudly:
 *
 *  - the fact row carries `payload.contradiction` (what GitHub said, the state it contradicts),
 *    so the delivery's view (delivery-view.ts) shows it, and `explain` with it;
 *  - one `notify` effect per delivery (`merged_after_resolution`) asks a person to look: the work
 *    may have shipped under a PR buildd counts as dropped, which mission completion and
 *    dependents read.
 *
 * Idempotent: a re-ingest of the same merge marks nothing new and queues nothing twice.
 */
import { sql } from 'drizzle-orm';
import type { Exec } from './kernel';
import type { LivePr } from './commands';
import { insertFollowupEffectSql } from './effects';

export type ResolvedState = 'ABANDONED' | 'SUPERSEDED';
export const isResolvedWithoutMerge = (s: string | null | undefined): s is ResolvedState => s === 'ABANDONED' || s === 'SUPERSEDED';

export function markFactContradictionSql(factId: string, c: { state: ResolvedState; live: LivePr }): ReturnType<typeof sql> {
  const contradiction = {
    reason: `merged_after_${c.state.toLowerCase()}`, deliveryState: c.state,
    mergedAt: c.live.mergedAt ?? null, mergeCommitSha: c.live.mergeCommitSha ?? null, mergedBy: c.live.mergedBy ?? null, headSha: c.live.headSha,
  };
  return sql`-- workflow:fact_contradiction
UPDATE workflow_facts SET payload = payload || jsonb_build_object('contradiction', ${JSON.stringify(contradiction)}::jsonb)
WHERE id = ${factId}::uuid AND NOT (payload ? 'contradiction')
RETURNING id, delivery_id`;
}

/** The delivery's newest transition: the follow-up notice hangs off it (an effect always has one). */
export function latestTransitionSql(workspaceId: string, repoFullName: string, prNumber: number): ReturnType<typeof sql> {
  return sql`-- workflow:latest_transition_of_pr
SELECT d.id AS delivery_id, t.id AS transition_id FROM workflow_deliveries d
JOIN LATERAL (SELECT id FROM workflow_transitions tr WHERE tr.delivery_id = d.id ORDER BY tr.to_version DESC LIMIT 1) t ON true
WHERE d.workspace_id = ${workspaceId}::uuid AND d.repo_full_name = ${repoFullName}::text AND d.pr_number = ${prNumber}::int
LIMIT 1`;
}

/** Record the contradiction and queue the notice. Returns true when this call marked it first. */
export async function recordMergeContradiction(p: {
  workspaceId: string; repoFullName: string; prNumber: number; factId: string; state: ResolvedState; live: LivePr;
}, exec: Exec): Promise<boolean> {
  const marked = ((await exec(markFactContradictionSql(p.factId, { state: p.state, live: p.live }))).rows ?? []).length > 0;
  const t = ((await exec(latestTransitionSql(p.workspaceId, p.repoFullName, p.prNumber))).rows ?? [])[0] as { delivery_id?: string; transition_id?: string } | undefined;
  if (t?.delivery_id && t.transition_id) {
    await exec(insertFollowupEffectSql({
      deliveryId: String(t.delivery_id), transitionId: String(t.transition_id), kind: 'notify',
      dedupeKey: `notify:${t.delivery_id}:merged_after_resolution`,
      payload: { event: 'merged_after_resolution', state: p.state, mergedAt: p.live.mergedAt ?? null, mergedBy: p.live.mergedBy ?? null },
    }));
  }
  if (marked) {
    console.warn(JSON.stringify({ event: 'kernel_merge_contradiction', repo: p.repoFullName, prNumber: p.prNumber, deliveryState: p.state }));
  }
  return marked;
}
