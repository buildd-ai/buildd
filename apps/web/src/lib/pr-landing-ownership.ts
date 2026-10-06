/**
 * Pure half of landing ownership (no db): the read model Home and the reviewer
 * gate share. See pr-landing-handoff.ts for the persisted handoff record.
 */

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


/** The workspace's landing mode, read the way `resolveLandingMode` (pr-landing.ts) reads it. */
export function landingModeOf(gitConfig: { landing?: { mode?: unknown } } | null | undefined): LandingOwnershipInput['landingMode'] {
  const mode = gitConfig?.landing?.mode;
  return mode === 'off' || mode === 'shadow' || mode === 'enforce' ? mode : 'shadow';
}
