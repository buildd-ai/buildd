/**
 * Early release — Layer 2: the Jev release decision (`buildd.early_release`).
 *
 * Should a dependent task start before its upstream task's PR merges? Three
 * answers: `start_now` (on trunk, the upstream change cannot affect it),
 * `start_stacked` (now, but on top of the upstream branch, because it needs
 * that code) or `wait` (today's behaviour: start once the upstream merges).
 * See `knowledge-base: buildd/design/early-release.md`, "Layer 2".
 *
 * Semantics this kind owns:
 *
 * - **Override**: the Layer 1 rules (`./early-release-rules.ts`). When one
 *   fires, the answer is `start_now` and no model is asked, in every mode,
 *   disabled included.
 * - **Features the model never re-derives**: the upstream diff shape (files,
 *   lines, touches schema / migrations) is computed here from the changed-file
 *   list during `parseFeatures`, so a caller cannot assert it and the model only
 *   reads it. The declared overlap is computed the same way.
 * - **Predicted manifests are unmeasured**: candidates from manifest
 *   prediction ride in the state under a key that says so, and are never fed to
 *   the rules (`zeroManifestOverlap` takes the author-declared manifest only).
 * - **Fallback is `wait` for every cause**: disabled, invalid features, no
 *   provider, a provider failure, low confidence, an unmeasured model, shadow.
 *   A decision that could not be made degrades to merge-gated, never to
 *   `start_now`.
 * - **Live** once its capability is on: no shadow-only phase. The only thing
 *   standing between a model answer and an early start is `minConfidence`.
 *
 * Pure apart from `dependentSizeBucket`, which reads neighbour sessions through
 * `estimateTaskSize`. Not wired to any route yet.
 */

import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, FeatureParse } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { intersectPaths } from '@buildd/core/path-overlap';
import type { EstimateTaskSizeArgs, ExpectedTaskSize } from '@buildd/core/task-size-estimate';
import { evaluateEarlyReleaseRules } from './early-release-rules';
import type { PrReviewState } from './pr-review-status';

export const EARLY_RELEASE_KIND = 'buildd.early_release' as const;
export const EARLY_RELEASE_CAPABILITY = 'early_release' as const;

export const EARLY_RELEASE_DECISIONS = ['start_now', 'wait', 'start_stacked'] as const;
export type EarlyReleaseKindDecision = (typeof EARLY_RELEASE_DECISIONS)[number];

export const EARLY_RELEASE_CI_STATES = ['green', 'pending', 'failing', 'unknown'] as const;
export type EarlyReleaseCiState = (typeof EARLY_RELEASE_CI_STATES)[number];

export const EARLY_RELEASE_SIZE_BUCKETS = ['S', 'M', 'L', 'unknown'] as const;
export type EarlyReleaseSizeBucket = (typeof EARLY_RELEASE_SIZE_BUCKETS)[number];

const PR_REVIEW_STATES: readonly PrReviewState[] = [
  'not_requested', 'queued', 'reviewing', 'approved', 'changes_requested', 'escalated', 'review_failed',
];

const MAX_PATHS = 500;
const MAX_PATH_LENGTH = 300;
const MAX_LINES = 1_000_000;
const MAX_SHAS = 20;

/**
 * Starting threshold for a brand-new kind with no held-out eval: PROVISIONAL.
 * Deliberately high, because a wrong `start_now` / `start_stacked` costs a
 * rebase or a wasted session while a wrong `wait` costs only today's latency.
 * Recalibrate from the ledger's labelled outcomes before lowering it.
 */
export const EARLY_RELEASE_MIN_CONFIDENCE = 0.85;

/** The deterministic shape of the upstream PR's diff. Never asked of the model. */
export interface UpstreamDiffShape {
  filesChanged: number;
  linesChanged: number;
  touchesSchema: boolean;
  touchesMigrations: boolean;
}

/** The dependent PR's review, as much of it as the Layer 1 rule needs. Ids and SHAs only, no text. */
export interface EarlyReleaseReviewFeatures {
  state: PrReviewState;
  merged: boolean;
  reviewTaskId: string | null;
  reviewHeadSha: string | null;
  reviewEquivalentHeadShas: string[];
}

export interface EarlyReleaseFeatures {
  /** Changed-file paths from the upstream task's PR diff. */
  upstreamChangedFiles: string[];
  /** Derived from `upstreamChangedFiles` and the caller's line count in `parseFeatures`. */
  upstreamDiff: UpstreamDiffShape;
  /** The dependent's author-declared pathManifest. Null when it declared none. */
  dependentPathManifest: string[] | null;
  /** Upstream files the declared manifest overlaps. Derived in `parseFeatures`. */
  declaredOverlap: string[];
  /** Predicted-manifest candidates: unmeasured guesses, never ground truth, never seen by the rules. */
  predictedManifestUnmeasured: string[];
  review: EarlyReleaseReviewFeatures;
  /** The dependent PR's current head SHA. */
  currentHeadSha: string | null;
  ci: EarlyReleaseCiState;
  /** The dependent's expected size (`sizeBucketFromEstimate`). */
  sizeBucket: EarlyReleaseSizeBucket;
}

