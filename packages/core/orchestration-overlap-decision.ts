/**
 * Is this soft pair's overlap real? (knowledge-base: buildd/design/jev-scheduling.md
 * §5, realizing conflict-aware-orchestration.md §5c ahead of its original
 * "defer until 5a/5b measured" plan, by owner decision — see the rollout note
 * in `./orchestration-overlap-source.ts`.)
 *
 * The pure half: the decision definition and the content-free state/digest
 * builders. The planner (`packages/core/claim-planner.ts`) only ever uses a
 * SOFT edge weight, never a hard one, so this decision can never create or
 * remove a hard edge — by construction, nothing here touches
 * `tasks.path_manifest` or `dependsOn`.
 *
 * Unlike `./orchestration-claim-decision.ts` (shadow, zero applying fraction
 * until a promotion-guard readout), this one ships `gated` with a starting
 * `minConfidence` and an applying fraction set directly (no
 * `resolveApplyingFraction` promotion gate): the owner's rollout decision for
 * Jev decisions that only ever move a soft weight or a size bucket is to
 * apply from the first PR, with every call logged so the threshold can be
 * recalibrated from evidence later (jev-scheduling §6).
 */
import { choice, defineDecision, type Decision } from '@builddai/ai-kit/decide';
import { overlapFraction, overlapPairKey } from './claim-planner';
import { candidateDigest } from './orchestration-decision';
import { hasConcretePathManifest, REPO_WIDE_SENTINEL } from './path-overlap';

export const OVERLAP_REAL_PROMPT_VERSION = 'ov1';
export const OVERLAP_REAL_CANDIDATE_POLICY_VERSION = 'ov1';

export const OVERLAP_REAL_QUESTIONS = {
  overlap: choice(
    {
      question:
        'Two tasks have overlapping file scope (`taskA` and `taskB`, below). Would working on both '
        + 'AT THE SAME TIME really risk editing the same lines, or is the file-level overlap incidental?',
      rule:
        'Judge by what each task is actually about, not just which files or directories their scope '
        + 'names. Two tasks naming the same wide directory can be unrelated; two tasks naming different '
        + 'files can still collide if one is a rename/move of the other\'s target.',
    },
    {
      REAL: 'The two tasks would plausibly edit the same lines or the same narrow concern, or there is '
        + 'not enough information to rule it out. Not for work that is plainly unrelated.',
      NOT_REAL: 'The two tasks are about different things and the file-level overlap is incidental '
        + '(e.g. a shared wide directory, or an unrelated export both happen to touch). Not for genuine '
        + 'uncertainty between the two.',
    },
  ),
};

export type OverlapRealLabel = 'REAL' | 'NOT_REAL';
export const OVERLAP_REAL_LABELS: readonly OverlapRealLabel[] = ['REAL', 'NOT_REAL'];

/** A starting threshold, not yet measured on held-out Jev outcomes; jev-scheduling §6 recalibrates it from logged evidence. */
export const OVERLAP_REAL_MIN_CONFIDENCE = 0.7;

export const OVERLAP_REAL_DECISION = defineDecision({
  id: 'buildd.orchestration_overlap_real',
  promptVersion: OVERLAP_REAL_PROMPT_VERSION,
  questions: OVERLAP_REAL_QUESTIONS,
  mode: 'gated',
  minConfidence: OVERLAP_REAL_MIN_CONFIDENCE,
});

/**
 * Applies from the first PR (see module header): every soft pair drawn is in
 * the applying arm. Rolling back is setting this to 0.
 */
export const OVERLAP_REAL_APPLYING_FRACTION = 1;

/** At most this many soft pairs are asked about per task creation. */
export const OVERLAP_REAL_MAX_PAIRS_PER_TASK = 5;

// ── Candidate scope (one side of a pair) ─────────────────────────────────────

export interface OverlapTaskScope {
  taskId: string;
  title: string;
  description: string | null;
  /** Concrete declared paths, or null. */
  declaredScope: readonly string[] | null;
  /** Predicted paths, used only when there is no declared scope. */
  predictedScope: readonly string[] | null;
  setConfidence: number | null;
}

