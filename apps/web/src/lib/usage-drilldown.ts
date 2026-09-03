/**
 * The `/app/health/usage` drill-down: what a task costs, and where the turns go.
 *
 * Opened when tuning a role prompt, a tool policy or a tier — not a daily-glance
 * surface. Everything here is pure so the page is a renderer and the arithmetic
 * is testable without a database or a DOM.
 *
 * THE PAGE IS TASK-KEYED. Every number below is stated over tasks, folded from
 * worker rows by `aggregateByTask` (usage-stats.ts), so a task retried three
 * times is one task with the sum of its attempts. The ONE exception is the index
 * adoption line, which is structurally worker-keyed and says so at the stat —
 * see `indexAdoptionLine`. Relabelling it "tasks" to match the header would be a
 * lie about what it counts; leaving it unlabelled would be worse.
 */
import type { CbmHealthSummary } from './cbm-insight';
import type { Distribution, MetricBlock, PerTaskBlock, ScanBounds, UsageStats } from './usage-stats';
import type { DerivedMetric } from '@buildd/core/derived-metric';

// ── Window ───────────────────────────────────────────────────────────────────

/**
 * `7d | 30d` only. 24h is excluded here (not merely discouraged): roughly half
 * the tasks in a day carry an exact tool histogram, which is too sparse for the
 * percentages and cross-window deltas this page is made of.
 */
export const DRILLDOWN_WINDOWS = ['7d', '30d'] as const;
export type DrilldownWindow = typeof DRILLDOWN_WINDOWS[number];

export const CLAMP_NOTICE = '24h is too thin for stable percentages here — showing 7d.';

export interface WindowResolution {
  window: DrilldownWindow;
  /** True only when the reader ASKED for 24h and we overrode it. */
  clamped: boolean;
  /** The notice to render inline, or null when nothing was overridden. */
  notice: string | null;
  /** The param exactly as it arrived, for the link back to Health. */
  requested: string | null;
}

/**
 * Resolve `?window=` for this route.
 *
 * A 24h header window CLAMPS to 7d with a visible notice rather than silently
 * widening. The clamp is local: this function never rewrites Health's own
 * `?window=`, so browser-back returns to Health at 24h, unclamped, with no state
 * to keep in sync. `requested` is carried so the explicit back link does the
 * same thing the back button does.
 *
 * An absent or unrecognised value falls back to 7d WITHOUT a notice — nothing
 * was overridden, so claiming a clamp would explain a decision nobody made.
 */
export function resolveDrilldownWindow(raw: string | null | undefined): WindowResolution {
  const requested = raw ?? null;
  if (raw === '24h') {
    return { window: '7d', clamped: true, notice: CLAMP_NOTICE, requested };
  }
  if ((DRILLDOWN_WINDOWS as readonly string[]).includes(raw ?? '')) {
    return { window: raw as DrilldownWindow, clamped: false, notice: null, requested };
  }
  return { window: '7d', clamped: false, notice: null, requested };
}

/** Link INTO the drill-down, carrying the header window verbatim so the clamp is this route's decision, not the caller's. */
export function usageDrilldownHref(opts: { window?: string | null; workspaceId?: string | null }): string {
  const params = new URLSearchParams();
  if (opts.window) params.set('window', opts.window);
  if (opts.workspaceId) params.set('workspace', opts.workspaceId);
  const qs = params.toString();
  return `/app/health/usage${qs ? `?${qs}` : ''}`;
}

/** Link back OUT to Health, restoring the window as it arrived — 24h included. */
export function healthHref(opts: { window?: string | null; workspaceId?: string | null }): string {
  const params = new URLSearchParams();
  if (opts.window) params.set('window', opts.window);
  if (opts.workspaceId) params.set('workspace', opts.workspaceId);
  const qs = params.toString();
  return `/app/health${qs ? `?${qs}` : ''}`;
}

// ── Tool classification ──────────────────────────────────────────────────────

/** Built-in tools an agent navigates code with. */
const CODE_NAV_BUILTINS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);

/** The codebase-graph MCP server, whose every tool is code navigation. */
const CODE_NAV_MCP_PREFIX = 'mcp__codebase-memory__';

