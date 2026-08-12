'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { GoalCriterion, GoalCriteriaState, CriterionVerdict, GoalCriterionType } from '@buildd/shared';

interface Props {
  missionId: string;
  criteria: GoalCriterion[];
  criteriaState: GoalCriteriaState | null;
  autoVerify: boolean | null;
  readonly?: boolean;
}

const CRITERION_TYPE_LABELS: Record<GoalCriterionType, string> = {
  all_prs_merged: 'All PRs merged',
  no_open_tasks: 'No open tasks',
  artifact_exists: 'Artifact exists',
  command: 'Command',
  metric: 'Metric',
};

const VERDICT_CONFIG: Record<CriterionVerdict, { label: string; cls: string; icon: string }> = {
  pass: { label: 'Pass', cls: 'text-status-success border-status-success/40', icon: '✓' },
  fail: { label: 'Fail', cls: 'text-status-error border-status-error/40', icon: '✗' },
  UNVERIFIED: { label: 'Unverified', cls: 'text-text-muted border-border-default', icon: '?' },
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

function criterionLabel(c: GoalCriterion): string {
  if (c.label) return c.label;
  // Agents sometimes store a human-readable description instead of label — use it as fallback
  if ((c as any).description) return (c as any).description;
  if (c.type === 'metric') return `${c.query} ${c.operator} ${c.threshold}${c.unit ? ' ' + c.unit : ''}`;
  if (c.type === 'command') return c.command.length > 60 ? c.command.slice(0, 60) + '…' : c.command;
  if (c.type === 'artifact_exists') return c.key ? `Artifact: ${c.key}` : `Artifact type: ${c.artifactType ?? 'any'}`;
  return CRITERION_TYPE_LABELS[c.type] ?? c.type;
}

/* ── Add Criterion Form ── */
const DEFAULT_CRITERION: GoalCriterion = { type: 'all_prs_merged' };

function AddCriterionForm({ onAdd, onCancel }: {
  onAdd: (c: GoalCriterion) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<GoalCriterionType>('all_prs_merged');
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [artifactKey, setArtifactKey] = useState('');
  const [artifactType, setArtifactType] = useState('');
  const [metricQuery, setMetricQuery] = useState('');
  const [metricOp, setMetricOp] = useState<'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'>('gte');
  const [metricThreshold, setMetricThreshold] = useState('');
  const [metricUnit, setMetricUnit] = useState('');
  const [requireBranchDeleted, setRequireBranchDeleted] = useState(false);

  function buildCriterion(): GoalCriterion | null {
    const base = label ? { label } : {};
    if (type === 'all_prs_merged') {
      return { type, ...base, requireBranchDeleted: requireBranchDeleted || undefined };
    }
    if (type === 'no_open_tasks') return { type, ...base };
    if (type === 'artifact_exists') return { type, ...base, key: artifactKey || undefined, artifactType: artifactType || undefined };
    if (type === 'command') {
      if (!command.trim()) return null;
      return { type, command: command.trim(), ...base };
    }
    if (type === 'metric') {
      const t = parseFloat(metricThreshold);
      if (!metricQuery.trim() || isNaN(t)) return null;
      return { type, query: metricQuery.trim(), operator: metricOp, threshold: t, unit: metricUnit || undefined, ...base };
    }
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const c = buildCriterion();
    if (c) onAdd(c);
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border-default rounded-sm p-3 space-y-3 bg-surface-2">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Type</label>
        <select
          value={type}
          onChange={e => setType(e.target.value as GoalCriterionType)}
          className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border"
        >
          <option value="all_prs_merged">All PRs merged</option>
          <option value="no_open_tasks">No open tasks</option>
          <option value="artifact_exists">Artifact exists</option>
          <option value="command">Command passes</option>
          <option value="metric">Metric threshold</option>
        </select>
      </div>

      {type === 'command' && (
        <div className="flex items-start gap-2">
          <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0 pt-1">Command</label>
          <input
            value={command}
            onChange={e => setCommand(e.target.value)}
            placeholder="e.g. bun test"
            className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            required
          />
        </div>
      )}

      {type === 'artifact_exists' && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Key</label>
            <input
              value={artifactKey}
              onChange={e => setArtifactKey(e.target.value)}
              placeholder="e.g. deploy-url (optional)"
              className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Type</label>
            <input
              value={artifactType}
              onChange={e => setArtifactType(e.target.value)}
              placeholder="e.g. summary (optional)"
              className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            />
          </div>
        </>
      )}

      {type === 'metric' && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Query</label>
            <input
              value={metricQuery}
              onChange={e => setMetricQuery(e.target.value)}
              placeholder="e.g. test_coverage"
              className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Op</label>
            <select
              value={metricOp}
              onChange={e => setMetricOp(e.target.value as typeof metricOp)}
              className="bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border"
            >
              <option value="gte">≥</option>
              <option value="gt">&gt;</option>
              <option value="lte">≤</option>
              <option value="lt">&lt;</option>
              <option value="eq">=</option>
              <option value="neq">≠</option>
            </select>
            <input
              value={metricThreshold}
              onChange={e => setMetricThreshold(e.target.value)}
              placeholder="threshold"
              type="number"
              className="w-24 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
              required
            />
            <input
              value={metricUnit}
              onChange={e => setMetricUnit(e.target.value)}
              placeholder="unit (opt)"
              className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border font-mono"
            />
          </div>
        </>
      )}

      {type === 'all_prs_merged' && (
        <label className="flex items-center gap-2 cursor-pointer pl-[4.5rem]">
          <input
            type="checkbox"
            checked={requireBranchDeleted}
            onChange={e => setRequireBranchDeleted(e.target.checked)}
            className="rounded"
          />
          <span className="text-[12px] text-text-secondary">Require branch deleted</span>
        </label>
      )}

      <div className="flex items-center gap-2">
        <label className="text-[11px] text-text-muted font-mono uppercase tracking-wide w-16 shrink-0">Label</label>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Custom label (optional)"
          className="flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-accent-border"
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="submit" className="px-3 py-1 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors">
          Add criterion
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1 text-[12px] text-text-muted hover:text-text-secondary transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ── Main Component ── */
export default function MissionGoalCriteria({ missionId, criteria: initialCriteria, criteriaState: initialState, autoVerify: initialAutoVerify, readonly }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [criteria, setCriteria] = useState<GoalCriterion[]>(initialCriteria);
  const [criteriaState, setCriteriaState] = useState<GoalCriteriaState | null>(initialState);
  const [autoVerify, setAutoVerify] = useState<boolean>(initialAutoVerify ?? true);
  const [runError, setRunError] = useState<string | null>(null);
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
        setRunError('Rate limit: max 6 evaluations per hour.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRunError(body.error ?? 'Evaluation failed');
        return;
      }
      const data = await res.json();
      if (data.goalCriteriaState) {
        setCriteriaState(data.goalCriteriaState);
      }
      startTransition(() => router.refresh());
    } catch {
      setRunError('Network error — please try again');
    } finally {
      setIsRunning(false);
    }
  }

  // Save criteria to API
  async function saveCriteria(next: GoalCriterion[]) {
    setSavingCriteria(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalCriteria: next }),
      });
      startTransition(() => router.refresh());
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

  // Build state map: index → criterion state
  const stateByIndex = new Map(
    (criteriaState?.criteria ?? []).map(c => [c.index, c])
  );

  return (
    <div className="card p-4">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="section-label">Goal criteria</h2>
          {overallVerdict && (
            <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${VERDICT_CONFIG[overallVerdict].cls}`}>
              {VERDICT_CONFIG[overallVerdict].icon} {VERDICT_CONFIG[overallVerdict].label}
            </span>
          )}
        </div>
        {!readonly && criteria.length > 0 && (
          <button
            onClick={handleRunVerification}
            disabled={isRunning || isPending}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors disabled:opacity-50 active:scale-95 touch-manipulation"
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

      {/* Last run metadata */}
      {evaluatedAt && (
        <p className="text-[11px] text-text-muted mb-3">
          Last run {formatRelativeTime(evaluatedAt)}{evaluatedBy ? ` · ${evaluatedBy}` : ''}
        </p>
      )}

      {runError && (
        <p className="text-[12px] text-status-error mb-3">{runError}</p>
      )}

      {/* Criteria list */}
      {criteria.length === 0 ? (
        <p className="text-[13px] text-text-muted mb-3">No criteria set. Add one to gate mission completion on measurable outcomes.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {criteria.map((c, i) => {
            const cs = stateByIndex.get(i);
            const verdict: CriterionVerdict = cs?.verdict ?? 'UNVERIFIED';
            const vc = VERDICT_CONFIG[verdict];
            const isExpanded = expandedRows.has(i);
            const label = criterionLabel(c);
            const typeLabel = CRITERION_TYPE_LABELS[c.type] ?? c.type;
            return (
              <div
                key={i}
                className="flex items-start gap-3 py-2.5 border-b border-border-default last:border-b-0 cursor-pointer touch-manipulation select-none active:bg-surface-2 transition-colors duration-75 rounded-sm"
                onClick={() => toggleRow(i)}
                role="button"
                aria-expanded={isExpanded}
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && toggleRow(i)}
              >
                {/* Verdict badge */}
                <span className={`shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center border text-[11px] font-bold ${vc.cls}`}>
                  {vc.icon}
                </span>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <span className="inline-block text-[10px] font-mono text-text-muted px-1 border border-border-default rounded-sm mb-1">
                    {typeLabel}
                  </span>
                  <p className={`text-[13px] text-text-primary font-medium leading-snug${isExpanded ? '' : ' line-clamp-2'}`}>
                    {label}
                  </p>
                  {cs?.evidence && (
                    <p className={`text-[12px] text-text-muted mt-0.5 leading-snug font-mono break-words${isExpanded ? '' : ' line-clamp-1'}`}>
                      {cs.evidence}
                    </p>
                  )}
                </div>
                {/* Expand chevron + remove button */}
                <div className="shrink-0 flex items-center gap-2 mt-0.5">
                  {!readonly && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemoveCriterion(i); }}
                      disabled={savingCriteria}
                      className="text-[11px] text-text-muted hover:text-status-error transition-colors disabled:opacity-40"
                      title="Remove criterion"
                    >
                      ✕
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
          })}
        </div>
      )}

      {/* Add form */}
      {showAddForm && (
        <div className="mb-3">
          <AddCriterionForm
            onAdd={handleAddCriterion}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Add criterion button */}
      {!readonly && !showAddForm && (
        <button
          onClick={() => setShowAddForm(true)}
          className="text-[12px] text-text-muted hover:text-text-secondary transition-colors font-mono"
        >
          + Add criterion
        </button>
      )}

      {/* autoVerify toggle */}
      {!readonly && criteria.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border-default flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[12px] text-text-secondary">Auto-verify on completion</span>
            <p className="text-[11px] text-text-muted mt-0.5">Automatically check criteria when the mission completes.</p>
          </div>
          <button
            role="switch"
            aria-checked={autoVerify}
            onClick={() => !savingAutoVerify && handleAutoVerifyToggle(!autoVerify)}
            disabled={savingAutoVerify}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-50 ${autoVerify ? 'bg-primary' : 'bg-border-strong'}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${autoVerify ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}
    </div>
  );
}