export interface OverlapPairCandidate {
  a: OverlapTaskScope;
  b: OverlapTaskScope;
  /** Share of the smaller scope the other side covers (`overlapFraction`). */
  overlap: number;
}

const MAX_STATE_CHARS = 1_500;
const MAX_STATE_PATHS = 20;
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t ? (t.length > n ? `${t.slice(0, n)}…` : t) : null;
};

function sideState(s: OverlapTaskScope) {
  const scope = s.declaredScope ?? s.predictedScope ?? [];
  return {
    title: clip(s.title, 200),
    description: clip(s.description, MAX_STATE_CHARS),
    scope: scope.slice(0, MAX_STATE_PATHS),
    scopeKind: s.declaredScope ? 'declared' : 'predicted',
    scopeCount: scope.length,
  };
}

/** The model state for one pair. Content-free fields only (no file paths beyond what each task already declares/predicts). */
export function buildOverlapState(pair: OverlapPairCandidate): Record<string, unknown> {
  return {
    taskA: sideState(pair.a),
    taskB: sideState(pair.b),
    rule: { verdict: 'REAL', reason: 'predicted_or_declared_scope_overlap' },
  };
}

/** Content-free digest of one pair's state, so a recent identical ask is not repeated. */
export function overlapStateDigest(pair: OverlapPairCandidate): string {
  const side = (s: OverlapTaskScope) => [
    `kind=${s.declaredScope ? 'declared' : 'predicted'}`,
    ...[...new Set((s.declaredScope ?? s.predictedScope ?? []))].sort().map(p => `path=${p}`),
  ];
  const [x, y] = pair.a.taskId < pair.b.taskId ? [pair.a, pair.b] : [pair.b, pair.a];
  return candidateDigest([...side(x), '|', ...side(y)]);
}

export type OverlapRealDecisionType = Decision<typeof OVERLAP_REAL_QUESTIONS>;

// ── Pair selection (pure) ────────────────────────────────────────────────────

/** This side's usable scope for an overlap check: concrete first, else predicted paths above the floor. */
function usableScope(s: OverlapTaskScope, thetaOrder: number): { paths: string[]; predicted: boolean } | null {
  const concrete = hasConcretePathManifest(s.declaredScope as string[] | null | undefined) && !s.declaredScope!.includes(REPO_WIDE_SENTINEL)
    ? [...s.declaredScope!]
    : null;
  if (concrete) return { paths: concrete, predicted: false };
  if (s.predictedScope && s.setConfidence != null && s.setConfidence >= thetaOrder) {
    const paths = s.predictedScope.filter(p => p !== REPO_WIDE_SENTINEL);
    if (paths.length > 0) return { paths, predicted: true };
  }
  return null;
}

/**
 * The new task's soft pairs: other candidates whose usable scope overlaps
 * `newTask`'s, with at least one side predicted. Pure, deterministic, and
 * order-insensitive. Bounded to `max` pairs, highest overlap first, ties
 * broken by task id so a re-run offers the same pairs.
 */
export function findSoftOverlapPairs(
  newTask: OverlapTaskScope,
  others: readonly OverlapTaskScope[],
  opts: { thetaOrder?: number; max?: number } = {},
): OverlapPairCandidate[] {
  const thetaOrder = opts.thetaOrder ?? 0;
  const max = opts.max ?? OVERLAP_REAL_MAX_PAIRS_PER_TASK;
  const self = usableScope(newTask, thetaOrder);
  if (!self) return [];
  const seen = new Set<string>();
  const out: OverlapPairCandidate[] = [];
  for (const other of others) {
    if (other.taskId === newTask.taskId) continue;
    const key = overlapPairKey(newTask.taskId, other.taskId);
    if (seen.has(key)) continue;
    seen.add(key);
    const theirs = usableScope(other, thetaOrder);
    if (!theirs) continue;
    if (!self.predicted && !theirs.predicted) continue; // at least one side must be predicted
    const overlap = overlapFraction(self.paths, theirs.paths);
    if (overlap <= 0) continue;
    out.push({ a: newTask, b: other, overlap });
  }
  out.sort((x, y) => y.overlap - x.overlap || (x.b.taskId < y.b.taskId ? -1 : 1));
  return out.slice(0, Math.max(0, max));
}
