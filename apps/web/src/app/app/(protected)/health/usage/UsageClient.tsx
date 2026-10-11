'use client';

import { useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { MonthlySpend } from './MonthlySpend';
import { RoleUsage, type RoleUsageData } from './RoleUsage';
import type { MonthlyBudgetForecast } from '@/lib/budget-forecast';
import { MetricStat, Stat } from '@/components/StatTile';
import Segmented from '@/components/ui/Segmented';
import { coverageLabel, observedAgo, sectionDenominator } from '@/lib/health-metric-grammar';
import { scanCaveat } from '@/lib/model-presentation';
import { countOf } from '@/lib/plural';
import {
  DRILLDOWN_WINDOWS,
  formatDelta,
  formatRate,
  formatTokens,
  formatUsd,
  shortToolName,
  type DrilldownWindow,
  type UsageDrilldownView,
} from '@/lib/usage-drilldown';
import type { Distribution, PerTaskMetric, UsageStats } from '@/lib/usage-stats';
import { BASIS_KEYS, BASIS_LABEL, splitTotal } from '@/lib/cost-basis-split';
import type { HostedRunnerMeterView } from '@/lib/hosted-runner-usage';
import { HostedRunnerUsageSection, type HostedRunnerWorkspaceRow } from '@/components/hosted-runner/HostedRunnerUsageSection';
import {
  BASH_BUCKET_HINTS,
  formatShare,
  SEARCH_SHAPE_HINTS,
  type CountRow,
} from '@/lib/usage-breakdowns';

export interface HostedRunnerProps {
  meter: HostedRunnerMeterView;
  rows: HostedRunnerWorkspaceRow[];
}

interface Props {
  view: UsageDrilldownView;
  wsFilter: string | null;
  /** The active team's month on the hosted runner; null hides the section. */
  hostedRunner?: HostedRunnerProps | null;
  roleUsage?: RoleUsageData | null;
  monthly?: MonthlyBudgetForecast | null;
  /** 'mine': only tasks the viewer started (no view_team_usage); says so under the header. */
  scope?: 'team' | 'mine';
}

/**
 * `/app/health/usage` — what a task costs, and where the turns go.
 *
 * TASK-KEYED throughout, which is what the header denominator claims and what
 * every section below honours.
 */
export function UsageClient({ view, hostedRunner = null, roleUsage = null, monthly = null, scope = 'team' }: Props) {
  const { window, tasks, perTask, totals, scan } = view;
  const caveat = scanCaveat(scan, observedAgo(scan.completeSince, Date.now()) ?? 'the window start');

  /** "n of m tasks" — the sample behind a median, so it is never read as all of them. */
  const sampleNote = (metric: PerTaskMetric) => {
    const n = perTask.contributing[metric];
    return n < perTask.tasks ? `${n} of ${perTask.tasks} tasks` : `all ${perTask.tasks} tasks`;
  };

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          {/* No back link: the Health sub-nav is one tap away on both widths. */}
          <h1 className="hidden md:block text-2xl font-bold">Usage</h1>
          <div className="flex items-center gap-2 ml-auto">
            <DrilldownWindowPicker window={window} />
          </div>
        </div>

        <div className="mt-2 flex items-baseline justify-between gap-3">
          <span data-testid="usage-header-denominator" className="text-[11px] text-text-muted">
            {countOf(tasks, 'task')} · last {window === '30d' ? '30 days' : '7 days'}
          </span>
          {caveat && (
            <span
              data-testid="usage-scan-caveat"
              className="text-[11px] text-text-muted text-right"
              title={`Newest ${scan.limit} finished workers only. Figures are floors for ${window}; complete from ${scan.completeSince}.`}
            >
              {caveat}
            </span>
          )}
        </div>

        {scope === 'mine' && (
          <p data-testid="usage-scope-mine" className="mt-2 text-[11px] text-text-muted">Tasks you started.</p>
        )}

        {view.clampNotice && (
          <p data-testid="usage-clamp-notice" className="mt-2 text-[11px] text-warning">
            {view.clampNotice}
          </p>
        )}
      </div>

      {tasks === 0 ? (
        <div data-testid="usage-empty" className="card px-4 py-3">
          <p className="text-sm text-text-secondary">
            No terminal worker recorded usage in the last {window}.
          </p>
        </div>
      ) : (
        <>
          {/* 1. What a task costs. */}
          <section data-testid="usage-section-per-task" className="mb-6">
            <h2 className="section-label mb-3">Per task</h2>
            <div className="border-y border-border-default py-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricStat<Distribution>
                  label="Tokens / task"
                  metric={perTask.inputTokens}
                  render={(d) => formatTokens(d.median)}
                  sub={(d) => `p90 ${formatTokens(d.p90)} · ${sampleNote('inputTokens')}`}
                />
                {/* With no recorded cost, cost is ABSENT, not approximate: no number
                    is shown with a hedge word attached. The token proxy underneath
                    is a different, measurable quantity, labelled as a proxy. */}
                <MetricStat<Distribution>
                  label="Cost / task"
                  metric={perTask.costUsd}
                  render={(d) => formatUsd(d.median)}
                  sub={() => `${formatUsd(totals.costUsd)} combined total · ${sampleNote('costUsd')}`}
                  extra={
                    view.costProxyTokens === null
                      ? null
                      : `proxy: ${formatTokens(view.costProxyTokens)} input tokens / task`
                  }
                />
                <MetricStat<Distribution>
                  label="Turns / task"
                  metric={perTask.turns}
                  render={(d) => `${Math.round(d.median)}`}
                  sub={(d) => `p90 ${Math.round(d.p90)} · ${sampleNote('turns')}`}
                />
                <MetricStat<Distribution>
                  label="Tool calls / task"
                  metric={perTask.toolCalls}
                  render={(d) => `${Math.round(d.median)}`}
                  sub={(d) => `p90 ${Math.round(d.p90)} · ${sampleNote('toolCalls')}`}
                />
              </div>
              {perTask.costUsd.kind === 'unavailable' && view.costProxyTokens !== null && (
                <p data-testid="usage-cost-proxy-note" className="mt-3 text-[11px] text-text-muted">
                  No cost recorded in this window. Median input tokens per task is the closest
                  measurable stand-in.
                </p>
              )}
            </div>
          </section>

          <CostBasisSection byBasis={view.byBasis} />
        </>
      )}

      {roleUsage && <RoleUsage {...roleUsage} window={window} />}
      {monthly && <MonthlySpend monthly={monthly} />}

      {/* Hosted runner time is month-scoped, so it follows the windowed figures
          instead of sitting between the window control and what it controls. */}
      {hostedRunner && <HostedRunnerUsageSection meter={hostedRunner.meter} rows={hostedRunner.rows} />}
    </div>
  );
}