/** Prisma/Drizzle schema files the dependent would compile against. */
const SCHEMA_PATH_RE = /(^|\/)(schema\.(ts|prisma|sql|graphql)|db\/schema(\/|\.))/;
/** Migration directories and SQL files. */
const MIGRATION_PATH_RE = /(^|\/)(drizzle|migrations?)\/|\.sql$/;

export function upstreamDiffShape(files: readonly string[], linesChanged: number): UpstreamDiffShape {
  return {
    filesChanged: files.length,
    linesChanged,
    touchesSchema: files.some(f => SCHEMA_PATH_RE.test(f)),
    touchesMigrations: files.some(f => MIGRATION_PATH_RE.test(f)),
  };
}

/**
 * Coarse bucket from the neighbour-based size estimate (`estimateTaskSize`).
 * Boundaries sit between the representative S/M/L file counts the size-bucket
 * fallback uses (3 / 8 / 20). Null (fewer than k neighbours) is `unknown`.
 */
export function sizeBucketFromEstimate(estimate: Pick<ExpectedTaskSize, 'files'> | null | undefined): EarlyReleaseSizeBucket {
  if (!estimate || typeof estimate.files !== 'number' || !Number.isFinite(estimate.files)) return 'unknown';
  return estimate.files <= 5 ? 'S' : estimate.files <= 13 ? 'M' : 'L';
}

/** The dependent's size bucket from its completed neighbours. Any failure is `unknown`. */
export async function dependentSizeBucket(
  args: EstimateTaskSizeArgs,
  deps: { estimateSize?: (a: EstimateTaskSizeArgs) => Promise<Pick<ExpectedTaskSize, 'files'> | null> } = {},
): Promise<EarlyReleaseSizeBucket> {
  const estimate = deps.estimateSize ?? (async (a: EstimateTaskSizeArgs) => (await import('@buildd/core/task-size-estimate')).estimateTaskSize(a));
  return sizeBucketFromEstimate(await estimate(args).catch(() => null));
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isShortString = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH_LENGTH;
const optString = (v: unknown): string | null | undefined =>
  v === null || v === undefined ? null : isShortString(v) ? v : undefined;

function parsePaths(v: unknown, name: string): { ok: true; paths: string[] } | { ok: false; message: string } {
  if (!Array.isArray(v)) return { ok: false, message: `${name} must be an array of paths` };
  if (v.length > MAX_PATHS) return { ok: false, message: `${name} has more than ${MAX_PATHS} paths` };
  if (!v.every(isShortString)) return { ok: false, message: `${name} must hold non-empty paths of at most ${MAX_PATH_LENGTH} characters` };
  return { ok: true, paths: [...new Set(v as string[])] };
}

function parseReview(v: unknown): EarlyReleaseReviewFeatures | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'review must be an object';
  const r = v as Record<string, unknown>;
  if (!PR_REVIEW_STATES.includes(r.state as PrReviewState)) return 'review.state must be a known review state';
  if (typeof r.merged !== 'boolean') return 'review.merged must be a boolean';
  const reviewTaskId = optString(r.reviewTaskId);
  const reviewHeadSha = optString(r.reviewHeadSha);
  if (reviewTaskId === undefined) return 'review.reviewTaskId must be a string or null';
  if (reviewHeadSha === undefined) return 'review.reviewHeadSha must be a string or null';
  const eq = r.reviewEquivalentHeadShas ?? [];
  if (!Array.isArray(eq) || eq.length > MAX_SHAS || !eq.every(isShortString)) {
    return `review.reviewEquivalentHeadShas must be at most ${MAX_SHAS} SHAs`;
  }
  return { state: r.state as PrReviewState, merged: r.merged, reviewTaskId, reviewHeadSha, reviewEquivalentHeadShas: [...eq] };
}

/**
 * Caller input: `upstreamChangedFiles`, `upstreamLinesChanged`,
 * `dependentPathManifest` (or null), `predictedManifestCandidates` (optional),
 * `review`, `currentHeadSha`, `ci`, `sizeBucket`. The diff shape and the
 * declared overlap are computed here, not accepted.
 */
