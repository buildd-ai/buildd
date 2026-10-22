/**
 * A verification claim as Activity shows it (spec 9430a28f R-6, AC-5): one
 * task's governed outcome against the Living Spec it is pinned to, read by
 * `governedOutcomesFor` (lib/specs/outcome.ts), said in the spec page's words
 * (lib/specs/delivery-words.ts). Pure and client-safe.
 *
 * Only a recorded outcome makes a claim. A task with no pin, or whose pin does
 * not resolve, has none: a merged PR, a completed task or a mention of a spec
 * is never shown as conformance.
 *
 *  - passed:     every criterion passes on the current commit, on the revision
 *                approved now (or the one built to, while none is approved);
 *  - failed:     a criterion's deciding verdict is a fail;
 *  - stale:      verdicts were recorded, but for an older commit or an older
 *                revision than the one approved now; never counted as passed;
 *  - unverified: anything else, including no verdict at all.
 */
import {
  criterionWords, markOf, standingSentence,
  type CriterionMark, type DeliveryOutcome, type DeliveryTone,
} from './specs/delivery-words';

export type VerificationState = 'passed' | 'failed' | 'stale' | 'unverified';

/** What Activity reads of an `OutcomeView`. */
export interface VerificationOutcomeInput {
  specId: string;
  /** The revision the work is pinned to (built to). */
  revision: number;
  outcome: DeliveryOutcome;
  currentHeadSha: string | null;
  criteria: ReadonlyArray<{
    criterionId: string;
    text: string;
    verdict: 'pass' | 'fail' | 'inconclusive' | 'unsupported' | null;
    stale: boolean;
    headSha: string | null;
  }>;
}

export interface VerificationCriterion {
  criterionId: string;
  text: string;
  mark: CriterionMark;
  label: string;
  tone: DeliveryTone | 'warning';
  /** The commit its deciding verdict judged, short; null when none was recorded. */
  headSha: string | null;
}

export interface VerificationClaim {
  specId: string;
  specTitle: string;
  href: string;
  /** The revision the work was built to. */
  revision: number;
  /** The revision approved now; null while none is. */
  approvedRevision: number | null;
  state: VerificationState;
  label: string;
  tone: DeliveryTone;
  /** The current PR head the standing is read on, short; null when unknown. */
  headSha: string | null;
  /** One sentence: where the revision in force stands for this work. */
  line: string;
  criteria: VerificationCriterion[];
  /** Epoch ms of the newest verdict recorded; null when none was. */
  at: number | null;
}

const short = (sha: string | null | undefined) => (sha ? sha.trim().slice(0, 7) : null);

const LABEL: Record<VerificationState, { label: string; tone: DeliveryTone }> = {
  passed: { label: 'Verified', tone: 'success' },
  failed: { label: 'Fails', tone: 'error' },
  stale: { label: 'Stale', tone: 'muted' },
  unverified: { label: 'Not verified', tone: 'muted' },
};

export function verificationClaim(
  o: VerificationOutcomeInput,
  spec: { title: string; approvedRevision: number | null },
  at: number | null,
): VerificationClaim {
  const criteria: VerificationCriterion[] = o.criteria.map(c => {
    const mark = markOf(c);
    const words = criterionWords(mark);
    return { criterionId: c.criterionId, text: c.text, mark, label: words.label, tone: words.tone, headSha: c.verdict ? short(c.headSha) : null };
  });
  const judged = criteria.some(c => c.mark !== 'none');
  const otherRevision = spec.approvedRevision != null && spec.approvedRevision !== o.revision;
  const state: VerificationState = otherRevision
    ? (judged ? 'stale' : 'unverified')
    : o.outcome === 'fail' ? 'failed'
    : o.outcome === 'verified' ? 'passed'
    : criteria.some(c => c.mark === 'stale') ? 'stale'
    : 'unverified';
  const standing = standingSentence({ builtTo: o.revision, approved: spec.approvedRevision, outcome: o.outcome, criteria });
  return {
    specId: o.specId,
    specTitle: spec.title,
    href: `/app/specs/${o.specId}`,
    revision: o.revision,
    approvedRevision: spec.approvedRevision,
    state,
    ...LABEL[state],
    headSha: short(o.currentHeadSha),
    line: standing.text,
    criteria,
    at,
  };
}
