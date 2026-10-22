'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BoardCriterionState } from '@/lib/mission-board';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriterionType } from '@buildd/shared';
import { criterionLabel } from '@/lib/goal-criterion-label';
import {
  isAutomaticCheck,
  joinCriteriaState,
  plainCriteriaError,
  verificationReadiness,
  type PlainError,
} from '@/lib/goal-criteria-panel';
import Switch from '@/components/ui/Switch';
import OutcomeSpecCriterion from './OutcomeSpecCriterion';

interface Props {
  missionId: string;
  criteria: GoalCriterion[];
  criteriaState: GoalCriteriaState | null;
  autoVerify: boolean | null;
  readonly?: boolean;
  /** PR numbers whose CI is currently failing — shown inline on all_prs_merged criterion. */
  failingCiPrNumbers?: number[];
  /** Why the mission is not verified now (the header pill's `verifiedHold`), shown first. */
  hold?: string | null;
  /**
   * Each criterion's current state, by index, from the board's live counts (the
   * same source `verifiedHold` reads). A stored pass these do not back is shown
   * as not verified, so the sheet never ticks "No open tasks" beside open tasks.
   */
  liveStates?: readonly BoardCriterionState[] | null;
}

/** A live board state as a verdict; a stored pass only stands where the live state passes too. */
function liveVerdict(stored: CriterionVerdict, live: BoardCriterionState | undefined): CriterionVerdict {
  if (live == null || live === 'pass') return stored;
  if (live === 'fail') return 'fail';
  if (live === 'running') return 'PENDING';
  return stored === 'pass' ? 'UNVERIFIED' : stored;
}

const CRITERION_TYPE_LABELS: Record<GoalCriterionType, string> = {
  all_prs_merged: 'All PRs merged',
  no_open_tasks: 'No open tasks',
  artifact_exists: 'Artifact exists',
  command: 'Command passes',
  metric: 'Metric',
  description: 'Judged by AI',
  living_spec: 'Spec requirements',
};

const VERDICT_CONFIG: Record<CriterionVerdict, { label: string; cls: string; icon: string }> = {
  pass: { label: 'Pass', cls: 'text-status-success border-status-success/40', icon: '✓' },
  fail: { label: 'Fail', cls: 'text-status-error border-status-error/40', icon: '✗' },
  UNVERIFIED: { label: 'Unverified', cls: 'text-text-muted border-border-default', icon: '?' },
  PENDING: { label: 'Checking', cls: 'text-status-warning border-status-warning/40', icon: '⟳' },
  NOT_EVALUATED: { label: 'No evaluator', cls: 'text-text-muted/50 border-border-default/50', icon: '–' },
};

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** A refusal in product words, with the validator's raw text behind a disclosure. */
function PlainErrorMessage({ error, testId }: { error: PlainError; testId?: string }) {
  return (
    <div role="alert" data-testid={testId}>
      <p className="text-meta text-status-error leading-snug">{error.text}</p>
      {error.detail && (
        <details className="mt-1">
          <summary className="text-meta text-text-muted cursor-pointer">Technical details</summary>
          <p className="text-meta font-mono text-text-muted mt-1 break-words">{error.detail}</p>
        </details>
      )}
    </div>
  );
}

