// The ONE three-state classifier for release surfaces (spec §9, AC-42..AC-45).
//
// §9.1 names three conditions that the code used to collapse into one blank
// render, which made a built feature indistinguishable from an unbuilt one:
//
//   none      archetype is `none` — render nothing, permanently, and issue no
//             release query at all (AC-42). This is the ONLY state reached
//             without looking at release data.
//   unseeded  archetype is release-capable and there is a signal to render:
//             the queue measured against whichever rung of the baseline ladder
//             resolved (@buildd/core/release-baseline), or the last deploy
//             state for a continuous workspace. Normal on day one — MUST NOT
//             be hidden or treated as an error.
//   clean     archetype is release-capable but there is nothing to ship:
//             queue depth is genuinely zero, or no baseline could be resolved
//             at all, or a continuous workspace has no deploy state yet.
//
// `none` and `clean` render identically (nothing) but are *computed*
// differently on purpose. A surface that special-cases `none` before querying
// and falls through to `clean` for everything else cannot regress into the
// epoch-baseline bug (`c3ea1d05`, PR #1905) where a null baseline silently
// became "everything since 1970": the `clean` variants of ReleaseState carry no
// count at all, so an unresolvable baseline has no way to become a number.
//
// Every release surface classifies through this function so two surfaces
// rendering the same mission in one request cycle cannot disagree (AC-45).
import type { ReleaseArchetype } from '@buildd/core/release-archetype';
import type { ReleaseBaselineSource } from '@buildd/core/release-baseline';
import type { ReleaseFooterData } from '@/components/MissionReleaseFooter';

export type ReleaseStateName = 'none' | 'unseeded' | 'clean';

/**
 * Why a release-capable workspace has nothing to render. Diagnostic only — all
 * `clean` reasons render identically to `none`, because a reader does not need
 * to know *why* there is nothing to ship, only that there is nothing to ship.
 */
export type ReleaseCleanReason =
  /** A baseline resolved and the queue against it is genuinely zero. */
  | 'zero_queue'
  /** No rung of the ladder resolved — not even prod-branch HEAD. Never a count. */
  | 'no_baseline'
  /** Continuous workspace that has never recorded a deploy. */
  | 'no_deploy_state'
  /** Release-capable archetype with no release pipeline wired (store/package). */
  | 'no_pipeline';

export type ReleaseState =
  | { state: 'none' }
  | { state: 'clean'; reason: ReleaseCleanReason }
  | {
      state: 'unseeded';
      archetype: 'gated';
      /** True once a verified `healthy` release anchors the baseline. Drives the "no releases yet" chrome. */
      seeded: boolean;
      baselineSource: ReleaseBaselineSource;
      queueDepth: number;
      oldestMergedAt: string | null;
      releaseId: string | null;
    }
  | {
      state: 'unseeded';
      archetype: 'continuous';
      seeded: boolean;
      deployState: string;
      deployedAt: string | null;
      healthyAt: string | null;
      releaseId: string | null;
    };

export type VisibleReleaseState = Extract<ReleaseState, { state: 'unseeded' }>;

/**
 * AC-42: archetype `none` must skip the baseline and queue queries entirely.
 * Call this before loading release data, not after.
 */
export function shouldQueryRelease(archetype: ReleaseArchetype): boolean {
  return archetype !== 'none';
}

/** True only for the state that renders something. `none` and `clean` are both blank. */
export function isReleaseVisible(state: ReleaseState): state is VisibleReleaseState {
  return state.state === 'unseeded';
}

export function classifyReleaseState(input: {
  archetype: ReleaseArchetype;
  /** Loader output (`loadReleaseFooterData`). Not consulted when archetype is `none`. */
  data: ReleaseFooterData;
}): ReleaseState {
  // The archetype branch: decided without touching release data, so a `none`
  // workspace never needs a query to reach its rendering (AC-42).
  if (!shouldQueryRelease(input.archetype)) return { state: 'none' };

  const { data } = input;

  if (!data) {
    // The loader returns null for a continuous workspace with no release row —
    // that is `clean`, NOT `none` (§9.1: they must never be computed the same way).
    return { state: 'clean', reason: input.archetype === 'continuous' ? 'no_deploy_state' : 'no_pipeline' };
  }

  if (data.archetype === 'gated') {
    // No rung of the ladder resolved. Render nothing and expose no number —
    // this is the branch where `c3ea1d05` fabricated an epoch-keyed count.
    if (data.queueDepth.kind === 'unavailable') return { state: 'clean', reason: 'no_baseline' };
    if (data.queueDepth.value === 0) return { state: 'clean', reason: 'zero_queue' };

    return {
      state: 'unseeded',
      archetype: 'gated',
      seeded: data.baselineSource === 'healthy',
      baselineSource: data.baselineSource,
      queueDepth: data.queueDepth.value,
      oldestMergedAt: data.oldestMergedAt.kind === 'value' ? data.oldestMergedAt.value : null,
      releaseId: data.releaseId,
    };
  }

  if (!data.state) return { state: 'clean', reason: 'no_deploy_state' };

  return {
    state: 'unseeded',
    archetype: 'continuous',
    seeded: data.state === 'healthy',
    deployState: data.state,
    deployedAt: data.deployedAt,
    healthyAt: data.healthyAt,
    releaseId: data.releaseId,
  };
}
