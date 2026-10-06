/**
 * Landing ownership as a read model: who owns the next move on a PR the
 * platform is landing, derived from the same marker (`tasks.context.landing`),
 * merge policy and landing mode the landing function itself uses.
 *
 * Under an agent-review `approve-and-merge` policy with `landing.mode=enforce`
 * a clean approved PR is the platform's to land: it is refreshed from its base,
 * re-checked, re-reviewed and merged without a person in the loop. Home must
 * never render a human MERGE card for it from a transient approved+green
 * snapshot. The one thing that hands it to a person is landPr itself returning
 * `needs_human`, which `recordLandingHandoff` persists (`tasks.context.landingHandoff`)
 * bound to the head it was decided for. A new head, such as the one a base
 * refresh produces, invalidates that record by construction.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { MergePolicy } from '@buildd/shared';
import type { LandingMarker } from './pr-landing-marker';
import { parseLandingMarker } from './pr-landing-marker';

export interface LandingHandoff {
  prNumber: number;
  /** The head the platform handed over at. A different live head means the record is stale. */
  headSha: string;
  cause: string;
  reason: string;
  /** When landPr recorded it (ISO). A refresh marker written after this supersedes it. */
  at?: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseLandingHandoff(raw: unknown, prNumber: number): LandingHandoff | null {
  if (!isObj(raw) || raw.prNumber !== prNumber) return null;
  if (typeof raw.headSha !== 'string' || !raw.headSha) return null;
  return {
    prNumber,
    headSha: raw.headSha,
    cause: typeof raw.cause === 'string' ? raw.cause : 'unknown',
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : 'Landing needs a person',
    at: typeof raw.at === 'string' ? raw.at : null,
  };
}

/** Does the merge policy leave the final merge to the platform once the review is satisfied? */
export function policyLandsAutomatically(policy: Pick<MergePolicy, 'tier' | 'agentReview'>): boolean {
  return policy.tier === 'agent-review' && policy.agentReview?.gateCondition !== 'approve-only';
}

export type LandingOwnership =
  /** Landing is not enforced (or the policy is not platform-landed): the caller's own reading stands. */
  | { owner: 'unmanaged' }
  | { owner: 'platform'; state: 'refreshing' | 'landing'; reason: string }
  | { owner: 'human'; reason: string };

export interface LandingOwnershipInput {
  policy: Pick<MergePolicy, 'tier' | 'agentReview'>;
  landingMode: 'off' | 'shadow' | 'enforce';
  /** `tasks.context.landing` and `tasks.context.landingHandoff` of the owning task. */
  landing: unknown;
  handoff: unknown;
  prNumber: number;
  /**
   * The PR's live head, only when the caller truly has it (NOT `workers.lastCommitSha`,
   * which is the worker's own last commit and does not move on a platform base refresh).
   * Staleness otherwise comes from the marker: a refresh writes it after the handoff.
   */
  prHeadSha?: string | null;
}

/**
 * THE ownership derivation. Pure: the marker names a platform refresh in
 * flight; a handoff bound to the current head names a person; otherwise a
 * platform-landed policy under enforce is the platform's, whatever transient
 * approved+green snapshot the dashboard happens to see.
 */
export function resolveLandingOwnership(input: LandingOwnershipInput): LandingOwnership {
  if (input.landingMode !== 'enforce' || !policyLandsAutomatically(input.policy)) return { owner: 'unmanaged' };
  const handoff = parseLandingHandoff(input.handoff, input.prNumber);
  const marker: LandingMarker | null = parseLandingMarker({ landing: input.landing }, input.prNumber);
  if (handoff) {
    const headMoved = !!input.prHeadSha && handoff.headSha !== input.prHeadSha;
    const handoffMs = handoff.at ? Date.parse(handoff.at) : NaN;
    const markerMs = marker?.updatedAt ? Date.parse(marker.updatedAt) : NaN;
    const refreshedSince = !!marker && (Number.isNaN(handoffMs) || (!Number.isNaN(markerMs) && markerMs >= handoffMs));
    if (!headMoved && !refreshedSince) return { owner: 'human', reason: handoff.reason };
  }
  return marker
    ? { owner: 'platform', state: 'refreshing', reason: 'Updating the branch from its base · lands automatically' }
    : { owner: 'platform', state: 'landing', reason: 'Lands automatically once checks and review pass' };
}

/** Persist a handoff for the head it was decided on. One atomic UPDATE. */
export async function writeLandingHandoff(taskId: string, handoff: LandingHandoff): Promise<void> {
  const json = JSON.stringify({ ...handoff, at: new Date().toISOString() });
  await db
    .update(tasks)
    .set({ context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), '{landingHandoff}', ${json}::jsonb, true)` })
    .where(eq(tasks.id, taskId));
}

/** Drop a stale handoff; a no-op write is skipped by the WHERE. */
export async function clearLandingHandoff(taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ context: sql`${tasks.context} - 'landingHandoff'` })
    .where(and(eq(tasks.id, taskId), sql`${tasks.context} ? 'landingHandoff'`));
}
