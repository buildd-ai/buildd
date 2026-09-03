'use client';

import { useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { MetricStat, Stat } from '@/components/StatTile';
import { coverageLabel, observedAgo, sectionDenominator } from '@/lib/health-metric-grammar';
import { scanCaveat } from '@/lib/model-presentation';
import {
  DRILLDOWN_WINDOWS,
  formatDelta,
  formatRate,
  formatTokens,
  formatUsd,
  healthHref,
  INDEX_ADOPTION_CAVEAT,
  INDEX_ADOPTION_TOOLTIP,
  SESSION_KEYED_NOTE,
  shortToolName,
  type DrilldownWindow,
  type UsageDrilldownView,
} from '@/lib/usage-drilldown';
import type { Distribution, PerTaskMetric } from '@/lib/usage-stats';

interface Props {
  view: UsageDrilldownView;
  teamWorkspaces: { id: string; name: string }[];
  wsFilter: string | null;
}

/**
 * `/app/health/usage` — what a task costs, and where the turns go.
 *
 * TASK-KEYED throughout, which is what the header denominator claims and what
 * every section below honours. The single exception is the index adoption line,
 * which counts worker SESSIONS; it says so at the stat rather than being quietly
 * relabelled to agree with the header.
 */
export function UsageClient({ view, teamWorkspaces, wsFilter }: Props) {
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
          <div className="min-w-0">
            {/* Back to Health at the window it was left on — 24h included. The
                clamp below is this route's decision and does not follow you out. */}
            <a
              data-testid="usage-back-link"
              href={healthHref({ window: view.requestedWindow, workspaceId: wsFilter })}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              ← Health
            </a>
            <h1 className="hidden md:block text-2xl font-bold">Usage</h1>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <DrilldownWindowPicker window={window} />
            <span className="hidden md:block">
              <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter} />
            </span>
          </div>
        </div>

        <div className="mt-2 flex items-baseline justify-between gap-3">
          <span data-testid="usage-header-denominator" className="text-[11px] text-text-muted">
            {sectionDenominator(tasks, tasks === 1 ? 'task' : 'tasks')} ({window})
          </span>
          {caveat && (
            <span
              data-testid="usage-scan-caveat"
              className="text-[11px] text-text-muted text-right"
              title={`The scan reads the newest ${scan.limit} terminal workers, newest first. Rows older than the cap were not read, so every figure on this page is a floor for the ${window} window, and a complete count only from ${scan.completeSince} onward.`}
            >
              {caveat}
            </span>
          )}
        </div>

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
            <div className="card p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricStat<Distribution>
                  label="Tokens / task"
                  metric={perTask.inputTokens}
                  render={(d) => formatTokens(d.median)}
                  sub={(d) => `p90 ${formatTokens(d.p90)} · ${sampleNote('inputTokens')}`}
                />
                {/* Under seat/OAuth auth cost is ABSENT, not approximate: the em-dash
                    carries its own reason and no number is ever shown with a hedge
                    word attached. The token proxy underneath is a different,
                    measurable quantity — labelled as a proxy, never as cost. */}
                <MetricStat<Distribution>
                  label="Cost / task"
                  metric={perTask.costUsd}
                  render={(d) => formatUsd(d.median)}
                  sub={() => `${formatUsd(totals.costUsd)} total · ${sampleNote('costUsd')}`}
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
                  Seat-based (OAuth) auth reports no per-task cost, so there is no dollar figure to
                  show — not a small one. Median input tokens per task is the closest measurable
                  stand-in and moves with the same thing a dollar figure would.
                </p>
              )}
            </div>
          </section>

          {/* 2. Where the turns go: navigation. */}
          <CodeNavigationPanelView view={view} />

          {/* 3. Where the turns go: the shell, on its own denominator. */}
          <ShellPanelView view={view} />

          {/* 4. Index adoption — the one session-keyed line on the page. */}
          <IndexAdoptionView view={view} />

          {/* Why there is no per-action breakdown of the buildd tool row. Stated,
              not substituted: every buildd MCP action multiplexes through one SDK
              tool name, so nothing recorded which action ran and an aggregate
              stand-in would answer a question nobody asked. */}
          <p data-testid="usage-no-action-decomposition" className="text-[11px] text-text-muted">
            No runtime/work breakdown of the <span className="font-mono">buildd</span> tool is shown:
            every one of its actions is recorded under a single tool name, so which action ran was
            never captured. There is nothing to approximate it with.
          </p>
        </>
      )}
    </div>
  );
}

