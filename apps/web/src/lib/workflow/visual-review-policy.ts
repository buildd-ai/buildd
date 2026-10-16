/**
 * The Visual Review policy, resolved: team default -> workspace override ->
 * mission exception (docs/specs/mission-task-lifecycle.md, "Visual review").
 *
 * Pure. The workspace override lives in `workspaces.gitConfig.visualReview.policy`
 * (read with `visualReviewPolicyOf`), so no migration. `missions.autoSurfaceAudit`
 * is the legacy mission switch: true is "inherit", false is an `off` exception.
 * No team column exists yet, so callers pass the platform default as `team`
 * (or nothing) until one does.
 */
import { DEFAULT_VISUAL_REVIEW_POLICY, type VisualReviewPolicyMode } from '@buildd/shared';

export type VisualReviewPolicyOrigin = 'default' | 'team' | 'workspace' | 'mission';

export interface VisualReviewPolicyInput {
  team?: VisualReviewPolicyMode | null;
  workspace?: VisualReviewPolicyMode | null;
  mission?: { policy?: VisualReviewPolicyMode | null; autoSurfaceAudit?: boolean | null } | null;
}

export interface ResolvedVisualReviewPolicy {
  mode: VisualReviewPolicyMode;
  /** Which level set `mode`. */
  origin: VisualReviewPolicyOrigin;
  /** What the mission would inherit without its exception (equals mode/origin when it has none). */
  inherited: { mode: VisualReviewPolicyMode; origin: Exclude<VisualReviewPolicyOrigin, 'mission'> };
  /** Skip / waive is permitted. False only under strict. */
  waiverAllowed: boolean;
  /** Strict: a mission cannot hold an exception. */
  locked: boolean;
  /** A mission exception exists but strict ignored it. */
  exceptionIgnored: boolean;
}

/** Legacy `missions.autoSurfaceAudit` as a mission exception: true/null inherit, false is off. */
export function legacyMissionException(autoSurfaceAudit: boolean | null | undefined): VisualReviewPolicyMode | null {
  return autoSurfaceAudit === false ? 'off' : null;
}

export function resolveVisualReviewPolicy(input: VisualReviewPolicyInput): ResolvedVisualReviewPolicy {
  const inherited: ResolvedVisualReviewPolicy['inherited'] = input.workspace
    ? { mode: input.workspace, origin: 'workspace' }
    : input.team
      ? { mode: input.team, origin: 'team' }
      : { mode: DEFAULT_VISUAL_REVIEW_POLICY, origin: 'default' };

  const exception = input.mission?.policy ?? legacyMissionException(input.mission?.autoSurfaceAudit);
  const locked = inherited.mode === 'strict';
  if (exception && !locked) {
    return { mode: exception, origin: 'mission', inherited, waiverAllowed: exception !== 'strict', locked: false, exceptionIgnored: false };
  }
  return {
    mode: inherited.mode,
    origin: inherited.origin,
    inherited,
    waiverAllowed: !locked,
    locked,
    exceptionIgnored: locked && !!exception,
  };
}
