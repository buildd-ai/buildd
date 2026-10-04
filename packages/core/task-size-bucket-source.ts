/**
 * The size-bucket decision's I/O half (./task-size-bucket-decision.ts), the
 * fallback `./task-size-estimate.ts` calls out for itself (jev-scheduling
 * §3's "a coarser bucket fallback is a later step"): when there are fewer
 * than `k` completed neighbours to size from, ask Jev for an S/M/L bucket
 * instead of leaving `expectedSize` null.
 *
 * Same call shape as every other orchestration decision
 * (`runOrchestrationDecision`): below-threshold, timeout, provider error, a
 * disabled capability or a thrown dependency all fall back to null — exactly
 * today's "fewer than k ⇒ null" behaviour, nothing new is risked.
 */
import type { ExpectedTaskSize } from './db/schema';
import {
  SIZE_BUCKET_APPLYING_FRACTION,
  SIZE_BUCKET_CANDIDATE_POLICY_VERSION,
  SIZE_BUCKET_DECISION,
  SIZE_BUCKET_LABELS,
  expectedSizeForBucket,
  type SizeBucketLabel,
} from './task-size-bucket-decision';
import { candidateDigest, runOrchestrationDecision, type OrchestrationDecisionDeps } from './orchestration-decision';
import { estimateTaskSize, type EstimateTaskSizeArgs } from './task-size-estimate';

export const SIZE_BUCKET_CAPABILITY = 'orchestration_ordering' as const;
export const SIZE_BUCKET_STATE_CHARS = 1_500;

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t ? (t.length > n ? `${t.slice(0, n)}…` : t) : null;
};

/** Static: the bucket set never varies. */
export const SIZE_BUCKET_CANDIDATE_DIGEST = candidateDigest(SIZE_BUCKET_LABELS);

export interface EstimateExpectedSizeArgs extends EstimateTaskSizeArgs {
  teamId: string;
  missionId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  title: string;
  description?: string | null;
  signal: AbortSignal;
}

export interface EstimateExpectedSizeDeps {
  /** Same shape as `predictCreationManifest`'s own `estimateSize` dep — pass it straight through. */
  estimateSize?: (args: EstimateTaskSizeArgs & { signal: AbortSignal }) => Promise<ExpectedTaskSize | null>;
  decision?: typeof SIZE_BUCKET_DECISION;
  decide?: typeof runOrchestrationDecision;
  decisionDeps?: OrchestrationDecisionDeps;
  applyingFraction?: number;
  deadlineMs?: number;
}

/** The neighbour estimate, or (fewer than k) a Jev S/M/L bucket. Never throws. */
export async function estimateExpectedSize(
  args: EstimateExpectedSizeArgs,
  deps: EstimateExpectedSizeDeps = {},
): Promise<ExpectedTaskSize | null> {
  const neighbourEstimate = await (deps.estimateSize ?? estimateTaskSize)(args).catch(() => null);
  if (neighbourEstimate) return neighbourEstimate;

  const decision = deps.decision ?? SIZE_BUCKET_DECISION;
  const decide = deps.decide ?? runOrchestrationDecision;
  try {
    const outcome = await decide({
      decision,
      question: 'bucket',
      capability: SIZE_BUCKET_CAPABILITY,
      scope: {
        teamId: args.teamId,
        workspaceId: args.workspaceId,
        missionId: args.missionId ?? null,
        taskId: args.taskId,
        accountId: args.accountId ?? null,
        userId: args.userId ?? null,
      },
      ruleVerdict: 'M',
      candidatePolicy: { version: SIZE_BUCKET_CANDIDATE_POLICY_VERSION, digest: SIZE_BUCKET_CANDIDATE_DIGEST, count: SIZE_BUCKET_LABELS.length },
      buildState: async () => ({ title: clip(args.title, 200), description: clip(args.description ?? null, SIZE_BUCKET_STATE_CHARS) }),
      isValidAnswer: (v) => (SIZE_BUCKET_LABELS as readonly string[]).includes(String(v)),
      cohort: { fraction: deps.applyingFraction ?? SIZE_BUCKET_APPLYING_FRACTION, unitId: args.taskId },
      deps: deps.decisionDeps,
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    });
    if (outcome.applied && (SIZE_BUCKET_LABELS as readonly string[]).includes(outcome.effective)) {
      return expectedSizeForBucket(outcome.effective as SizeBucketLabel, outcome.confidence ?? 0);
    }
  } catch (err) {
    console.warn('[task-size-bucket] fallback failed (non-fatal):', (err as Error)?.message ?? err);
  }
  return null;
}
