/**
 * The coarser size-bucket fallback (knowledge-base: buildd/design/jev-scheduling.md
 * §3), for when `estimateTaskSize` (./task-size-estimate.ts) has fewer than
 * `k` completed neighbours to size from. A Jev Choice over S / M / L, mapped
 * to representative files/minutes so the result slots into the same
 * `ExpectedTaskSize` shape the planner already sorts on (`compareSize` in
 * `./claim-planner.ts`).
 *
 * Same rollout stance as `./orchestration-overlap-decision.ts`: `gated` with a
 * starting threshold, applying from the first PR (it only ever sets a size
 * estimate used for ordering — never a hard edge, never a manifest).
 *
 * Pure: no DB, no env. The I/O half is in `./manifest-prediction-source.ts`,
 * the only call site.
 */
import { choice, defineDecision } from '@builddai/ai-kit/decide';
import type { ExpectedTaskSize } from './db/schema';

export const SIZE_BUCKET_PROMPT_VERSION = 'sb1';
export const SIZE_BUCKET_CANDIDATE_POLICY_VERSION = 'sb1';

export const SIZE_BUCKET_QUESTIONS = {
  bucket: choice(
    {
      question: 'A software task is described in the state, with too few similar completed tasks to size it by '
        + 'precedent. How large is it likely to be?',
      rule: 'Judge by scope and risk, not by the length of the description.',
    },
    {
      S: 'A small, contained change: a handful of files, a narrow fix or a focused addition.',
      M: 'A medium change: several related files, a feature slice, some design decisions to make.',
      L: 'A large change: many files, a new subsystem, cross-cutting rework, or real architectural risk.',
    },
  ),
};

export type SizeBucketLabel = 'S' | 'M' | 'L';
export const SIZE_BUCKET_LABELS: readonly SizeBucketLabel[] = ['S', 'M', 'L'];

/** A starting threshold, not yet measured on held-out Jev outcomes; recalibrated from logged evidence (jev-scheduling §6). */
export const SIZE_BUCKET_MIN_CONFIDENCE = 0.6;

export const SIZE_BUCKET_DECISION = defineDecision({
  id: 'buildd.orchestration_size_bucket',
  promptVersion: SIZE_BUCKET_PROMPT_VERSION,
  questions: SIZE_BUCKET_QUESTIONS,
  mode: 'gated',
  minConfidence: SIZE_BUCKET_MIN_CONFIDENCE,
});

/** Applies from the first PR (see module header). Rolling back is setting this to 0. */
export const SIZE_BUCKET_APPLYING_FRACTION = 1;

/**
 * Representative files/minutes per bucket — coarse starting points for
 * ordering only, not a size prediction to report anywhere on their own.
 * jev-scheduling §6 recalibrates these from the neighbours of tasks this
 * fallback actually sized, once there is a window of evidence.
 */
export const SIZE_BUCKET_ESTIMATES: Record<SizeBucketLabel, { files: number; minutes: number }> = {
  S: { files: 3, minutes: 25 },
  M: { files: 8, minutes: 70 },
  L: { files: 20, minutes: 180 },
};

export function expectedSizeForBucket(bucket: SizeBucketLabel, confidence: number): ExpectedTaskSize {
  return { ...SIZE_BUCKET_ESTIMATES[bucket], source: 'jev', bucket, confidence };
}