/* ── Main Component ── */
export default function MissionGoalCriteria({ missionId, criteria: initialCriteria, criteriaState: initialState, autoVerify: initialAutoVerify, readonly, failingCiPrNumbers, hold = null, liveStates = null }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Read-only list: hand-written criteria are retired (Living Specs D-44), so
  // this legacy panel no longer adds, edits or removes them. A mission that
  // carries them keeps them until it completes.
  const criteria = initialCriteria;
  const [criteriaState, setCriteriaState] = useState<GoalCriteriaState | null>(initialState);
  const [autoVerify, setAutoVerify] = useState<boolean>(initialAutoVerify ?? true);
  const [runError, setRunError] = useState<PlainError | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [savingAutoVerify, setSavingAutoVerify] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  function toggleRow(index: number) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Run verification
  async function handleRunVerification() {
    setRunError(null);
    setIsRunning(true);
    try {
      const res = await fetch(`/api/missions/${missionId}/evaluate`, { method: 'POST' });
      if (res.status === 429) {
        setRunError({ text: 'Checked too often. Try again within the hour.', detail: null });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRunError(plainCriteriaError(body.error ?? 'Verification failed.'));
        return;
      }
      const data = await res.json();
      if (data.goalCriteriaState) {
        setCriteriaState(data.goalCriteriaState);
      }
      startTransition(() => router.refresh());
    } catch {
      setRunError({ text: 'Could not reach buildd to verify.', detail: null });
    } finally {
      setIsRunning(false);
    }
  }

  // Toggle autoVerify
  async function handleAutoVerifyToggle(value: boolean) {
    setAutoVerify(value);
    setSavingAutoVerify(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoVerify: value }),
      });
    } finally {
      setSavingAutoVerify(false);
    }
  }

  // Never PASS while something holds the mission (a criterion failing now, a blocking check).
  const storedOverall = criteriaState?.overall ?? null;
  const overallVerdict: CriterionVerdict | null = storedOverall === 'pass' && hold ? 'UNVERIFIED' : storedOverall;
  const evaluatedAt = criteriaState?.evaluatedAt ?? null;
  const evaluatedBy = criteriaState?.evaluatedBy ?? null;

  // Each row's stored verdict, matched by criterion identity — never by slot,
  // which put an edited or deleted criterion's evidence under its successor.
  const joinedState = joinCriteriaState(criteria, criteriaState);

  // Preflight: with no automatic check the run cannot reach a verdict, so the
  // sheet says why in its place rather than running and reporting why not.
  const readiness = verificationReadiness({ criteria });
  const blocked = readiness.kind === 'needs_check' ? readiness : null;

  const automatic = criteria.map((c, i) => ({ c, i })).filter(({ c }) => isAutomaticCheck(c));
  const judged = criteria.map((c, i) => ({ c, i })).filter(({ c }) => !isAutomaticCheck(c));
  const showGroupHeadings = automatic.length > 0 && judged.length > 0;

  function renderRow({ c, i }: { c: GoalCriterion; i: number }) {
    const cs = joinedState[i];
    const verdict: CriterionVerdict = liveVerdict(cs?.verdict ?? 'UNVERIFIED', liveStates?.[i]);
    const vc = VERDICT_CONFIG[verdict];
    const isExpanded = expandedRows.has(i);
    const label = criterionLabel(c);
    const typeLabel = CRITERION_TYPE_LABELS[c.type] ?? c.type;
    const auto = isAutomaticCheck(c);
    return (
      <div
        key={i}
        data-testid="criterion-row"
        data-check={auto ? 'automatic' : 'judged'}
        className="flex items-start gap-3 py-2.5 border-b border-border-default last:border-b-0 cursor-pointer touch-manipulation select-none active:bg-surface-2 transition-colors duration-75 rounded-sm"
        onClick={() => toggleRow(i)}
        role="button"
        aria-expanded={isExpanded}
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && toggleRow(i)}
      >
        {/* Verdict badge */}
        <span className={`shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center border text-meta font-bold ${vc.cls}`}>
          {vc.icon}
        </span>
        {/* Content */}
        <div className="flex-1 min-w-0">
          <span className={`inline-block text-meta px-1 rounded-sm mb-1 ${auto ? 'font-mono text-text-muted border border-border-default' : 'italic text-text-muted border border-dashed border-border-default'}`}>
            {typeLabel}
          </span>
          <p className={`text-body text-text-primary font-medium leading-snug${isExpanded ? '' : ' line-clamp-2'}`}>
            {label}
          </p>
          {isExpanded && c.type === 'description' && c.notMechanizableReason && (
            <p className="text-meta text-text-muted mt-1 italic leading-snug">
              Judged by {c.grader === 'api' ? 'an API call' : c.grader === 'runner' ? 'a runner agent' : 'an API call, or a runner agent when no key is set'} because: {c.notMechanizableReason}
            </p>
          )}
          {/* Inline CI-block annotation for the PR check — derived from live worker state */}
          {c.type === 'all_prs_merged' && failingCiPrNumbers && failingCiPrNumbers.length > 0 && verdict !== 'pass' && (
            <p className="text-meta text-status-error mt-0.5 leading-snug font-mono">
              blocked: {failingCiPrNumbers.length} PR{failingCiPrNumbers.length !== 1 ? 's' : ''} failing CI:{' '}
              {failingCiPrNumbers.map((n, idx) => (
                <span key={n}>
                  {idx > 0 && ', '}
                  #{n}
                </span>
              ))}
            </p>
          )}
          {c.type === 'living_spec' && (
            <>
              {isExpanded && (
                <OutcomeSpecCriterion
                  missionId={missionId}
                  criterion={c}
                  entry={cs}
                  readonly={readonly}
                  onChanged={() => startTransition(() => router.refresh())}
                />
              )}
            </>
          )}
          {c.type === 'living_spec' ? null : cs?.evidence ? (
            <p className={`text-meta text-text-muted mt-0.5 leading-snug font-mono break-words${isExpanded ? '' : ' line-clamp-1'}`}>
              {cs.evidence}
            </p>
          ) : !cs && criteriaState ? (
            <p className="text-meta text-text-muted mt-0.5 leading-snug" data-testid="criterion-not-checked">
              Not checked since this was added or changed.
            </p>
          ) : null}
          {cs?.workerTaskId && c.type !== 'living_spec' && (
            <a
              href={`/app/tasks/${cs.workerTaskId}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-block text-meta font-mono text-text-muted hover:text-text-primary underline mt-0.5"
            >
              verification task {cs.workerTaskId.slice(0, 8)}{cs.evaluatedAt ? ` · ${formatRelativeTime(cs.evaluatedAt)}` : ''}
            </a>
          )}
          {cs?.evidenceRefs && cs.evidenceRefs.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {cs.evidenceRefs.map((ref, ri) => (
                <span key={ri} className="text-meta font-mono text-text-muted px-1 border border-border-default rounded-sm">
                  {ref.type}: {ref.title ?? ref.id.slice(0, 8)}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* Expand chevron */}
        <div className="shrink-0 flex items-center gap-2 mt-0.5">
          <svg
            className={`w-3.5 h-3.5 text-text-muted transition-transform duration-150${isExpanded ? ' rotate-180' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </div>
    );
  }

  const ctaClass = 'shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-meta font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors disabled:opacity-50 active:scale-95 touch-manipulation';

  return (
    <div className="card p-4">
      {hold && (
        <p data-testid="criteria-hold" className="mb-3 text-body text-status-warning [overflow-wrap:anywhere]">
          {hold.charAt(0).toUpperCase() + hold.slice(1)}.
        </p>
      )}
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="section-label whitespace-nowrap">Goal criteria</h2>
          {overallVerdict && !blocked && (
            <span data-testid="criteria-overall" className={`shrink-0 border px-1.5 py-0.5 font-mono text-meta uppercase tracking-wide ${VERDICT_CONFIG[overallVerdict].cls}`}>
              {VERDICT_CONFIG[overallVerdict].icon} {VERDICT_CONFIG[overallVerdict].label}
            </span>
          )}
        </div>
        {!readonly && readiness.kind === 'ready' && (
          <button
            onClick={handleRunVerification}
            disabled={isRunning || isPending}
            data-testid="run-verification"
            className={ctaClass}
            title="Evaluate all goal criteria now"
          >
            {isRunning ? (
              <>
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                Running…
              </>
            ) : (
              <>
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 3l14 9-14 9V3z" fill="currentColor" stroke="none" />
                </svg>
                Run verification
              </>
            )}
          </button>
        )}
      </div>

      {/* Not verifiable: status and one reason, in place of a run
          that could only fail. */}
      {blocked && (
        <div className="mb-3 border-l-2 border-status-warning pl-3 py-1" data-testid="criteria-needs-check">
          <p className="text-body font-medium text-text-primary leading-snug">{blocked.headline}</p>
          <p className="text-meta text-text-muted leading-snug mt-0.5">{blocked.reason}</p>
        </div>
      )}

      {/* Last run metadata */}
      {evaluatedAt && !blocked && (
        <p className="text-meta text-text-muted mb-3">
          Last run {formatRelativeTime(evaluatedAt)}{evaluatedBy ? ` · ${evaluatedBy}` : ''}
        </p>
      )}

      {runError && (
        <div className="mb-3">
          <PlainErrorMessage error={runError} testId="criteria-run-error" />
        </div>
      )}

      {/* Criteria list: automatic checks first, AI-judged ones set apart — only
          the former give the mission a verdict that needs no model. */}
      {criteria.length === 0 ? (
        <p className="text-body text-text-muted mb-3">No criteria. The spec this mission delivers decides when it is done.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {showGroupHeadings && <p className="text-meta text-text-muted uppercase tracking-wide">Checked automatically</p>}
          {automatic.map(renderRow)}
          {showGroupHeadings && <p className="text-meta text-text-muted uppercase tracking-wide pt-2">Judged by AI</p>}
          {judged.map(renderRow)}
        </div>
      )}

      {/* autoVerify toggle */}
      {!readonly && criteria.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border-default flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-meta text-text-secondary">Auto-verify on completion</span>
            <p className="text-meta text-text-muted mt-0.5">Check criteria when the mission completes.</p>
          </div>
          <Switch
            checked={autoVerify}
            onChange={(next) => !savingAutoVerify && handleAutoVerifyToggle(next)}
            disabled={savingAutoVerify}
            label="Auto-verify on completion"
          />
        </div>
      )}
    </div>
  );
}
