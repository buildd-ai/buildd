import Link from 'next/link';
import { criterionWords, markOf } from '@/lib/specs/delivery-words';

/**
 * Shape of `tasks.context.specSource`: a repo spec document, written by
 * `approvePlan` (apps/web/src/lib/approve-plan.ts) onto every child of an
 * emitsPlan-originated plan (docs/design/spec-to-build-pattern.md §3), and/or a
 * Living Spec pin the server writes when the task is filed (lib/specs/pin.ts).
 * Duplicated here rather than imported so this presentational component
 * stays free of approve-plan.ts's server/DB-only dependency graph.
 */
export interface SpecSourceContext {
  specPath?: string;
  planningTaskId?: string;
  specId?: string;
  revision?: number;
  contentHash?: string;
}

/** One criterion of the governed outcome, as the page shows it (lib/specs/outcome.ts). */
export interface SpecCriterionStanding {
  criterionId: string;
  text: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'unsupported' | null;
  stale: boolean;
  /** Model results a test result outranked on the same commit: shown beside the test, never replacing it. */
  notes?: Array<{ verdict: 'pass' | 'fail' | 'inconclusive' | 'unsupported'; source: 'test' | 'review' }>;
  /** Review verdicts the deciding test result outranks. */
  overriddenReviews?: number;
}

/** The Living Spec a task is pinned to, read server-side for the task page. */
export interface LivingSpecView {
  title: string;
  /** The spec's approved revision now; differs from the pin once a newer one is approved. */
  approvedRevision: number | null;
  /** True when the task names the criteria it answers for. */
  scoped: boolean;
  outcome: { outcome: 'verified' | 'fail' | 'unverified'; reason: string; criteria: SpecCriterionStanding[] } | null;
}

export interface SpecSourceBlockProps {
  specSource: SpecSourceContext | null | undefined;
  living?: LivingSpecView | null;
}

const OUTCOME_LABEL = { verified: 'Verified', fail: 'Failed', unverified: 'Not verified' } as const;
const OUTCOME_TONE = { verified: 'text-status-success', fail: 'text-status-error', unverified: 'text-text-muted' } as const;
const CRITERIA_SHOWN = 8;

const MARK_TONE = { success: 'text-status-success', error: 'text-status-error', muted: 'text-text-muted', warning: 'text-status-warning' } as const;

/**
 * One criterion in the spec page's words (lib/specs/delivery-words.ts): no
 * recorded verdict is Not verified, and Fails only a fail on the current head.
 */
function standingLabel(c: SpecCriterionStanding): { label: string; tone: string } {
  const w = criterionWords(markOf(c));
  return { label: w.label, tone: MARK_TONE[w.tone] };
}

/** "0 of 26 verified", then any that failed: counted by what was recorded, never "all N". */
function countLine(criteria: readonly SpecCriterionStanding[]): string {
  const verified = criteria.filter((c) => c.verdict === 'pass' && !c.stale).length;
  const failed = criteria.filter((c) => c.verdict === 'fail').length;
  return `${verified} of ${criteria.length} verified${failed ? ` · ${failed} failed` : ''}`;
}

// Failures first, then what is still open, then what holds.
const rank = (c: SpecCriterionStanding) => (c.verdict === 'fail' ? 0 : c.verdict === 'pass' && !c.stale ? 2 : 1);

/**
 * Read-only traceability block: which spec authorized this task (the Living
 * Spec revision it is pinned to, and/or the repo document), and the planning
 * task whose approved plan materialized it. Renders nothing when
 * `context.specSource` is absent (ordinary, non-spec-originated tasks).
 */
export function SpecSourceBlock({ specSource, living }: SpecSourceBlockProps) {
  const repoDoc = specSource?.specPath && specSource?.planningTaskId ? specSource.specPath : null;
  const pinned = specSource?.specId && typeof specSource.revision === 'number' ? specSource : null;
  if (!repoDoc && !pinned) return null;

  return (
    <div className="mb-6" data-testid="task-spec-source">
      <div className="section-label border-b border-border-default pb-2 mb-4">Spec</div>
      <div className="card p-4 space-y-1">
        {pinned && living && (
          <Link
            href={`/app/specs/${pinned.specId}`}
            className="block text-body font-medium text-primary hover:underline"
            data-testid="task-spec-source-title"
          >
            {living.title}
          </Link>
        )}
        {pinned && (
          <div className="text-body text-text-primary" data-testid="task-spec-source-pin">
            Pinned to revision {pinned.revision}
            {pinned.contentHash && (
              <span className="font-mono text-meta text-text-muted"> · {pinned.contentHash.slice(0, 12)}</span>
            )}
          </div>
        )}
        {pinned && living?.approvedRevision != null && living.approvedRevision > pinned.revision! && (
          <div className="text-meta text-text-muted" data-testid="task-spec-source-newer">
            Revision {living.approvedRevision} is approved now
          </div>
        )}
        {pinned && living?.outcome && (
          <div className="pt-2 space-y-1" data-testid="task-spec-outcome">
            <div className="text-body">
              <span className={`font-medium ${OUTCOME_TONE[living.outcome.outcome]}`} data-testid="task-spec-outcome-label">
                {OUTCOME_LABEL[living.outcome.outcome]}
              </span>
              <span className="text-text-muted">
                {living.scoped ? ` · answers for ${living.outcome.criteria.map((c) => c.criterionId).join(', ')}` : ''}
                {` · ${countLine(living.outcome.criteria)}`}
              </span>
            </div>
            <ul className="space-y-1">
              {[...living.outcome.criteria].sort((a, b) => rank(a) - rank(b)).slice(0, CRITERIA_SHOWN).map((c) => {
                const st = standingLabel(c);
                return (
                  <li key={c.criterionId} className="text-meta flex gap-2 min-w-0" data-testid="task-spec-criterion">
                    <span className="font-mono text-text-muted shrink-0">{c.criterionId}</span>
                    <span className="truncate text-text-secondary min-w-0" title={c.text}>{c.text}</span>
                    <span className={`shrink-0 ml-auto ${st.tone}`}>{st.label}</span>
                    {c.notes?.map((n, i) => (
                      <span key={i} className="shrink-0 text-text-muted" data-testid="task-spec-criterion-note">
                        Note: reviewer says {n.verdict}
                      </span>
                    ))}
                    {!c.notes?.length && (c.overriddenReviews ?? 0) > 0 && (
                      <span className="shrink-0 text-text-muted" data-testid="task-spec-outranked">
                        · {c.overriddenReviews === 1 ? '1 review outranked' : `${c.overriddenReviews} reviews outranked`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {living.outcome.criteria.length > CRITERIA_SHOWN && (
              <Link href={`/app/specs/${pinned.specId}`} className="text-meta text-primary hover:underline">
                {living.outcome.criteria.length - CRITERIA_SHOWN} more on the spec page
              </Link>
            )}
          </div>
        )}
        {repoDoc && (
          <div className="text-body font-medium text-text-primary break-all" data-testid="task-spec-source-path">
            {repoDoc}
          </div>
        )}
        {specSource?.planningTaskId && (
          <Link
            href={`/app/tasks/${specSource.planningTaskId}`}
            className="text-body text-primary hover:underline"
            data-testid="task-spec-source-link"
          >
            Planning task
          </Link>
        )}
      </div>
    </div>
  );
}

export default SpecSourceBlock;