/**
 * Code NAVIGATION, not "code search" — and deliberately without `Bash`.
 *
 * Nothing records the command string inside a `Bash` call (the runner keys its
 * histogram on the SDK tool name), so `Bash` is an undifferentiated mix of `rg`,
 * `git`, test runs and builds. Counting it here would make "how does this role
 * find code" a number that also contains every build it ran.
 */
export function isCodeNavigationTool(name: string): boolean {
  return CODE_NAV_BUILTINS.has(name) || name.startsWith(CODE_NAV_MCP_PREFIX);
}

export const SHELL_TOOL = 'Bash';

// ── Panels ───────────────────────────────────────────────────────────────────

/** Below this many tasks in the comparison period, a delta is noise. */
export const MIN_DELTA_TASKS = 5;

export interface ToolUsageRow {
  name: string;
  calls: number;
  /** Tasks that called it at least once. */
  tasks: number;
  /** `calls / population` — the basis a delta can be taken on. */
  callsPerTask: number;
  /** Same basis over the previous period; 0 when the tool was never called then. */
  previousPerTask: number;
  /** Change in `callsPerTask`, or null when the previous basis is 0 or deltas are withheld. */
  deltaPct: number | null;
}

export interface CodeNavigationPanel {
  rows: ToolUsageRow[];
  /** Task population these counts are stated over. */
  tasks: number;
  /** Attribution coverage, for `coverageLabel` — `≥` when any row is reconstructed. */
  coverage: { covered: number; population: number; hasDerived: boolean };
  /** Null when deltas are shown; otherwise the reason they are not. */
  deltaWithheld: string | null;
  previousTasks: number;
}

export interface PreviousPeriod {
  stats: UsageStats;
  /** The previous period's scan hit the row cap, so its counts are a floor. */
  truncated: boolean;
}

/**
 * Read / Grep / Glob / codebase-graph counts, with a delta against the previous
 * period of equal length.
 *
 * Deltas are shown here and NOT on the shell panel because this panel's coverage
 * composition is homogeneous: the derived-reconstruction path can produce every
 * key counted here, so the mix of exact and reconstructed rows shifts the same
 * way on both sides of the comparison.
 *
 * The delta is taken on calls PER TASK, never on raw calls: the two periods
 * rarely contain the same number of tasks, and a raw-count delta would report a
 * quiet week as a drop in tool use.
 */
export function buildCodeNavigationPanel(
  current: UsageStats,
  previous: PreviousPeriod | null,
  window: DrilldownWindow,
): CodeNavigationPanel {
  const tasks = current.totals.tasks;
  const previousTasks = previous?.stats.totals.tasks ?? 0;

  const deltaWithheld = withheldReason(previous, window);

  const prevPerTask = new Map<string, number>();
  if (previous && previousTasks > 0) {
    for (const t of previous.stats.tools.byTool) {
      if (isCodeNavigationTool(t.name)) prevPerTask.set(t.name, t.calls / previousTasks);
    }
  }

  const rows: ToolUsageRow[] = current.tools.byTool
    .filter(t => isCodeNavigationTool(t.name))
    .map(t => {
      const callsPerTask = tasks > 0 ? t.calls / tasks : 0;
      const previousPerTask = prevPerTask.get(t.name) ?? 0;
      return {
        name: t.name,
        calls: t.calls,
        tasks: t.tasks,
        callsPerTask,
        previousPerTask,
        deltaPct:
          deltaWithheld === null && previousPerTask > 0
            ? (callsPerTask - previousPerTask) / previousPerTask
            : null,
      };
    });

  return {
    rows,
    tasks,
    coverage: {
      covered: current.tools.coverage.histogram,
      population: current.tools.coverage.tasks,
      hasDerived: current.tools.coverage.derived > 0,
    },
    deltaWithheld,
    previousTasks,
  };
}

function withheldReason(previous: PreviousPeriod | null, window: DrilldownWindow): string | null {
  if (!previous) return 'No previous period was read, so there is nothing to compare against.';
  if (previous.truncated) {
    return `The previous ${window} hit the scan cap, so its counts are a floor — a delta against a floor would read as a rise that never happened.`;
  }
  if (previous.stats.totals.tasks < MIN_DELTA_TASKS) {
    return `Only ${previous.stats.totals.tasks} task${previous.stats.totals.tasks === 1 ? '' : 's'} in the previous ${window} — too few to compare.`;
  }
  return null;
}

