// ============================================================================
// MODEL POLICY CELLS — the per tier x surface read model
// ============================================================================
//
// One read model per team: for every tier x surface cell, which model is the
// primary, which models it may also use, the one dial that governs how far
// traffic may move off the primary, and what state the cell's learning is in.
//
// Produced by `packages/core/tier-dial-source.ts` (`buildModelPolicyCells`),
// served by `GET /api/model-tiers/cells`. The settings UI and chat learning
// consume it; the UI renders `state` verbatim, so the four state names below
// are user-facing words, not internal codes.

/** Surfaces a cell exists on: agent runs (the policy's `coding`) and chat turns. */
export type ModelPolicyCellSurface = 'agent' | 'chat';

export type ModelPolicyCellTier = 'premium-plus' | 'premium' | 'standard' | 'budget';

/**
 * 1 = always the primary ... 5 = cheapest that keeps up. 3 is balanced.
 * The dial sets both the tolerance (how close an alternate's outcome rates
 * must be to the primary's) and the most traffic an alternate may take.
 */
export type ModelPolicyDial = 1 | 2 | 3 | 4 | 5;
export const MODEL_POLICY_DIAL_DEFAULT: ModelPolicyDial = 3;
export const MODEL_POLICY_DIALS: readonly ModelPolicyDial[] = [1, 2, 3, 4, 5];

/**
 * - `always`   — the primary serves every run (dial 1, or no alternates).
 * - `learning` — shadow: the primary still serves every run; buildd records
 *                which alternate it would have picked and grades it on the
 *                team's own outcomes until `progress.graded` reaches
 *                `progress.threshold`.
 * - `shifted`  — an alternate matched the primary within the dial's
 *                tolerance; `share` of the cell's eligible runs go to it.
 * - `reverted` — the alternate fell behind after shifting; traffic is back on
 *                the primary and `revertReason` says why.
 */
export type ModelPolicyCellState = 'always' | 'learning' | 'shifted' | 'reverted';

/**
 * Where the cell's primary came from: the team's registry row, a workspace
 * override row, buildd's default, or the remote policy service.
 */
export type ModelPolicyCellSource = 'team' | 'workspace' | 'default' | 'service';

export interface ModelPolicyCellModel {
  provider: string;
  model: string;
}

export interface ModelPolicyCellProgress {
  /** Graded runs the alternate under evaluation has. */
  graded: number;
  /** Graded runs needed before a promotion is considered (see tier-dial.ts). */
  threshold: number;
  /** Graded runs the primary has in this cell (it needs `threshold` too). */
  primaryGraded: number;
  /** The alternate the shadow would have picked. */
  candidate: string | null;
  /** Days to reach `threshold` at the cell's current pace; null when unknown. */
  etaDays: number | null;
  /** Plain-language note when the threshold is met but the cell still waits. */
  note?: string;
}

export interface ModelPolicyRecentRun {
  taskId: string;
  at: string;
  merged: boolean | null;
  reviewOk: boolean | null;
}

/** "What ran" for one model in a cell, over the read model's window. */
export interface ModelPolicyCellRun {
  model: string;
  /** Fraction of the cell's runs this model served. */
  share: number;
  runs: number;
  /** Null until any run of this model is graded on that signal. */
  mergedRate: number | null;
  reviewOkRate: number | null;
  costPerRunUsd: number | null;
  /**
   * Chat cells only, once chat learning reports them: share of conversations
   * rated satisfied, thumbs counts, and share re-asked. Absent until then.
   */
  satisfiedRate?: number | null;
  thumbsUp?: number;
  thumbsDown?: number;
  reaskedRate?: number | null;
  recentRuns: ModelPolicyRecentRun[];
}

export interface ModelPolicyCell {
  tier: ModelPolicyCellTier;
  surface: ModelPolicyCellSurface;
  primary: ModelPolicyCellModel;
  alternates: ModelPolicyCellModel[];
  dial: ModelPolicyDial;
  state: ModelPolicyCellState;
  /** Set while `learning`. */
  progress?: ModelPolicyCellProgress;
  /** Set while `shifted`: the target share of eligible runs on the alternate. */
  share?: number;
  /** Set while `shifted`: which alternate takes `share`. */
  shiftedTo?: string;
  source: ModelPolicyCellSource;
  /** An experiment (an exact split or a model-routing experiment) is running on this cell. */
  experimentRunning?: boolean;
  /** Workspaces with their own registry row for this tier; they keep their own model. */
  overrideCount: number;
  /** Set while `reverted` (and kept in history after). */
  revertReason?: string;
  /** Set while `reverted`: the alternate that slipped. */
  revertedFrom?: string;
  /**
   * Chat cells: what the cell learns from. `chat-retro` = the team's chat
   * retro verdicts plus thumbs; `none` = chat retros are off, so the cell can
   * run a fixed split but the dial cannot move traffic ("no quality signal").
   */
  qualitySignal?: 'chat-retro' | 'none';
  /**
   * Why the cell cannot move traffic right now, in plain words: no quality
   * signal, a retro judge from the same family as one of the cell's models,
   * or a judge that disagrees with people too often.
   */
  heldReason?: string;
  /** The pool backing this cell, when one exists. */
  poolId?: string | null;
  whatRan: ModelPolicyCellRun[];
}

export interface ModelPolicyCellsResponse {
  teamId: string;
  generatedAt: string;
  /** Days of runs `whatRan` covers. */
  windowDays: number;
  cells: ModelPolicyCell[];
  /** Distinct workspaces with their own registry row for any tier. */
  overrideWorkspaces: number;
}

export function isModelPolicyDial(v: unknown): v is ModelPolicyDial {
  return typeof v === 'number' && (MODEL_POLICY_DIALS as readonly number[]).includes(v);
}
