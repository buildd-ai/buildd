'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriterionType } from '@buildd/shared';
import { criterionLabel } from '@/lib/goal-criterion-label';
import {
  isAutomaticCheck,
  joinCriteriaState,
  plainCriteriaError,
  validateCriterionInContext,
  verificationReadiness,
  type PlainError,
} from '@/lib/goal-criteria-panel';
import Switch from '@/components/ui/Switch';
import { Select } from '@/components/ui/Select';

interface Props {
  missionId: string;
  criteria: GoalCriterion[];
  criteriaState: GoalCriteriaState | null;
  autoVerify: boolean | null;
  readonly?: boolean;
  /** PR numbers whose CI is currently failing — shown inline on all_prs_merged criterion. */
  failingCiPrNumbers?: number[];
  /** Distinct PRs the mission has opened — lets the sheet offer the PR check in one tap. */
  missionPrCount?: number;
}

const CRITERION_TYPE_LABELS: Record<GoalCriterionType, string> = {
  all_prs_merged: 'All PRs merged',
  no_open_tasks: 'No open tasks',
  artifact_exists: 'Artifact exists',
  command: 'Command passes',
  metric: 'Metric',
  description: 'Judged by AI',
};

const VERDICT_CONFIG: Record<CriterionVerdict, { label: string; cls: string; icon: string }> = {
  pass: { label: 'Pass', cls: 'text-status-success border-status-success/40', icon: '✓' },
  fail: { label: 'Fail', cls: 'text-status-error border-status-error/40', icon: '✗' },
  UNVERIFIED: { label: 'Unverified', cls: 'text-text-muted border-border-default', icon: '?' },
  PENDING: { label: 'Running', cls: 'text-status-warning border-status-warning/40', icon: '⟳' },
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

/* ── Add / Edit Criterion Form ── */

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

export function AddCriterionForm({ initial, siblings = [], submitLabel = 'Add criterion', onAdd, onCancel }: {
  /** Pre-fills the form for editing an existing criterion in place. */
  initial?: GoalCriterion;
  /**
   * The other criteria saved alongside this one. The list-level rule (at least
   * one automatic check) is judged against them — validating the new row alone
   * refused a written goal even on a mission that already had an automatic check.
   */
  siblings?: GoalCriterion[];
  submitLabel?: string;
  onAdd: (c: GoalCriterion) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<GoalCriterionType>(initial?.type ?? 'command');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [command, setCommand] = useState(initial?.type === 'command' ? initial.command : '');
  const [artifactKey, setArtifactKey] = useState(initial?.type === 'artifact_exists' ? initial.key ?? '' : '');
  const [artifactType, setArtifactType] = useState(initial?.type === 'artifact_exists' ? initial.artifactType ?? '' : '');
  const [metricQuery, setMetricQuery] = useState(initial?.type === 'metric' ? initial.query : '');
  const [metricOp, setMetricOp] = useState<'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'>(initial?.type === 'metric' ? initial.operator : 'gte');
  const [metricThreshold, setMetricThreshold] = useState(initial?.type === 'metric' ? String(initial.threshold) : '');
  const [metricUnit, setMetricUnit] = useState(initial?.type === 'metric' ? initial.unit ?? '' : '');
  const [description, setDescription] = useState(initial?.type === 'description' ? initial.description : '');
  const [notMechanizableReason, setNotMechanizableReason] = useState(initial?.type === 'description' ? initial.notMechanizableReason ?? '' : '');
  const [error, setError] = useState<PlainError | null>(null);

  // Build the shape the API would receive; do NOT re-decide whether it is valid.
  // The rules live in the write-boundary validator that POST/PATCH
  // /api/missions already call, so this must not hold a second copy — it
  // previously did, including a hand-written 10-character minimum.
  function buildCriterion(): GoalCriterion {
    const base = label ? { label } : {};
    if (type === 'all_prs_merged') {
      return { type, ...base };
    }
    if (type === 'no_open_tasks') return { type, ...base };
    if (type === 'artifact_exists') return { type, ...base, key: artifactKey || undefined, artifactType: artifactType || undefined };
    if (type === 'command') {
      return { type, command: command.trim(), ...base } as GoalCriterion;
    }
    if (type === 'metric') {
      return {
        type,
        query: metricQuery.trim(),
        operator: metricOp,
        threshold: parseFloat(metricThreshold),
        unit: metricUnit || undefined,
        ...base,
      } as GoalCriterion;
    }
    return {
      type,
      description: description.trim(),
      notMechanizableReason: notMechanizableReason.trim(),
      ...base,
    } as GoalCriterion;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const candidate = buildCriterion();
    // This used to `return null` from buildCriterion on any incomplete input
    // and then `if (c) onAdd(c)` — so an empty command, an unparseable metric
    // threshold, or a too-short reason produced a button that did nothing at
    // all, with no message anywhere. Surface the validator's own words, which
    // are the words the API's 400 would have used, said in product terms.
    const message = validateCriterionInContext(candidate, siblings);
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    onAdd(candidate);
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border-default rounded-sm p-3 space-y-3 bg-surface-2">
      <div className="flex items-center gap-2">
        <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Type</label>
        <Select
          aria-label="Criterion type"
          value={type}
          onChange={v => setType(v as GoalCriterionType)}
          size="sm"
          className="flex-1"
          options={[
            { value: 'command', label: 'Command passes', description: 'A script exits 0' },
            { value: 'all_prs_merged', label: 'All PRs merged' },
            { value: 'no_open_tasks', label: 'No open tasks' },
            { value: 'artifact_exists', label: 'Artifact exists' },
            { value: 'description', label: 'Written goal', description: 'Judged by AI, last resort' },
          ]}
        />
      </div>

      {type === 'description' && (
        <>
          <div className="flex items-start gap-2">
            <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0 pt-1">Criteria</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. Scorecard artifact produced covering all retrieval layers"
              rows={2}
              className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border resize-none"
              required
            />
          </div>
          <div className="flex items-start gap-2">
            <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0 pt-1">Why not a script?</label>
            <textarea
              value={notMechanizableReason}
              onChange={e => setNotMechanizableReason(e.target.value)}
              placeholder="A prose verdict needs a live model. Say why no command / PR / artifact / task check can express this."
              rows={2}
              className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border resize-none"
              required
              minLength={10}
            />
          </div>
        </>
      )}

      {type === 'command' && (
        <div className="flex items-start gap-2">
          <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0 pt-1">Command</label>
          <input
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder="e.g. bun test"
            className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            required
          />
        </div>
      )}

      {type === 'artifact_exists' && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Key</label>
            <input
              value={artifactKey}
              onChange={e => setArtifactKey(e.target.value)}
              placeholder="e.g. deploy-url (optional)"
              className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Type</label>
            <input
              value={artifactType}
              onChange={e => setArtifactType(e.target.value)}
              placeholder="e.g. summary (optional)"
              className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            />
          </div>
        </>
      )}

      {type === 'metric' && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Query</label>
            <input
              value={metricQuery}
              onChange={e => setMetricQuery(e.target.value)}
              placeholder="e.g. test_coverage"
              className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Op</label>
            <Select
              aria-label="Comparison"
              value={metricOp}
              onChange={v => setMetricOp(v as typeof metricOp)}
              size="sm"
              className="w-20 shrink-0"
              menuMinWidth={176}
              options={[
                { value: 'gte', label: '≥', description: 'at least' },
                { value: 'gt', label: '>', description: 'more than' },
                { value: 'lte', label: '≤', description: 'at most' },
                { value: 'lt', label: '<', description: 'less than' },
                { value: 'eq', label: '=', description: 'equal to' },
                { value: 'neq', label: '≠', description: 'not equal to' },
              ]}
            />
            <input
              value={metricThreshold}
              onChange={e => setMetricThreshold(e.target.value)}
              placeholder="threshold"
              type="number"
              className="w-24 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
              required
            />
            <input
              value={metricUnit}
              onChange={e => setMetricUnit(e.target.value)}
              placeholder="unit (opt)"
              className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            />
          </div>
        </>
      )}

      <div className="flex items-center gap-2">
        <label className="text-meta text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Label</label>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Custom label (optional)"
          className="flex-1 bg-surface-1 border border-border-default text-meta text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border"
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" className="px-3 py-1 text-meta font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors">
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1 text-meta text-text-muted hover:text-text-secondary transition-colors">
          Cancel
        </button>
      </div>

      {/* The refusal, in product words. Without this the button simply did nothing. */}
      {error && <PlainErrorMessage error={error} testId="criterion-error" />}
    </form>
  );
}