/**
 * Shell usage, on its own, with NO delta and its own denominator.
 *
 * Two separate reasons, both load-bearing:
 *
 *  1. `Bash` exists only in exact histograms. The derived-reconstruction path
 *     rebuilds Read/Grep/Glob and MCP keys from older workers but never
 *     Bash/Edit/Write/Task, so this count is drawn from a strictly smaller
 *     population than its former neighbours — which is why `histogramTasks`,
 *     not `allTasks`, is the number it is stated against.
 *  2. That population's composition shifts as derived-only workers age out of
 *     the window, so a cross-window delta would measure the coverage change and
 *     report it as a behaviour change. No delta is offered here at all — not a
 *     null one, which invites someone to fill it in.
 */
export interface ShellPanel {
  /** False when no task in the window recorded a shell call. */
  present: boolean;
  calls: number;
  /** Tasks that called it at least once — necessarily histogram-covered tasks. */
  tasks: number;
  /** `calls / histogramTasks`. */
  callsPerTask: number;
  /** The population: tasks with an EXACT histogram. */
  histogramTasks: number;
  /** The page's task population, for contrast with the line above. */
  allTasks: number;
}

export function buildShellPanel(current: UsageStats): ShellPanel {
  const entry = current.tools.byTool.find(t => t.name === SHELL_TOOL);
  const histogramTasks = current.tools.coverage.histogram;
  return {
    present: !!entry,
    calls: entry?.calls ?? 0,
    tasks: entry?.tasks ?? 0,
    callsPerTask: entry && histogramTasks > 0 ? entry.calls / histogramTasks : 0,
    histogramTasks,
    allTasks: current.totals.tasks,
  };
}

// ── Index adoption ───────────────────────────────────────────────────────────

/**
 * Everything the denominator quietly leaves out. Reachable at the stat, per
 * `docs/design/derived-metric-availability.md` — the ratio is defensible, but
 * only if what it excludes is one hover away.
 */
export const INDEX_ADOPTION_TOOLTIP =
  'Failed workers are excluded entirely, from both sides: a session that queried the graph and then failed is invisible here. '
  + 'Workers that predate the CBM metric carry no record at all and fall out of BOTH sides of the ratio rather than counting as zero. '
  + 'Sessions where the graph was unavailable — by design (Codex tasks, worktree-less runs, role opt-outs) or through breakage '
  + '(binary absent, sandbox mount unavailable) — sit outside the denominator, which is "sessions where it was available", not "sessions".';

/**
 * The half of the tooltip a reader must not have to hover to find: the two
 * exclusions that change how the ratio should be read.
 */
export const INDEX_ADOPTION_CAVEAT =
  'Failed workers are excluded from both sides, and workers predating the CBM metric fall out of the ratio entirely rather than counting as zero.';

/**
 * Why this one line counts something other than the rest of the page.
 *
 * The metric counts CBM-enabled completed worker SESSIONS with no dedup by task.
 * Folding it to tasks would change what it measures — which is a different piece
 * of work, not a relabelling — so it keeps its own population and declares it.
 */
export const SESSION_KEYED_NOTE =
  'Session-keyed — the only line on this page that is. Everything else here is folded to tasks; this counts worker sessions, so a task retried three times counts three times.';

export interface IndexAdoptionLine {
  available: boolean;
  /** Sessions that made at least one graph call. */
  n: number;
  /** CBM-enabled completed sessions — the denominator. */
  sessions: number;
  /** 0–1, or null when there is nothing to divide. */
  rate: number | null;
  /** Long form. Deliberately never uses the word "task". */
  label: string;
  /** Short form for tight layouts. Also never uses the word "task". */
  shortLabel: string;
  /** Present only when `available` is false — the em-dash always has a reason. */
  unavailableReason: string | null;
}

/**
 * `Graph queried in {n} of {N} sessions where it was available`.
 *
 * Computed from `resultMeta.cbm` via `aggregateCbm`/`summarizeCbm`, NOT from the
 * tool histogram — so the histogram's coverage caveat is the wrong caveat for it
 * and is deliberately not attached. The formula is unchanged from `cbm-insight`;
 * only the label is corrected, because the rows are workers and the UI has been
 * calling them tasks.
 */
