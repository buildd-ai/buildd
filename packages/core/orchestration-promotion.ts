/**
 * The promotion guard for orchestration decisions
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §6, "Rollout, evaluation and
 * safety bounds").
 *
 * An applying cohort above zero exists only behind recorded evidence: a
 * readout (`./orchestration-readout.ts`) whose verdict for this exact decision
 * and candidate policy was `eligible_for_gated`, measured on this exact
 * definition, at the threshold the deployed definition uses. Anything else
 * resolves to a zero fraction, with the refusal named:
 *
 *  - no evidence, or evidence that was `insufficient_n` / `worse_than_baseline`;
 *  - a **fingerprint mismatch**: the questions or model changed since the
 *    readout, so the measurement no longer describes what would be asked;
 *  - a **threshold mismatch**: the deployed `minConfidence` is not the one the
 *    readout selected;
 *  - a `shadow` definition (nothing applies in shadow anyway);
 *  - a zero / negative / non-finite request: **rolling back is setting zero**,
 *    which always wins and needs no evidence.
 *
 * A granted cohort is capped at the evidence's `maxApplyingFraction`, the
 * small cohort a reviewer approved with the readout.
 *
 * The guard decides the cohort only. `runOrchestrationDecision` still applies
 * an answer solely when the kit's policy passes AND `isJevModel` passes, so a
 * non-Jev team model stays record-only even inside a granted cohort.
 *
 * `ORCHESTRATION_PROMOTIONS` is the reviewed, committed record of promotions.
 * It is empty: no readout over deployed evidence exists yet (see the design
 * doc's status). Adding an entry is a reviewed code change carrying only the
 * decision identity, the verdict, the measured threshold and the cohort
 * ceiling; the readout itself stays a private artifact.
 *
 * Pure: no DB, no env.
 */
import { decisionFingerprint, type Decision, type DecisionQuestions } from '@builddai/ai-kit/decide';
import { buildPickDecision } from './manifest-prediction';

export type ReadoutVerdict = 'insufficient_n' | 'worse_than_baseline' | 'eligible_for_gated';

export interface PromotionEvidence {
  decisionId: string;
  candidatePolicyVersion: string;
  /** `measuredIdentity` of the definition the readout evaluated. */
  measuredFingerprint: string;
  verdict: ReadoutVerdict;
  /** The threshold the readout selected; null unless eligible. */
  threshold: number | null;
  /** Largest applying fraction the reviewer approved with the readout. */
  maxApplyingFraction: number | null;
  /** Where the private readout lives (an artifact key, not its content). */
  readoutRef: string;
}

/** Reviewed promotions. Empty: promotion is blocked pending deployed evidence. */
export const ORCHESTRATION_PROMOTIONS: readonly PromotionEvidence[] = [];

export type PromotionRefusal =
  | 'zero_requested'
  | 'shadow_mode'
  | 'no_evidence'
  | 'not_eligible'
  | 'fingerprint_mismatch'
  | 'threshold_mismatch'
  | 'no_cohort_ceiling'
  | 'unknown_question';

export interface ResolvedFraction {
  fraction: number;
  /** null: granted as requested; 'capped': granted at the evidence ceiling. */
  refusal: PromotionRefusal | 'capped' | null;
}

type AnyDecision = Pick<Decision<DecisionQuestions>, 'id' | 'promptVersion' | 'questions' | 'model' | 'engine' | 'policyOf'>;

/**
 * What a readout measured, independent of how it is rolled out: the
 * fingerprint of the same questions and model in `shadow`. Moving a measured
 * definition to `gated` with its threshold keeps this identity; changing a
 * question, a criterion or the model does not.
 */
export function measuredIdentity(decision: AnyDecision): string {
  return decisionFingerprint({
    id: decision.id,
    promptVersion: decision.promptVersion,
    questions: decision.questions,
    mode: 'shadow',
    model: decision.model,
  }, decision.engine);
}

/** §5b's identity: the claim hold/start definition. */
export function claimHoldIdentity(decision: AnyDecision): string {
  return measuredIdentity(decision);
}

/** A fixed probe: every pick definition is built from the same template, so one probe pins it. */
const MANIFEST_IDENTITY_PROBE = ['__identity_probe__'];

/**
 * §5a's identity. Each pick is a dynamic definition (its criteria are the
 * files offered), so its own fingerprint differs per task. The template, the
 * instructions, the DONE criterion, the label scheme and the model, is pinned
 * through a fixed probe instead.
 */
export function manifestPickIdentity(): string {
  return measuredIdentity(buildPickDecision(MANIFEST_IDENTITY_PROBE).decision);
}

export function resolveApplyingFraction(input: {
  decision: AnyDecision;
  question: string;
  candidatePolicyVersion: string;
  requestedFraction: number;
  /** Default `measuredIdentity(decision)`; the manifest pick passes its template identity. */
  identity?: string;
  promotions?: readonly PromotionEvidence[];
}): ResolvedFraction {
  const requested = input.requestedFraction;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return { fraction: 0, refusal: 'zero_requested' };
  }
  let policy: { mode: string; minConfidence: number | null };
  try { policy = input.decision.policyOf(input.question); } catch { return { fraction: 0, refusal: 'unknown_question' }; }
  if (policy.mode === 'shadow') return { fraction: 0, refusal: 'shadow_mode' };

  const evidence = (input.promotions ?? ORCHESTRATION_PROMOTIONS)
    .find(e => e.decisionId === input.decision.id && e.candidatePolicyVersion === input.candidatePolicyVersion);
  if (!evidence) return { fraction: 0, refusal: 'no_evidence' };
  if (evidence.verdict !== 'eligible_for_gated' || evidence.threshold === null) return { fraction: 0, refusal: 'not_eligible' };

  const identity = input.identity ?? measuredIdentity(input.decision);
  if (identity !== evidence.measuredFingerprint) return { fraction: 0, refusal: 'fingerprint_mismatch' };
  if (policy.minConfidence !== evidence.threshold) return { fraction: 0, refusal: 'threshold_mismatch' };

  const ceiling = evidence.maxApplyingFraction;
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) return { fraction: 0, refusal: 'no_cohort_ceiling' };
  const want = Math.min(1, requested);
  return want > ceiling ? { fraction: ceiling, refusal: 'capped' } : { fraction: want, refusal: null };
}
