import { withoutForceClaim } from './force-claim';
import { hasConcretePathManifest } from '@buildd/core/path-overlap';

export interface SilentCompletionInput {
  status?: string;
  outputRequirement?: string | null;
  kind?: string | null;
  pathManifest?: string[] | null;
  taskClass?: string | null;
  isReviewer?: boolean;
  commitCount?: number | null;
  filesChanged?: number | null;
  dirtyWorktree?: boolean | null;
  observedTouches?: string[] | null;
  hasPR?: boolean;
  hasArtifact?: boolean;
  mergedAt?: unknown;
  discardEdits?: unknown;
  summary?: unknown;
  summarySource?: unknown;
}

/** Deterministic clause of the gate. A future fail-open decision may only add refusals. */
export function isSilentCompletion(input: SilentCompletionInput): boolean {
  const requirement = input.outputRequirement ?? 'auto';
  if (input.status !== 'completed' || !['auto', 'pr_required'].includes(requirement)
    || input.isReviewer || input.taskClass === 'bookkeeping') return false;
  if (!['engineering', 'writing', 'design'].includes(input.kind ?? '')
    && !hasConcretePathManifest(input.pathManifest)) return false;
  if ((input.commitCount ?? 0) !== 0 || (input.filesChanged ?? 0) !== 0
    || input.dirtyWorktree || input.observedTouches?.length || input.hasPR
    || input.hasArtifact || input.mergedAt
    || (typeof input.discardEdits === 'string' && input.discardEdits.trim())) return false;
  return isNonOutcomeSummary(input.summary, input.summarySource);
}

export function isNonOutcomeSummary(summary: unknown, source: unknown): boolean {
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (source === 'fallback' || /(?:^|\n)\s*---\s*(?:\n|$)/.test(text)) return true;
  if (!/[.!?]["'”’)*\]]*$/.test(text)) return true;
  const forward = /\b(?:I['’]ll|I will|Now let me|I['’]m going to)\b/i.test(text);
  const outcome = /(?:^|[.!?]\s+|\n)(?:(?:I|We)\s+)?(?:verified|fixed|implemented|added|updated|removed|completed|confirmed|found|checked|reviewed|tested|determined|validated|documented|resolved|created|delivered)\b[^.!?]*[.!?]/i.test(text);
  return forward && !outcome;
}

export function silentCompletionRetryContext(context: Record<string, unknown>) {
  const count = typeof context.silentCompletionRetryCount === 'number' ? context.silentCompletionRetryCount : 0;
  return {
    retry: count < 1,
    context: {
      ...withoutForceClaim(context),
      silentCompletionRetryCount: Math.min(count + 1, 1),
      failureContext: {
        errorType: 'silent_completion',
        summarySource: 'fallback',
        priorSummaryUnauthored: true,
        summary: 'The prior completion summary was unauthored narration, not an outcome. Perform the task and report a concrete outcome with its deliverable.',
      },
    },
  };
}