// ── Code navigation ──────────────────────────────────────────────────────────

/**
 * Read / Grep / Glob / codebase-graph, with cross-window deltas.
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
            <div className="flex items-center gap-2 text-[9px] uppercase tracking-wide text-text-muted">
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
                title="Exact per-tool counts exist only for workers that ran after the tool histogram shipped. Older tasks are reconstructed from a capped MCP call log and the CBM counters, so their counts are a floor — which is what the ≥ marks."
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

        <p className="text-[11px] text-text-muted">
          One tool name covers every shell use: <span className="font-mono">rg</span>,{' '}
          <span className="font-mono">git</span>, test runs and builds are indistinguishable here,
          because nothing records the command inside the call.
        </p>
        <p data-testid="usage-shell-no-delta" className="text-[11px] text-text-muted">
          Stated over {shell.histogramTasks} of {shell.allTasks} tasks — the reconstructed rows that
          the panel above can draw on cannot contain a shell call at all. No delta is shown: that
          population’s composition shifts as older workers age out of the window, so a change across
          windows would measure coverage rather than behaviour.
        </p>
      </div>
    </section>
  );
}

// ── Index adoption ───────────────────────────────────────────────────────────

/**
 * Is the codebase graph actually queried when it is there?
 *
 * The one session-keyed line on a task-keyed page. It counts CBM-enabled
 * completed worker sessions with no dedup by task, and folding it to tasks would
 * change what it measures rather than how it is worded — so it keeps its
 * population and declares it, at the stat, in the label and in the note.
 */
function IndexAdoptionView({ view }: { view: UsageDrilldownView }) {
  const line = view.adoption;

  return (
    <section data-testid="usage-section-adoption" className="mb-6">
      <h2 className="section-label mb-3">Codebase graph</h2>
      <div className="card p-4 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          {/* Long form where there is room, short form where there is not —
              neither uses the word "task", because these rows are not tasks. */}
          <span
            data-testid="usage-index-adoption"
            className="text-xs text-text-secondary"
            title={INDEX_ADOPTION_TOOLTIP}
          >
            <span className="hidden sm:inline">{line.available ? line.label : 'Graph adoption'}</span>
            <span className="sm:hidden">{line.shortLabel}</span>
          </span>
          <span
            className={`hidden sm:inline text-lg tabular-nums shrink-0 ${line.available ? 'text-text-primary' : 'text-text-muted'}`}
            title={line.unavailableReason ?? undefined}
          >
            {line.rate === null ? '—' : `${Math.round(line.rate * 100)}%`}
          </span>
        </div>

        {line.unavailableReason && (
          <p data-testid="usage-adoption-unavailable" className="text-[11px] text-text-muted">
            {line.unavailableReason}
          </p>
        )}

        <p data-testid="usage-adoption-session-keyed" className="text-[11px] text-warning/90">
          {SESSION_KEYED_NOTE}
        </p>
        {/* The tooltip carries the full exclusion list; this is the half of it a
            reader must not have to hover to find. */}
        <p data-testid="usage-adoption-caveat" className="text-[11px] text-text-muted">
          {INDEX_ADOPTION_CAVEAT}
        </p>
      </div>
    </section>
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
    <div
      role="group"
      aria-label="Window"
      data-testid="usage-window-picker"
      className={`flex border-2 border-border-strong bg-surface-2 ${pending ? 'opacity-60' : ''}`}
    >
      {DRILLDOWN_WINDOWS.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => select(value)}
          aria-pressed={current === value}
          className={`px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
            current === value
              ? 'bg-surface-3 text-text-primary'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