/**
 * Where the turns go: code navigation, the shell and which buildd action ran.
 * buildd's own tuning detail, so it renders on Health → Operator, not on
 * Usage. Each panel renders nothing without data.
 */
export function UsageInternals({ view }: { view: UsageDrilldownView }) {
  if (view.tasks === 0) return null;
  return (
    <div data-testid="usage-internals" className="max-w-2xl mx-auto px-4 pb-24">
      <h2 className="section-label mb-3">Where agent turns go</h2>
      <CodeNavigationPanelView view={view} />
      <ShellPanelView view={view} />
      <ActionBreakdownView view={view} />
    </div>
  );
}

// ── Code navigation ──────────────────────────────────────────────────────────

/**
 * Read / Grep / Glob, with cross-window deltas.
 *
 * "Navigation", not "search", and deliberately without `Bash`: nothing records
 * the command inside a shell call, so counting it here would fold every build
 * and test run into "how does this role find code".
 */
function CodeNavigationPanelView({ view }: { view: UsageDrilldownView }) {
  const panel = view.codeNavigation;
  const withheld = panel.deltaWithheld !== null;

  return (
    <section data-testid="usage-section-code-nav" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="section-label">Code navigation</h2>
        <span className="text-[11px] text-text-muted">
          {sectionDenominator(panel.tasks, panel.tasks === 1 ? 'task' : 'tasks')} ({view.window})
        </span>
      </div>
      <div className="card p-4 space-y-2">
        {panel.rows.length === 0 ? (
          <p className="text-xs text-text-muted">
            No task in this window recorded a code-navigation call.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[11px] md:text-[9px] uppercase tracking-wide text-text-muted">
              <span className="flex-1">tool</span>
              <span className="w-14 text-right">calls</span>
              <span className="w-16 text-right">/ task</span>
              <span className="w-14 text-right" title={`Change in calls per task against the previous ${view.window}`}>
                vs prev
              </span>
            </div>
            {panel.rows.map((row) => (
              <div key={row.name} className="flex items-center gap-2">
                <span className="text-xs text-text-primary flex-1 truncate" title={row.name}>
                  {shortToolName(row.name)}
                </span>
                <span className="w-14 text-right text-[11px] text-text-muted tabular-nums">
                  {row.calls}
                </span>
                <span className="w-16 text-right text-[11px] text-text-muted tabular-nums">
                  {formatRate(row.callsPerTask)}
                </span>
                <span
                  className={`w-14 text-right text-[11px] tabular-nums ${withheld ? 'text-text-muted' : 'text-text-secondary'}`}
                >
                  {formatDelta(row, withheld)}
                </span>
              </div>
            ))}

            <div className="pt-3 border-t border-border-default space-y-1">
              <p
                data-testid="usage-code-nav-coverage"
                className="text-[11px] text-text-muted"
                title="Older tasks are reconstructed from a capped MCP call log and legacy Read/Grep/Glob counters. ≥ marks those counts as floors."
              >
                {coverageLabel(panel.coverage)} tasks measured exactly
              </p>
              {panel.deltaWithheld && (
                <p data-testid="usage-code-nav-delta-withheld" className="text-[11px] text-text-muted">
                  Deltas withheld: {panel.deltaWithheld}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

/**
 * Shell usage, on its own panel, its own denominator, and with no delta.
 *
 * `Bash` is reconstructible from nothing: workers that predate the tool
 * histogram contribute Read/Grep/Glob and MCP keys but never a shell call, so
 * this count is drawn from a strictly smaller population than the panel above —
 * and that population's composition moves as those older workers age out, which
 * is exactly what a cross-window delta here would be measuring.
 */
function ShellPanelView({ view }: { view: UsageDrilldownView }) {
  const shell = view.shell;

  return (
    <section data-testid="usage-section-shell" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="section-label">Shell (all uses)</h2>
        <span data-testid="usage-shell-denominator" className="text-[11px] text-text-muted">
          {sectionDenominator(
            shell.histogramTasks,
            shell.histogramTasks === 1
              ? 'task with an exact histogram'
              : 'tasks with an exact histogram',
          )} ({view.window})
        </span>
      </div>
      <div className="card p-4 space-y-3">
        {shell.present ? (
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="Shell calls"
              value={shell.calls.toLocaleString('en-US')}
              sub={`${shell.tasks}/${shell.histogramTasks} tasks used it`}
            />
            <Stat
              label="Calls / task"
              value={formatRate(shell.callsPerTask)}
              sub={`over exact histograms only`}
            />
          </div>
        ) : (
          <p className="text-xs text-text-muted">
            No task with an exact histogram recorded a shell call in this window.
          </p>
        )}

        <BashBucketsView view={view} />
        <p data-testid="usage-shell-no-delta" className="text-[11px] text-text-muted">
          Over {shell.histogramTasks} of {shell.allTasks} tasks; reconstructed rows have no shell calls. No
          delta shown: the population changes between windows.
        </p>
      </div>
    </section>
  );
}

/**
 * What the shell calls were for: the runner's intent buckets, then the pattern
 * shapes inside `code_search`.
 *
 * Same population as the panel it sits in — tasks with an exact histogram —
 * and the same no-delta rule. Workers that predate the classifier have Bash on
 * their histogram but no buckets; those calls are counted as unclassified, not
 * guessed into `other`.
 */
function BashBucketsView({ view }: { view: UsageDrilldownView }) {
  const b = view.bashBuckets;
  const s = view.searchShapes;

  if (b.classifiedCalls === 0) {
    return (
      <p data-testid="usage-bash-buckets-empty" className="text-[11px] text-text-muted">
        {b.bashCalls > 0
          ? `None of the ${b.bashCalls.toLocaleString('en-US')} shell calls in this window were classified: every worker here predates the command classifier, so what they were for is unknown.`
          : 'No classified shell calls in this window, so there is no breakdown of what the shell was used for.'}
      </p>
    );
  }

  const unclassified = Math.max(b.bashCalls - b.classifiedCalls, 0);

  return (
    <div data-testid="usage-bash-buckets" className="space-y-3 pt-3 border-t border-border-default">
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-text-secondary">What the shell was for</span>
          <span className="text-[11px] text-text-muted tabular-nums shrink-0">share of shell</span>
        </div>
        <CountRows rows={b.buckets} hints={BASH_BUCKET_HINTS} testId="usage-bash-bucket-row" />
        <p data-testid="usage-bash-buckets-coverage" className="text-[11px] text-text-muted">
          {b.classifiedCalls.toLocaleString('en-US')} of {b.bashCalls.toLocaleString('en-US')} shell calls
          classified, across {b.classifiedTasks} of {b.histogramTasks} tasks with an exact histogram.
          {unclassified > 0 && ` ${unclassified.toLocaleString('en-US')} came from workers older than the classifier and are left out rather than guessed.`}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-text-secondary">Code search patterns</span>
          <span className="text-[11px] text-text-muted tabular-nums shrink-0">
            share of {s.codeSearchCalls.toLocaleString('en-US')} searches
          </span>
        </div>
        {s.codeSearchCalls === 0 ? (
          <p className="text-[11px] text-text-muted">No shell code search in this window.</p>
        ) : (
          <CountRows rows={s.shapes} hints={SEARCH_SHAPE_HINTS} testId="usage-search-shape-row" />
        )}
        <p data-testid="usage-search-shapes-note" className="text-[11px] text-text-muted">
          <span className="font-mono">identifier</span> searches look up a bare symbol name: the
          ones a structural index could answer. This count is the baseline for intercepting them.
        </p>
      </div>
    </div>
  );
}

/** Name, calls, share. One line per row; long names truncate with the full key and hint in the title. */
function CountRows({
  rows,
  hints,
  testId,
}: {
  rows: CountRow[];
  hints?: Record<string, string>;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} data-testid={testId} className="flex items-center gap-2 min-w-0">
          <span
            className={`font-mono text-[11px] flex-1 min-w-0 truncate ${r.calls > 0 ? 'text-text-primary' : 'text-text-muted'}`}
            title={hints?.[r.key] ? `${r.key}: ${hints[r.key]}` : r.key}
          >
            {r.key}
          </span>
          <span className="w-14 text-right text-[11px] text-text-muted tabular-nums shrink-0">
            {r.calls.toLocaleString('en-US')}
          </span>
          <span className="w-10 text-right text-[11px] text-text-muted tabular-nums shrink-0">
            {formatShare(r.share)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Window ───────────────────────────────────────────────────────────────────

/**
 * `7d | 30d`. There is no 24h button: a day is too thin for the percentages and
 * cross-window deltas this page is made of. Arriving from Health at 24h clamps
 * to 7d with a notice rather than rendering a control that lies about what it
 * would do.
 */
function DrilldownWindowPicker({ window: current }: { window: DrilldownWindow }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const select = (value: DrilldownWindow) => {
    if (value === current) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('window', value);
    const qs = params.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false }));
  };

  return (
    <div data-testid="usage-window-picker" className={pending ? 'opacity-60' : ''}>
      <Segmented label="Window" items={DRILLDOWN_WINDOWS.map(value => ({ value, label: value }))} value={current} onChange={select} />
    </div>
  );
}

// ── buildd action breakdown ──────────────────────────────────────────────────

/**
 * Per-action counts for the buildd MCP tool.
 *
 * This replaced a paragraph asserting the opposite — that which action ran
 * "was never captured" and there was "nothing to approximate it with". True
 * when written, false once the runner began writing `worker_action_events`. A
 * page that tells readers its own data is impossible is worse than one that
 * simply omits it, because it stops anyone from looking again.
 *
 * The coverage line is not decoration. This capture has NO backfill, so a
 * window opening before `capturedSince` cannot distinguish "quiet" from "not
 * yet recorded" — and a 30d window still does. That caveat renders whenever the
 * window predates capture, regardless of whether any events came back, because
 * it is a property of the window rather than of the result.
 */
function ActionBreakdownView({ view }: { view: UsageDrilldownView }) {
  const p = view.actions;
  // Absence renders nothing, never a zero — see derived-metric-availability.
  if (!p) return null;


  return (
    <div data-testid="usage-section-actions" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="section-label">buildd actions</h2>
        <span className="text-[11px] text-text-muted tabular-nums">
          {p.workersWithEvents}/{p.workers} workers recorded
        </span>
      </div>

      <div className="card p-4 space-y-4">
        {p.actions.length === 0 ? (
          <p data-testid="usage-actions-empty" className="text-[11px] text-text-muted">
            {p.windowPredatesCapture
              ? 'No actions recorded in this window. It starts before capture began, so counts are partial.'
              : 'No actions recorded in this window.'}
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] md:text-[9px] uppercase tracking-wide text-text-muted">
              <span className="flex-1">action</span>
              <span className="w-14 text-right">calls</span>
              <span className="w-10 text-right">share</span>
            </div>
            {p.actions.map(a => (
              <div key={a.action} data-testid="usage-action-row" className="flex items-center gap-2 min-w-0">
                <span
                  className="font-mono text-[11px] text-text-secondary w-28 sm:w-44 shrink-0 truncate"
                  title={a.action}
                >
                  {a.action}
                </span>
                {/* One hue at a fixed step, never a categorical ramp: identity
                    lives in the label and every row is direct-labelled. */}
                <span className="h-1.5 flex-1 min-w-0 bg-surface-3 rounded-sm overflow-hidden">
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.max(a.share, 1)}%` }}
                  />
                </span>
                <span className="w-14 text-right text-[11px] text-text-muted tabular-nums shrink-0">
                  {a.calls.toLocaleString('en-US')}
                </span>
                <span className="w-10 text-right text-[11px] text-text-muted tabular-nums shrink-0">
                  {formatShare(a.share / 100)}
                </span>
              </div>
            ))}
            <p data-testid="usage-actions-total" className="text-[11px] text-text-muted">
              {p.totalCalls.toLocaleString('en-US')} buildd calls across {p.actions.length} action
              {p.actions.length === 1 ? '' : 's'}.
            </p>
          </div>
        )}

        <div className="pt-3 border-t border-border-default space-y-1">
          <p className="text-[11px] text-text-muted">
            Actions recorded since {p.capturedSince}. There is no backfill.
            {p.windowPredatesCapture && (
              <>
                {' '}
                <span className="text-status-warning">
                  This window starts before capture, so counts are partial.
                </span>
              </>
            )}
          </p>
          {p.truncated && (
            <p className="text-[11px] text-text-muted">
              Row cap reached. Counts are floors.
            </p>
          )}
          <p className="text-[11px] text-text-muted">
            No runtime/work split.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Real dollars and plan usage at list price, never summed unlabelled
 * (docs/specs/real-and-virtual-cost.md "Reporting"). Mixed and "basis not
 * reported" rows appear only when the window has them.
 */
function CostBasisSection({ byBasis }: { byBasis: UsageStats['byBasis'] }) {
  const { total, byExecutor } = byBasis;
  if (BASIS_KEYS.every(k => total[k].workers === 0)) return null;
  const shown = BASIS_KEYS.filter(k => k === 'real' || k === 'virtual' || total[k].workers > 0);
  const cols = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_5.5rem] gap-2';
  return (
    <section data-testid="usage-cost-basis" className="mb-6">
      <h2 className="section-label mb-3">Cost</h2>
      <div className="border-y border-border-default py-4 text-body">
        <div className={`${cols} text-[11px] text-text-muted`}>
          <span />
          <span className="text-right">Runners</span>
          <span className="text-right">Interactive</span>
          <span className="text-right">Total</span>
        </div>
        <ul className="mt-2 space-y-2">
          {shown.map(k => (
            <li key={k} className={cols}>
              <span>
                {BASIS_LABEL[k]}
                {k === 'unknown' && <span className="text-text-muted"> · {countOf(total.unknown.workers, 'worker')}</span>}
              </span>
              <span className="text-right">{formatUsd(byExecutor.runner[k].costUsd)}</span>
              <span className="text-right">{formatUsd(byExecutor.interactive[k].costUsd)}</span>
              <span className="text-right font-semibold">{formatUsd(total[k].costUsd)}</span>
            </li>
          ))}
          <li className={`${cols} border-t-2 border-border pt-2 text-text-secondary`}>
            <span>Combined</span>
            <span />
            <span />
            <span className="text-right">{formatUsd(splitTotal(total).costUsd)}</span>
          </li>
        </ul>
      </div>
    </section>
  );
}