export function parseEarlyReleaseFeatures(input: unknown): FeatureParse<EarlyReleaseFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const f = input as Record<string, unknown>;

  const upstream = parsePaths(f.upstreamChangedFiles, 'upstreamChangedFiles');
  if (!upstream.ok) return upstream;
  if (!isCount(f.upstreamLinesChanged)) return { ok: false, message: 'upstreamLinesChanged must be a non-negative integer' };

  let manifest: string[] | null = null;
  if (f.dependentPathManifest !== null && f.dependentPathManifest !== undefined) {
    const m = parsePaths(f.dependentPathManifest, 'dependentPathManifest');
    if (!m.ok) return m;
    manifest = m.paths;
  }

  let predicted: string[] = [];
  if (f.predictedManifestCandidates !== null && f.predictedManifestCandidates !== undefined) {
    const p = parsePaths(f.predictedManifestCandidates, 'predictedManifestCandidates');
    if (!p.ok) return p;
    predicted = p.paths;
  }

  const review = parseReview(f.review);
  if (typeof review === 'string') return { ok: false, message: review };
  const currentHeadSha = optString(f.currentHeadSha);
  if (currentHeadSha === undefined) return { ok: false, message: 'currentHeadSha must be a string or null' };
  if (!(EARLY_RELEASE_CI_STATES as readonly unknown[]).includes(f.ci)) return { ok: false, message: 'ci must be a known CI state' };
  if (!(EARLY_RELEASE_SIZE_BUCKETS as readonly unknown[]).includes(f.sizeBucket)) return { ok: false, message: 'sizeBucket must be S, M, L or unknown' };

  return {
    ok: true,
    features: {
      upstreamChangedFiles: upstream.paths,
      upstreamDiff: upstreamDiffShape(upstream.paths, Math.min(f.upstreamLinesChanged, MAX_LINES)),
      dependentPathManifest: manifest,
      declaredOverlap: manifest ? intersectPaths(upstream.paths, manifest) : [],
      predictedManifestUnmeasured: predicted,
      review,
      currentHeadSha,
      ci: f.ci as EarlyReleaseCiState,
      sizeBucket: f.sizeBucket as EarlyReleaseSizeBucket,
    },
  };
}

/** Layer 1, as the kind's override. Free-text review fields are not features; the rules only use them for a reason string. */
export function earlyReleaseOverride(f: EarlyReleaseFeatures) {
  return evaluateEarlyReleaseRules({
    upstreamChangedFiles: f.upstreamChangedFiles,
    dependentPathManifest: f.dependentPathManifest,
    reviewStatus: { ...f.review, feedback: null, summary: null, escalationReason: null },
    currentHeadSha: f.currentHeadSha,
    requiredChecksGreen: f.ci === 'green',
  });
}

const questions = {
  release: choice(
    {
      question: 'A dependent software task is waiting for an upstream task\'s pull request to merge. The state describes the '
        + 'upstream diff, what the dependent declared it will touch, its pull request\'s review and CI, and its expected size. '
        + 'Should the dependent start now?',
      rule: 'Paths under predictedManifestUnmeasured are an unmeasured guess at what the dependent will touch, not a fact. '
        + 'A schema or migration change upstream, or overlap with what the dependent declared, is a reason to be careful. '
        + 'When unsure, wait.',
    },
    {
      start_now: 'Start now from the trunk: nothing the upstream changes can affect the dependent\'s work.',
      start_stacked: 'Start now on top of the upstream branch: the dependent needs the upstream code, and that code is unlikely to change before it merges.',
      wait: 'Wait for the upstream to merge: starting early risks rework or a conflict.',
    },
  ),
};

/** The kind's rules, questions and fallback. Pure; bound below with `defineBuilddDecisionKind`. */
export const EARLY_RELEASE_CONFIG: DecisionKindConfig<
  typeof EARLY_RELEASE_KIND, EarlyReleaseFeatures, EarlyReleaseKindDecision, typeof questions
> = {
  kind: EARLY_RELEASE_KIND,
  policyVersion: 'erel-2026-10-05.a',
  featureSchemaVersion: 'erel-features-v1',
  decisions: EARLY_RELEASE_DECISIONS,
  parseFeatures: parseEarlyReleaseFeatures,
  override: earlyReleaseOverride,
  questions,
  state: f => ({
    upstreamDiff: f.upstreamDiff,
    upstreamChangedFiles: f.upstreamChangedFiles,
    dependentDeclaredManifest: f.dependentPathManifest,
    declaredOverlap: f.declaredOverlap,
    predictedManifestUnmeasured: f.predictedManifestUnmeasured,
    dependentReview: f.review.state,
    dependentCi: f.ci,
    dependentSize: f.sizeBucket,
  }),
  interpret: a => ({ decision: a.release.choice, confidence: a.release.confidence, reasonCode: `model_${a.release.choice}` }),
  minConfidence: EARLY_RELEASE_MIN_CONFIDENCE,
  // Every cause degrades to today's merge-gated behaviour.
  fallback: (_f, cause) => ({ decision: 'wait', reasonCode: `fallback_${cause}` }),
};

/** Live once the capability is on. No escalation or challenger until measured. */
export const EARLY_RELEASE_BINDING: BuilddDecisionKindBinding = {
  capability: EARLY_RELEASE_CAPABILITY,
  mode: 'live',
};

export const earlyReleaseKind = defineBuilddDecisionKind(EARLY_RELEASE_CONFIG, EARLY_RELEASE_BINDING);
