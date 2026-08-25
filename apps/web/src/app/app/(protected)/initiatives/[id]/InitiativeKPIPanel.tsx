'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { InitiativeKPI, InitiativeKPIState, CriterionVerdict } from '@buildd/shared';

interface Props {
  initiativeId: string;
  kpis: InitiativeKPI[];
  kpiState: InitiativeKPIState | null;
  autoVerify: boolean | null;
}

const VERDICT_CONFIG: Record<CriterionVerdict, { label: string; cls: string; icon: string }> = {
  pass: { label: 'Pass', cls: 'text-status-success border-status-success/40', icon: '✓' },
  fail: { label: 'Fail', cls: 'text-status-error border-status-error/40', icon: '✗' },
  UNVERIFIED: { label: 'Unverified', cls: 'text-text-muted border-border-default', icon: '?' },
  NOT_EVALUATED: { label: 'No evaluator', cls: 'text-text-muted/50 border-border-default/50', icon: '–' },
  PENDING: { label: 'Evaluating…', cls: 'text-text-muted/70 border-border-default/70', icon: '⋯' },
};

const OP_LABELS: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
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

export default function InitiativeKPIPanel({ initiativeId, kpis, kpiState: initialState, autoVerify: initialAutoVerify }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [kpiState, setKpiState] = useState<InitiativeKPIState | null>(initialState);
  const [autoVerify, setAutoVerify] = useState<boolean>(initialAutoVerify ?? true);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [savingAutoVerify, setSavingAutoVerify] = useState(false);

  if (kpis.length === 0) return null;

  const overallVerdict = kpiState?.overall ?? null;
  const evaluatedAt = kpiState?.evaluatedAt ?? null;
  const stateByIndex = new Map((kpiState?.kpis ?? []).map(k => [k.index, k]));

  // Active-with-unmet-KPIs: KPIs exist but not all passed — legible state
  const hasUnmetKPIs = overallVerdict !== 'pass';

  async function handleRunEvaluation() {
    setRunError(null);
    setIsRunning(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/evaluate`, { method: 'POST' });
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
      if (data.kpiState) {
        setKpiState(data.kpiState);
      }
      startTransition(() => router.refresh());
    } catch {
      setRunError('Network error — please try again');
    } finally {
      setIsRunning(false);
    }
  }

  async function handleAutoVerifyToggle(value: boolean) {
    setAutoVerify(value);
    setSavingAutoVerify(true);
    try {
      await fetch(`/api/initiatives/${initiativeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoVerify: value }),
      });
    } finally {
      setSavingAutoVerify(false);
    }
  }

  return (
    <div className="mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">KPIs</h2>
          {overallVerdict && (
            <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${VERDICT_CONFIG[overallVerdict].cls}`}>
              {VERDICT_CONFIG[overallVerdict].icon} {VERDICT_CONFIG[overallVerdict].label}
            </span>
          )}
          {hasUnmetKPIs && overallVerdict !== null && (
            <span className="text-[10px] text-status-warning font-mono">
              blocking completion
            </span>
          )}
        </div>
        <button
          onClick={handleRunEvaluation}
          disabled={isRunning || isPending}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-primary text-white rounded-sm hover:bg-primary-hover transition-colors disabled:opacity-50 active:scale-95 touch-manipulation"
          title="Evaluate KPIs now"
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
              Run evaluation
            </>
          )}
        </button>
      </div>

      {evaluatedAt && (
        <p className="text-[11px] text-text-muted mb-3">
          Last evaluated {formatRelativeTime(evaluatedAt)}{kpiState?.evaluatedBy ? ` · ${kpiState.evaluatedBy}` : ''}
        </p>
      )}

      {runError && (
        <p className="text-[12px] text-status-error mb-3">{runError}</p>
      )}

      {/* KPI rows */}
      <div className="flex flex-col gap-1.5">
        {kpis.map((kpi, i) => {
          const ks = stateByIndex.get(i);
          const verdict: CriterionVerdict = ks?.verdict ?? 'UNVERIFIED';
          const vc = VERDICT_CONFIG[verdict];
          const observedValue = ks?.observedValue;

          return (
            <div key={i} className="card p-3">
              <div className="flex items-start gap-3">
                {/* Verdict icon */}
                <span className={`shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center border text-[11px] font-bold rounded-sm ${vc.cls}`}>
                  {vc.icon}
                </span>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[13px] text-text-primary font-medium leading-snug">
                      {kpi.name}
                    </span>
                    {kpi.blocking !== false && (
                      <span className="text-[10px] font-mono text-text-muted">blocking</span>
                    )}
                  </div>
                  {/* Threshold + observed value */}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-[11px] font-mono text-text-muted">
                      {kpi.metric} {OP_LABELS[kpi.operator] ?? kpi.operator} {kpi.threshold}{kpi.unit ? ` ${kpi.unit}` : ''}
                    </span>
                    {observedValue !== undefined && (
                      <span className={`text-[12px] font-mono font-semibold tabular-nums ${verdict === 'pass' ? 'text-status-success' : verdict === 'fail' ? 'text-status-error' : 'text-text-secondary'}`}>
                        {observedValue}{kpi.unit ? ` ${kpi.unit}` : ''}
                      </span>
                    )}
                  </div>
                  {/* Progress bar for numeric KPIs */}
                  {observedValue !== undefined && kpi.threshold > 0 && (
                    <div className="mt-1.5 h-1 rounded-full bg-[rgba(255,255,255,0.06)] overflow-hidden max-w-xs">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${verdict === 'pass' ? 'bg-status-success' : 'bg-status-warning'}`}
                        style={{ width: `${Math.min(100, (observedValue / kpi.threshold) * 100).toFixed(1)}%` }}
                      />
                    </div>
                  )}
                  {ks?.evidence && (
                    <p className="text-[11px] text-text-muted mt-1 font-mono break-words">{ks.evidence}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* autoVerify toggle */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] text-text-secondary">Auto-evaluate on mission completion</span>
          <p className="text-[11px] text-text-muted mt-0.5">Re-check KPIs automatically when all child missions complete.</p>
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
    </div>
  );
}