export function indexAdoptionLine(
  cbm: CbmHealthSummary | null,
  window: DrilldownWindow,
): IndexAdoptionLine {
  const sessions = cbm?.activeCount ?? 0;
  if (!cbm || sessions === 0) {
    return {
      available: false,
      n: 0,
      sessions: 0,
      rate: null,
      label: `Graph queried in — of 0 sessions where it was available (${window}, completed sessions only)`,
      shortLabel: 'Index adoption — —',
      unavailableReason:
        `No completed session in this window had the graph available — nothing to take a ratio of. `
        + `Sessions are excluded when CBM was disabled by design or unavailable through breakage, and failed workers are never counted.`,
    };
  }

  const n = sessions - cbm.zeroCallTasks;
  const rate = cbm.adoptionRate;
  const pct = rate === null ? '—' : `${Math.round(rate * 100)}%`;
  return {
    available: true,
    n,
    sessions,
    rate,
    label: `Graph queried in ${n} of ${sessions} sessions where it was available (${window}, completed sessions only)`,
    shortLabel: `Index adoption — ${pct} — ${n}/${sessions} CBM-enabled sessions`,
    unavailableReason: null,
  };
}

// ── Cost ─────────────────────────────────────────────────────────────────────

/**
 * The de-emphasised stand-in for dollar cost: median input tokens per task.
 *
 * Under seat/OAuth auth cost is not approximate, it is ABSENT — `costUsd` comes
 * back `unavailable` with a reason and renders an em-dash. A page whose stated
 * purpose is "what does a task cost" needs something cost-SHAPED for that auth
 * mode, and tokens are measured there. It is a proxy and is labelled as one; it
 * never appears as a dollar figure with a hedge word attached, because that
 * would imply a number exists when none does.
 */
export function costProxyTokens(inputTokens: DerivedMetric<Distribution>): number | null {
  return inputTokens.kind === 'value' ? inputTokens.value.median : null;
}

// ── The view ─────────────────────────────────────────────────────────────────

export interface UsageDrilldownView {
  window: DrilldownWindow;
  /** The window as requested, for the link back to Health. */
  requestedWindow: string | null;
  clampNotice: string | null;
  /** Task-keyed header denominator. */
  tasks: number;
  totals: MetricBlock;
  perTask: PerTaskBlock;
  costProxyTokens: number | null;
  scan: ScanBounds;
  codeNavigation: CodeNavigationPanel;
  shell: ShellPanel;
  adoption: IndexAdoptionLine;
}

export function buildUsageDrilldownView(input: {
  resolution: WindowResolution;
  current: UsageStats;
  previous: PreviousPeriod | null;
  scan: ScanBounds;
  cbm: CbmHealthSummary | null;
}): UsageDrilldownView {
  const { resolution, current, previous, scan, cbm } = input;
  return {
    window: resolution.window,
    requestedWindow: resolution.requested,
    clampNotice: resolution.notice,
    tasks: current.totals.tasks,
    totals: current.totals,
    perTask: current.perTask,
    costProxyTokens: costProxyTokens(current.perTask.inputTokens),
    scan,
    codeNavigation: buildCodeNavigationPanel(current, previous, resolution.window),
    shell: buildShellPanel(current),
    adoption: indexAdoptionLine(cbm, resolution.window),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Strip the `mcp__server__` prefix for display; the server is shown separately. */
export function shortToolName(name: string): string {
  if (name === '__other__') return 'other';
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  return parts.slice(2).join('__') || name;
}

/** Compact token counts — per-task input runs into the millions. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

/** One decimal below 10, whole numbers above — a per-task rate of 0.3 is a real reading. */
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1);
}

/**
 * A delta reads as a delta: signed, or `new` when the previous period had none,
 * or an em-dash when it is withheld. Never a bare 0 standing in for "unknown".
 */
export function formatDelta(row: ToolUsageRow, withheld: boolean): string {
  if (withheld) return '—';
  if (row.previousPerTask === 0) return row.calls > 0 ? 'new' : '—';
  if (row.deltaPct === null) return '—';
  const pct = Math.round(row.deltaPct * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}