/* ── Main Component ── */
export default function MissionGoalCriteria({ missionId, criteria: initialCriteria, criteriaState: initialState, autoVerify: initialAutoVerify, readonly, failingCiPrNumbers, missionPrCount = 0 }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [criteria, setCriteria] = useState<GoalCriterion[]>(initialCriteria);
  const [criteriaState, setCriteriaState] = useState<GoalCriteriaState | null>(initialState);
  const [autoVerify, setAutoVerify] = useState<boolean>(initialAutoVerify ?? true);
  const [runError, setRunError] = useState<PlainError | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [savingCriteria, setSavingCriteria] = useState(false);
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

  // Save criteria to API
  async function saveCriteria(next: GoalCriterion[]) {
    setSavingCriteria(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalCriteria: next }),
      });
      if (!res.ok) {
        // Silently swallowing this made the edit appear to undo itself: local
        // state had already been updated optimistically and router.refresh()
        // reverted it, with no clue that the write was rejected.
        const body = await res.json().catch(() => ({}));
        setRunError(plainCriteriaError(body.error ?? `Could not save criteria (HTTP ${res.status})`));
        setCriteria(criteria);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setRunError({ text: 'Could not reach buildd to save criteria.', detail: null });
      setCriteria(criteria);
    } finally {
      setSavingCriteria(false);
    }
  }

  async function handleAddCriterion(c: GoalCriterion) {
    const next = [...criteria, c];
    setCriteria(next);
    setShowAddForm(false);
    await saveCriteria(next);
  }

  async function handleRemoveCriterion(index: number) {
    const next = criteria.filter((_, i) => i !== index);
    setCriteria(next);
    await saveCriteria(next);
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

  const overallVerdict = criteriaState?.overall ?? null;
  const evaluatedAt = criteriaState?.evaluatedAt ?? null;
  const evaluatedBy = criteriaState?.evaluatedBy ?? null;

  // Each row's stored verdict, matched by criterion identity — never by slot,
  // which put an edited or deleted criterion's evidence under its successor.
  const joinedState = joinCriteriaState(criteria, criteriaState);

  // Preflight: with no automatic check the run cannot reach a verdict, so the
  // sheet offers the fix in its place rather than running and reporting why not.
  const readiness = verificationReadiness({ criteria, missionPrCount });
  const blocked = readiness.kind === 'needs_check' ? readiness : null;

  function handleFixAction() {
    if (!blocked) return;
    if (blocked.suggestion) void handleAddCriterion(blocked.suggestion);
    else setShowAddForm(true);
  }

  const automatic = criteria.map((c, i) => ({ c, i })).filter(({ c }) => isAutomaticCheck(c));
  const judged = criteria.map((c, i) => ({ c, i })).filter(({ c }) => !isAutomaticCheck(c));
  const showGroupHeadings = automatic.length > 0 && judged.length > 0;

  function renderRow({ c, i }: { c: GoalCriterion; i: number }) {
    const cs = joinedState[i];
    const verdict: CriterionVerdict = cs?.verdict ?? 'UNVERIFIED';
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
          {cs?.evidence ? (
            <p className={`text-meta text-text-muted mt-0.5 leading-snug font-mono break-words${isExpanded ? '' : ' line-clamp-1'}`}>
              {cs.evidence}
            </p>
          ) : !cs && criteriaState ? (
            <p className="text-meta text-text-muted mt-0.5 leading-snug" data-testid="criterion-not-checked">
              Not checked since this was added or changed.
            </p>
          ) : null}
          {cs?.workerTaskId && (
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
        {/* Expand chevron + remove button */}
        <div className="shrink-0 flex items-center gap-2 mt-0.5">
          {!readonly && (
            <button
              onClick={(e) => { e.stopPropagation(); handleRemoveCriterion(i); }}
              disabled={savingCriteria}
              className="text-meta text-text-muted hover:text-status-error transition-colors disabled:opacity-40"
              title="Remove criterion"
              aria-label="Remove criterion"
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
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
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="section-label whitespace-nowrap">Goal criteria</h2>
          {overallVerdict && !blocked && (
            <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-meta uppercase tracking-wide ${VERDICT_CONFIG[overallVerdict].cls}`}>
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

      {/* Not verifiable: status, one reason, one action — in place of a run
          that could only fail. */}
      {blocked && (
        <div className="mb-3 border-l-2 border-status-warning pl-3 py-1" data-testid="criteria-needs-check">
          <p className="text-body font-medium text-text-primary leading-snug">{blocked.headline}</p>
          <p className="text-meta text-text-muted leading-snug mt-0.5">{blocked.reason}</p>
          {!readonly && !showAddForm && (
            <button
              type="button"
              onClick={handleFixAction}
              disabled={savingCriteria || isPending}
              data-testid="criteria-fix-action"
              className={`${ctaClass} mt-2`}
            >
              {blocked.actionLabel}
            </button>
          )}
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
        <p className="text-body text-text-muted mb-3">No criteria. Add one to gate completion on a measurable outcome.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {showGroupHeadings && <p className="text-meta text-text-muted uppercase tracking-wide">Checked automatically</p>}
          {automatic.map(renderRow)}
          {showGroupHeadings && <p className="text-meta text-text-muted uppercase tracking-wide pt-2">Judged by AI</p>}
          {judged.map(renderRow)}
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <div className="mb-3">
          <AddCriterionForm
            siblings={criteria}
            onAdd={handleAddCriterion}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Add criterion button */}
      {!readonly && !showAddForm && (
        <button
          onClick={() => setShowAddForm(true)}
          className="text-meta text-text-muted hover:text-text-secondary transition-colors font-mono"
        >
          + Add criterion
        </button>
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
