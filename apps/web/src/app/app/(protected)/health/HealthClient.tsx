'use client';

import { useEffect, useMemo, useState, useTransition, useCallback } from 'react';
import { FailureGroupsSection, TopFailureGroups } from './_components/FailureGroups';
import type { FailureGroupsView } from '@/lib/health-failure-groups';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { deriveSandboxPosture, isRunnerOnline } from '@/lib/runner-heartbeats-shared';
import { isScheduleErrorLive } from '@/lib/schedule-health';
import type {
  UsageStats,
  ConsumptionStats,
  ScheduleRow,
  RecentFailure,
  CredentialHealthItem,
  StrandedBackendRow,
  BudgetForecast,
  FailureAnalytics,
  FailureWindow,
  GateAnalytics,
  OrphanedPrRow,
  SubagentDelegationPanel,
  ErrorPatternPanel,
} from './page';
import { getModelDisplayName } from '@buildd/core/model-display';
import { Stat } from '@/components/StatTile';
import { byModelAbsence, divergenceSummary, scanCaveat } from '@/lib/model-presentation';
import { usageDrilldownHref } from '@/lib/usage-drilldown';
import { buildToolBreakdown, foldBuilddActionTools } from '@/lib/tool-usage-breakdown';
import ToolBreakdownList from './_components/ToolBreakdownList';
import { CONSUMPTION_TOP_TOOLS, formatShare, groupToolsByServer } from '@/lib/usage-breakdowns';
import {
  coverageLabel,
  depletionProjection,
  failureStreak,
  freshness,
  groupFailuresBySignature,
  lifetimeRuns,
  monthlyAnchor,
  observedAgo,
  RUNNER_LIFETIME_LABEL,
  sectionDenominator,
} from '@/lib/health-metric-grammar';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import { countOf } from '@/lib/plural';
import { OccupancyChart } from '@/components/fleet/OccupancyChart';
import { ExperimentsSection } from './ExperimentsSection';
import { DispatchSection } from './DispatchSection';
import { AgentAccessSection } from '@/components/AgentAccessCard';
import type { AgentAccessReport } from '@/lib/agent-capabilities/access-log';
import { OverviewHeadline, OverviewStatusRows } from './_components/OverviewSummary';
import { overviewHeadline, overviewStatusRows } from '@/lib/health-overview';
import type { DispatchHealthReport } from '@buildd/core/dispatch-health-report';
import type { HealthExperiments } from '@/lib/health-experiments-shared';
import { formatEstimatedUsd, ESTIMATED_COST_TITLE } from '@/lib/cost-label';

// --- Runner health types (mirrors runner's DoctorReport) ---

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  detail?: string;
  fixable?: boolean;
}

interface RunnerDoctorResult {
  timestamp: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; error: number };
}

interface RunnerHistoryStats {
  totalSessions: number;
  totalCost: number;
  avgDurationMs: number;
  byStatus: Record<string, number>;
}

interface RunnerHealthState {
  loading: boolean;
  expanded: boolean;
  doctor?: RunnerDoctorResult;
  historyStats?: RunnerHistoryStats;
  error?: string;
  pushOnlyResult?: { online: boolean; message: string };
}

const STATUS_ICON: Record<DoctorCheck['status'], string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
};

const STATUS_CLASS: Record<DoctorCheck['status'], string> = {
  ok: 'text-status-success',
  warn: 'text-status-warning',
  error: 'text-status-error',
};

// --- Utilities ---

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.round(s / 60)}m`;
}

// `now` is a required parameter, never `Date.now()` internally — see the
// header comment on the `now` prop below for why a render-time clock read
// here is an SSR/hydration hazard.
function timeUntil(iso: string | null, now: number): string {
  if (!iso) return 'unknown';
  const seconds = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return 'due';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

function timeAgo(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Convert a 5-part cron expression to a human-readable cadence string.
// Falls back to the raw expression for patterns not explicitly handled.
function humanizeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;
  const allStars = dom === '*' && month === '*' && dow === '*';

  // */N * * * *  →  every N min
  if (allStars && hour === '*' && /^\*\/\d+$/.test(min)) {
    const n = parseInt(min.slice(2), 10);
    return n === 1 ? 'every minute' : `every ${n} min`;
  }

  // 0 * * * *  →  hourly
  if (allStars && hour === '*' && min === '0') return 'hourly';

  // N * * * *  →  hourly at :NN (non-zero minute)
  if (allStars && hour === '*' && /^\d+$/.test(min) && min !== '0') {
    return `hourly at :${min.padStart(2, '0')}`;
  }

  // 0 */N * * *  →  every Nh
  if (allStars && /^\*\/\d+$/.test(hour) && min === '0') {
    const n = parseInt(hour.slice(2), 10);
    return `every ${n}h`;
  }

  // M H * * *  →  daily at H:MM am/pm
  if (allStars && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ampm = h < 12 ? 'am' : 'pm';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mStr = m > 0 ? `:${String(m).padStart(2, '0')}` : '';
    return `daily at ${h12}${mStr}${ampm}`;
  }

  // M H * * D  →  weekly DDD at H:MM am/pm
  if (dom === '*' && month === '*' && /^\d$/.test(dow) && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const d = parseInt(dow, 10);
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    if (d >= 0 && d <= 6) {
      const ampm = h < 12 ? 'am' : 'pm';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const mStr = m > 0 ? `:${String(m).padStart(2, '0')}` : '';
      return `weekly ${DAYS[d]} at ${h12}${mStr}${ampm}`;
    }
  }

  return expr;
}

/**
 * Which Health page is rendering. Each route under /app/health shows one
 * slice of the sections; `all` renders every section (the single-page layout,
 * kept for tests and as the reference for what each page holds).
 */
export type HealthView = 'all' | 'overview' | 'failures' | 'runners' | 'operator';

type HealthBlock =
  | 'problems' | 'orphanedPrs' | 'capacity' | 'budget' | 'credentials' | 'agentAccess' | 'dispatch'
  | 'failureAnalytics' | 'gates' | 'taskOutcomes' | 'experiments' | 'consumption'
  | 'subagentDelegation' | 'errorPatterns' | 'failureGroups';

const VIEW_BLOCKS: Record<Exclude<HealthView, 'all'>, ReadonlySet<HealthBlock>> = {
  overview: new Set(['problems']),
  // One failures view (lib/health-failure-groups.ts); the raw breakdown is on Operator.
  // Access problems stop runs and blocked actions are agents reaching outside
  // their task: both are things to act on, so they sit with the failures.
  failures: new Set(['agentAccess', 'failureGroups']),
  // Only what sets capacity. Schedules live on /app/schedules.
  runners: new Set(['capacity', 'budget', 'credentials']),
  operator: new Set([
    'dispatch', 'gates', 'taskOutcomes', 'experiments', 'consumption',
    'subagentDelegation', 'errorPatterns', 'orphanedPrs', 'failureAnalytics',
  ]),
};

/** Runner sandbox posture in plain words; 'sandbox unknown' is deliberately absent (renders nothing). */
const SANDBOX_PLAIN_LABEL: Record<string, string> = {
  sandboxed: 'sandboxed',
  unsandboxed: 'not sandboxed',
  'mounts unrestricted': 'sandbox partly on',
};

const VIEW_TITLE: Record<HealthView, string> = {
  all: 'Health',
  overview: 'Health',
  failures: 'Failures',
  runners: 'Runners & capacity',
  operator: 'Operator',
};

interface Props {
  /** Which page is rendering; defaults to every section. */
  page?: HealthView;
  /** Worker rows whose PR the reconcile sweep gave up on — see OrphanedPrRow. */
  orphanedPrs: OrphanedPrRow[];
  runners: RunnerHeartbeat[];
  usageStats: UsageStats | null;
  consumption: ConsumptionStats | null;
  schedules: ScheduleRow[];
  recentFailures: RecentFailure[];
  credentialHealth: CredentialHealthItem[];
  strandedBackends: StrandedBackendRow[];
  wsFilter: string | null;
  budgetForecast: BudgetForecast | null;
  failureAnalytics: FailureAnalytics | null;
  gateAnalytics: GateAnalytics | null;
  /** The one page window (`?window=`) every TREND section reads. */
  window: FailureWindow;
  subagentDelegation: SubagentDelegationPanel | null;
  errorPatterns: ErrorPatternPanel | null;
  /** Team experiments visible to the viewer; null hides the section. */
  experiments?: HealthExperiments | null;
  /** Dispatch transport health for the scoped workspaces; null hides the section. */
  dispatchHealth?: DispatchHealthReport | null;
  failureGroups?: (FailureGroupsView & { truncated: boolean }) | null;
  /** Agent runs' grants and refusals; null hides the section. */
  agentAccess?: AgentAccessReport | null;
  /**
   * The instant the server rendered this page, in epoch ms.
   *
   * Every freshness/online-ness computation in this file derives from this
   * ONE value instead of calling `Date.now()` at render time. `Date.now()`
   * read inside a client component's render body is read once during SSR
   * and again, moments later, during client hydration — for a runner
   * sitting near the online/offline threshold, or a schedule due right
   * around now, the two reads can disagree and the two renders produce a
   * different tree. Pinning `now` server-side and threading it through as
   * plain data makes the server and hydration renders byte-identical.
   */
  now: number;
}

/**
 * Health, in three sections: Problems → State → Trend.
 *
 * The ordering is the argument. What is broken now comes first; what is true
 * now comes second; what is only true over a period comes last, under a single
 * window control. Each section declares its OWN denominator (`over {N} …`),
 * because the page counts four different populations — workers, terminal worker
 * sessions, tasks, and runners — and one page-wide denominator would be false
 * for three of them.
 *
 * The rendering grammar for each class of number lives in
 * `@/lib/health-metric-grammar`; see its header for the STATE/TREND/LIFETIME/
 * PROJECTION contract this file is an application of.
 */
export function HealthClient({
  orphanedPrs,
  runners,
  usageStats,
  consumption,
  schedules,
  recentFailures,
  credentialHealth,
  strandedBackends,
  wsFilter,
  budgetForecast,
  failureAnalytics,
  gateAnalytics,
  window: activeWindow,
  subagentDelegation,
  errorPatterns,
  experiments = null,
  dispatchHealth = null,
  failureGroups: failureGroupsView = null,
  agentAccess = null,
  now,
  page = 'all',
}: Props) {
  const show = (block: HealthBlock) => page === 'all' || VIEW_BLOCKS[page].has(block);
  // The page window only means something where a TREND section renders.
  const showsTrend = (['failureGroups', 'failureAnalytics', 'gates', 'taskOutcomes', 'experiments', 'consumption', 'subagentDelegation', 'errorPatterns'] as const).some(show);
  const showsState = (['capacity', 'budget', 'credentials', 'dispatch'] as const).some(show);
  const [runnerHealth, setRunnerHealth] = useState<Map<string, RunnerHealthState>>(new Map());

  const checkRunnerHealth = useCallback(async (heartbeatId: string) => {
    const current = runnerHealth.get(heartbeatId);

    if (current?.expanded && !current.loading) {
      setRunnerHealth(prev => {
        const next = new Map(prev);
        next.set(heartbeatId, { ...current, expanded: false });
        return next;
      });
      return;
    }

    setRunnerHealth(prev => {
      const next = new Map(prev);
      next.set(heartbeatId, {
        loading: true,
        expanded: true,
        doctor: current?.doctor,
        historyStats: current?.historyStats,
      });
      return next;
    });

    if (current?.doctor) return;

    const hb = runners.find(r => r.id === heartbeatId);

    if (hb?.connectivity === 'push_only') {
      // Client-only, event-driven (fires from a button click, never during
      // render/SSR) — a fresh clock read here carries no hydration risk.
      const clickNow = Date.now();
      const online = isRunnerOnline(hb.lastHeartbeatAt, clickNow);
      const idlePushOnly = online && hb.activeWorkerCount === 0;
      const beat = timeAgo(hb.lastHeartbeatAt, clickNow);
      setRunnerHealth(prev => {
        const next = new Map(prev);
        next.set(heartbeatId, {
          loading: false,
          expanded: true,
          pushOnlyResult: {
            online,
            message: online
              ? idlePushOnly ? `last beat ${beat} · healthy (idle)` : `last beat ${beat} · healthy`
              : `last beat ${beat} · stale`,
          },
        });
        return next;
      });
      return;
    }

    try {
      const [doctorRes, historyRes] = await Promise.allSettled([
        fetch(`/api/runners/${heartbeatId}/proxy?path=doctor`),
        fetch(`/api/runners/${heartbeatId}/proxy?path=history%2Fstats`),
      ]);

      const doctor = doctorRes.status === 'fulfilled' && doctorRes.value.ok
        ? (await doctorRes.value.json()) as RunnerDoctorResult
        : undefined;

      const historyStats = historyRes.status === 'fulfilled' && historyRes.value.ok
        ? (await historyRes.value.json()) as RunnerHistoryStats
        : undefined;

      const errMsg = !doctor && !historyStats ? 'Runner unreachable. Check that it is running and accessible.' : undefined;

      setRunnerHealth(prev => {
        const next = new Map(prev);
        next.set(heartbeatId, { loading: false, expanded: true, doctor, historyStats, error: errMsg });
        return next;
      });
    } catch {
      setRunnerHealth(prev => {
        const next = new Map(prev);
        next.set(heartbeatId, { loading: false, expanded: true, error: 'Failed to fetch health data.' });
        return next;
      });
    }
  }, [runners, runnerHealth]);


  // `now` comes in as a prop, pinned server-side — see the Props doc comment.
  // Freshness is measured from each stat's OWN last-observed timestamp; `now`
  // is only the instant we measure against, never a substitute for a missing
  // timestamp.

  // Derive problems
  //
  // Credentials arrive whole (healthy ones included) because State renders them
  // as a STATE; only the broken ones are a Problem.
  const brokenCredentials = credentialHealth.filter(
    c => c.healthStatus === 'degraded' || c.healthStatus === 'revoked',
  );
  // Grouped on `normalizeErrorSignature` — the same key the failure-signature
  // table under Trend ranks on, so one incident is one count on both.
  const failureGroups = useMemo(() => groupFailuresBySignature(recentFailures, 5), [recentFailures]);
  const offlineRunners = runners.filter(r => !isRunnerOnline(r.lastHeartbeatAt, now));
  // Every online runner whose sandbox posture is not actually enforced — bwrap
  // denied, or bwrap available with the mount allowlist off. Both are degraded;
  // neither may render as green.
  const degradedSandboxRunners = runners.filter(
    r => isRunnerOnline(r.lastHeartbeatAt, now) && deriveSandboxPosture(r).tier === 'warning',
  );
  // The four seat-auth confessions collapse into ONE page-level sentence. The
  // per-stat markers stay where they are; this only names the shared cause once
  // instead of four times.
  const seatAuthConfession = useMemo(() => {
    if (!consumption) return null;
    const perModelAbsent = consumption.byModel.length === 0 && consumption.totals.inputTokens > 0;
    const costAbsent = consumption.perTask.costUsd.kind === 'unavailable';
    const divergenceAbsent = consumption.modelDivergence.kind === 'unavailable';
    if (!perModelAbsent && !costAbsent && !divergenceAbsent) return null;
    // Plan (subscription) usage does report cost now, valued at list price
    // (docs/specs/real-and-virtual-cost.md), so the cause is not an auth type.
    return 'Some usage figures were not recorded in this window, so they are blank. Each blank shows why.';
  }, [consumption]);

  const failedSchedules = schedules.filter(isScheduleErrorLive);
  // Access problems stop runs before they start, so Overview counts them; the
  // full list (with blocked actions) is on Failures.
  const accessProblems = agentAccess?.grantProblems ?? [];
  // On Overview the failures come from the merged failure groups (the same ones
  // TopFailureGroups renders), so the status sentence and the list can't disagree.
  const overviewFailureGroups = page === 'overview' ? (failureGroupsView?.groups.length ?? 0) : 0;
  const nonFailureProblems =
    brokenCredentials.length > 0 ||
    strandedBackends.length > 0 ||
    offlineRunners.length > 0 ||
    degradedSandboxRunners.length > 0 ||
    failedSchedules.length > 0 ||
    (page === 'overview' && accessProblems.length > 0);
  const hasProblems =
    nonFailureProblems || (page === 'overview' ? overviewFailureGroups > 0 : recentFailures.length > 0);

  // Overview: one status sentence first, short status rows after the attention list.
  const overview = page === 'overview'
    ? {
        headline: overviewHeadline({
          noRunners: runners.length === 0,
          offlineRunners: offlineRunners.length,
          unsandboxedRunners: degradedSandboxRunners.length,
          brokenCredentials: brokenCredentials.length,
          strandedBackends: strandedBackends.length,
          failingSchedules: failedSchedules.length,
          failureGroups: overviewFailureGroups,
          accessProblems: accessProblems.length,
        }),
        rows: overviewStatusRows({
          runners: {
            total: runners.length,
            online: runners.filter(r => isRunnerOnline(r.lastHeartbeatAt, now)).length,
            busySlots: runners.reduce((n, r) => n + (isRunnerOnline(r.lastHeartbeatAt, now) ? r.activeWorkerCount : 0), 0),
            slots: runners.reduce((n, r) => n + (isRunnerOnline(r.lastHeartbeatAt, now) ? r.maxConcurrentWorkers : 0), 0),
          },
          credentials: { total: credentialHealth.length, broken: brokenCredentials.length },
          budget: {
            monthly: budgetForecast?.monthly
              ? { spentUsd: budgetForecast.monthly.spentUsd, budgetUsd: budgetForecast.monthly.budgetUsd, pctUsed: budgetForecast.monthly.pctUsed }
              : null,
            pausedProviders: (budgetForecast?.codex?.isExhausted ? 1 : 0) + (budgetForecast?.claudeTenant?.isExhausted ? 1 : 0),
          },
        }),
      }
    : null;

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      {/* Header — one window control for the whole page, not one per section. */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="hidden md:block text-2xl font-bold">{VIEW_TITLE[page]}</h1>
          {showsTrend && (
            <div className="flex items-center gap-2 ml-auto">
              <WindowPicker window={activeWindow} />
            </div>
          )}
        </div>
      </div>

      {overview && <OverviewHeadline tone={overview.headline.tone} text={overview.headline.text} />}

      {/* 1. Problems now. On Overview the headline already says "All good", so an
          empty Problems section would only repeat it. */}
      {show('problems') && !(overview && !hasProblems) && (
      <section data-testid="health-section-problems" className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="section-label">Problems</h2>
          {page !== 'overview' && failureGroups.total > 0 && (
            <span data-testid="problems-denominator" className="text-[11px] text-text-muted">
              {sectionDenominator(
                failureGroups.total,
                failureGroups.total === 1 ? 'failed worker' : 'failed workers',
              )} · last 24h
            </span>
          )}
        </div>
        {!hasProblems ? (
          <div className="card px-4 py-3 flex items-center gap-2">
            <span className="glow-dot glow-dot-success" />
            <span className="text-sm text-status-success font-medium">All systems healthy</span>
          </div>
        ) : (
          <>
          {(page !== 'overview' || nonFailureProblems) && (
          <div className={`card divide-y divide-border-default ${page === 'overview' ? 'mb-4' : ''}`}>
            {/* Revoked / degraded credentials */}
            {brokenCredentials.map((cred) => {
              const purposeLabel =
                cred.purpose === 'oauth_token' ? 'Claude OAuth token'
                : cred.purpose === 'anthropic_api_key' ? 'Anthropic API key'
                : cred.purpose === 'codex_credential' ? 'Codex credential'
                : cred.purpose;
              const isRevoked = cred.healthStatus === 'revoked';
              return (
                <div key={cred.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-text-primary">{purposeLabel}</p>
                        <span className={`text-[11px] md:text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          isRevoked
                            ? 'bg-status-error/10 text-status-error'
                            : 'bg-status-warning/10 text-status-warning'
                        }`}>
                          {isRevoked ? 'revoked' : 'degraded'}
                        </span>
                        {cred.consecutiveAuthFailures > 0 && (
                          <span
                            className="text-[11px] md:text-[10px] text-text-muted"
                            title="Consecutive auth failures: a lifetime streak that resets on the next success. The page window doesn't apply."
                          >
                            auth failures {failureStreak(cred.consecutiveAuthFailures)}
                          </span>
                        )}
                      </div>
                      {cred.lastFailureAt && (
                        <p className="text-xs text-text-muted mt-0.5">
                          Last failure: {timeAgo(cred.lastFailureAt, now)}
                          {cred.lastFailureMessage && (
                            <span className={`ml-1 ${isRevoked ? 'text-status-error' : 'text-status-warning'}`}>
                              · {cred.lastFailureMessage.slice(0, 100)}
                            </span>
                          )}
                        </p>
                      )}
                      {cred.lastVerifiedAt && (
                        <p className="text-xs text-text-muted mt-0.5">
                          Last verified: {timeAgo(cred.lastVerifiedAt, now)}
                        </p>
                      )}
                    </div>
                    <a
                      href="/app/settings/runners"
                      className="text-[11px] px-2.5 h-7 flex items-center rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors shrink-0"
                    >
                      Fix in Settings
                    </a>
                  </div>
                </div>
              );
            })}

            {/* Backends stranding pending work — a missing credential, counted in
                tasks. Deliberately NOT a task-level gate (PR #1864): the same
                module feeds Settings → Agent backends, which is where the fix is. */}
            {strandedBackends.map((b) => (
              <div key={`strand-${b.backend}`} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-text-primary">
                        {b.label} has no credential
                      </p>
                      <span className="text-[11px] md:text-[10px] px-1.5 py-0.5 rounded font-medium bg-status-error/10 text-status-error">
                        {b.strandedPending} task{b.strandedPending === 1 ? '' : 's'} unclaimable
                      </span>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      Pending work routes to {b.label}, and no runner can claim it
                      {b.enabledForTeam ? '. Connect it, or disable it team-wide to reroute' : ''}.
                    </p>
                    {b.sampleTasks.length > 0 && (
                      <p className="text-xs text-text-muted mt-0.5 truncate">
                        {b.sampleTasks.map((t) => t.title).join(' · ')}
                        {b.strandedPending > b.sampleTasks.length
                          ? ` · +${b.strandedPending - b.sampleTasks.length} more`
                          : ''}
                      </p>
                    )}
                  </div>
                  <a
                    href="/app/settings/runners"
                    className="text-[11px] px-2.5 h-7 flex items-center rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors shrink-0"
                  >
                    Fix in Settings
                  </a>
                </div>
              </div>
            ))}

            {/* Offline runners */}
            {offlineRunners.map((hb) => (
              <div key={hb.id} className="px-4 py-3 flex items-center gap-3">
                <span className="glow-dot" style={{ background: 'var(--status-error)' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {hb.accountName || 'Runner'} offline
                  </p>
                  <p className="text-xs text-text-muted">last beat {timeAgo(hb.lastHeartbeatAt, now)}</p>
                </div>
              </div>
            ))}

            {/* Degraded sandbox posture — working but not confined, warning tier */}
            {degradedSandboxRunners.map((hb) => {
              const posture = deriveSandboxPosture(hb);
              return (
                <div key={`sandbox-${hb.id}`} className="px-4 py-3 flex items-center gap-3">
                  <span className="text-status-warning shrink-0 text-sm">⚠</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {hb.accountName || 'Runner'}: {posture.label}
                    </p>
                    <p className="text-xs text-text-muted">{posture.detail}</p>
                  </div>
                </div>
              );
            })}

            {/* Schedules with errors */}
            {page === 'overview' && accessProblems.map((p) => (
              <a key={`access-${p.workspaceId}-${p.reason}`} href="/app/health/failures" data-testid="problem-access" className="block px-4 py-3 hover:bg-surface-2">
                <p className="text-sm font-medium text-text-primary">{p.workspaceName}: runs can&apos;t get access</p>
                <p className="text-xs text-text-muted mt-0.5">{p.reason} ({p.count}×){p.fix ? `. ${p.fix}` : ''}</p>
              </a>
            ))}

            {failedSchedules.map((s) => (
              <div key={s.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="text-status-error mt-0.5 shrink-0 text-sm">⚠</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary truncate">{s.name}</p>
                    <p className="text-xs text-status-error mt-0.5 truncate">{s.lastError}</p>
                    <p className="text-xs text-text-muted mt-0.5">{s.workspaceName}</p>
                  </div>
                </div>
              </div>
            ))}

            {/* Recent failures, grouped by error signature.
                Fixed 24h regardless of `?window=` — documented exception (spec
                §2.3): this is a triage feed, not a trend, and at 30d it would be
                a 20-row-capped dump of month-old failures. */}
            {page !== 'overview' && failureGroups.groups.map((g) => {
              const sample = g.sample;
              return (
                <div key={g.signature} className="px-4 py-3" data-testid="problem-failure-group">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-mono font-bold tabular-nums text-status-error shrink-0">
                          {g.count}×
                        </span>
                        <span
                          className="text-sm text-text-primary truncate"
                          title={sample.error ?? g.signature}
                        >
                          {g.signature}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        last {timeAgo(g.lastSeen, now)} · {sample.workspaceName}
                        {' · '}
                        {sample.taskId ? (
                          <a href={`/app/tasks/${sample.taskId}`} className="hover:text-primary">
                            {sample.taskTitle}
                          </a>
                        ) : (
                          sample.taskTitle
                        )}
                      </p>
                    </div>
                    <span className="text-[11px] md:text-[10px] px-1.5 py-0.5 rounded bg-status-error/10 text-status-error font-medium shrink-0">
                      last 24h
                    </span>
                  </div>
                </div>
              );
            })}

            {page !== 'overview' && failureGroups.hiddenFailures > 0 && (
              <div className="px-4 py-2.5">
                <span className="text-xs text-text-muted">
                  +{failureGroups.hiddenFailures} more failure
                  {failureGroups.hiddenFailures === 1 ? '' : 's'} in{' '}
                  {failureGroups.hiddenGroups} other group
                  {failureGroups.hiddenGroups === 1 ? '' : 's'} · see{' '}
                  <a href="/app/health/failures" className="underline hover:text-text-primary">Failures</a>
                </span>
              </div>
            )}
          </div>
          )}
          {page === 'overview' && <TopFailureGroups groups={failureGroupsView} now={now} />}
          </>
        )}
      </section>
      )}

      {overview && <OverviewStatusRows rows={overview.rows} />}

      {show('orphanedPrs') && <OrphanedPrsBlock rows={orphanedPrs} now={now} />}

      {/* 2. State — what is true right now. Every number here renders its own
          freshness (`as of {N}h ago`) from the stat's own timestamp, and never
          the page window: a window does not make a state more true. */}
      {showsState && (
      <section data-testid="health-section-state" className="mb-6">
        {page === 'all' && <h2 className="section-label mb-3">State</h2>}

      {show('capacity') && (
        <OccupancyChart
          capacityNow={runners.reduce((n, r) => n + (isRunnerOnline(r.lastHeartbeatAt, now) ? r.maxConcurrentWorkers : 0), 0)}
          busyNow={runners.reduce((n, r) => n + (isRunnerOnline(r.lastHeartbeatAt, now) ? r.activeWorkerCount : 0), 0)}
          workspaceId={wsFilter}
        />
      )}

      {show('capacity') && (
      <div data-testid="health-section-runners" className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h3 className="text-xs font-medium text-text-secondary">Runners</h3>
          {runners.length > 0 && (
            <span className="text-[11px] text-text-muted">{countOf(runners.length, 'runner')}</span>
          )}
        </div>
        <div className="card">
          {runners.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-sm text-text-muted">No runners connected</p>
            </div>
          ) : (
            <div className="divide-y divide-border-default">
              {runners.map((hb) => {
                const online = isRunnerOnline(hb.lastHeartbeatAt, now);
                const idle = online && hb.activeWorkerCount === 0;
                const health = runnerHealth.get(hb.id);
                const statusLabel = online ? (idle ? 'idle' : 'working') : 'offline';
                const statusClass = online
                  ? idle ? 'text-text-muted' : 'text-status-success'
                  : 'text-text-muted';
                // Green means ENFORCED (namespace + mount allowlist), never merely
                // "bwrap is installed here" — see deriveSandboxPosture.
                const posture = deriveSandboxPosture(hb);
                // Plain words; an unknown posture says nothing rather than "sandbox unknown".
                const sandboxLabel = SANDBOX_PLAIN_LABEL[posture.label] ?? null;
                const sandboxClass = posture.tier === 'success'
                  ? 'text-status-success'
                  : posture.tier === 'warning'
                    ? 'text-status-warning'
                    : 'text-text-muted';
                return (
                  <div key={hb.id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span
                        className={`glow-dot ${online ? 'glow-dot-success' : ''}`}
                        style={!online ? { background: 'var(--text-muted)' } : undefined}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm text-text-primary truncate">
                            {hb.accountName || 'Runner'}
                          </p>
                          <span className={`text-[11px] md:text-[10px] font-mono ${statusClass}`}>
                            {statusLabel}
                          </span>
                          {sandboxLabel && (
                            <span
                              className={`text-[11px] md:text-[10px] font-mono ${sandboxClass}`}
                              title={`${posture.detail}${hb.sandboxProbeAt ? ` · probed ${timeAgo(hb.sandboxProbeAt, now)}` : ' · never probed'}`}
                            >
                              {sandboxLabel}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted">
                          {hb.activeWorkerCount} of {hb.maxConcurrentWorkers} agents running ·{' '}
                          {online ? `checked ${observedAgo(hb.lastHeartbeatAt, now) ?? 'just now'}` : `last seen ${observedAgo(hb.lastHeartbeatAt, now) ?? 'never'}`}
                        </p>
                      </div>
                      <button
                        onClick={() => checkRunnerHealth(hb.id)}
                        disabled={health?.loading}
                        className="text-[11px] px-2.5 h-7 border border-border-default text-text-secondary hover:text-text-primary hover:border-border-strong disabled:opacity-50 transition-colors shrink-0"
                      >
                        {health?.loading ? '…' : health?.expanded ? 'Hide' : 'Check health'}
                      </button>
                    </div>
                    {health?.expanded && (
                      <div className="px-4 pb-4 space-y-3 border-t border-border-default bg-surface-1/50">
                        {health.pushOnlyResult && (
                          <p className={`pt-3 text-xs ${health.pushOnlyResult.online ? 'text-status-success' : 'text-status-warning'}`}>
                            Push-only runner · {health.pushOnlyResult.message}
                          </p>
                        )}
                        {health.error && (
                          <p className="pt-3 text-xs text-status-error">{health.error}</p>
                        )}
                        {health.doctor && (
                          <div className="pt-3">
                            <p className="text-[11px] font-medium text-text-secondary mb-2 uppercase tracking-wide">
                              Doctor checks
                              <span className="ml-2 font-normal normal-case text-text-muted">
                                {health.doctor.summary.ok} ok
                                {health.doctor.summary.warn > 0 && ` · ${health.doctor.summary.warn} warn`}
                                {health.doctor.summary.error > 0 && ` · ${health.doctor.summary.error} error`}
                              </span>
                            </p>
                            <div className="space-y-1">
                              {health.doctor.checks.map((c) => (
                                <div key={c.name} className="flex items-start gap-2">
                                  <span className={`text-[11px] font-mono shrink-0 mt-0.5 ${STATUS_CLASS[c.status]}`}>
                                    {STATUS_ICON[c.status]}
                                  </span>
                                  <div className="min-w-0">
                                    <span className="text-xs text-text-primary font-mono">{c.name}</span>
                                    {c.message && (
                                      <span className="text-xs text-text-muted ml-1.5">{c.message}</span>
                                    )}
                                    {c.detail && (
                                      <p className="text-[11px] text-text-tertiary mt-0.5 break-words">{c.detail}</p>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {health.historyStats && (
                          <div className={health.doctor ? 'border-t border-border-default pt-3' : 'pt-3'}>
                            {/* LIFETIME, and runner-local: this comes from the
                                runner's own SQLite, which has no team or
                                workspace predicate at all. It cannot obey the
                                page window and must not look like it does. */}
                            <p className="text-[11px] font-medium text-text-secondary mb-2 uppercase tracking-wide">
                              Session history
                              <span className="ml-2 font-normal normal-case text-text-muted">
                                {RUNNER_LIFETIME_LABEL}
                              </span>
                            </p>
                            <div className="flex gap-4 flex-wrap">
                              <div>
                                <span className="text-xs text-text-muted">Sessions</span>
                                <p className="text-sm font-medium text-text-primary tabular-nums">{health.historyStats.totalSessions}</p>
                              </div>
                              {health.historyStats.totalCost > 0 && (
                                <div>
                                  <span className="text-xs text-text-muted">Total cost</span>
                                  <p className="text-sm font-medium text-text-primary tabular-nums">{formatCost(health.historyStats.totalCost)}</p>
                                </div>
                              )}
                              {health.historyStats.avgDurationMs > 0 && (
                                <div>
                                  <span className="text-xs text-text-muted">Avg duration</span>
                                  <p className="text-sm font-medium text-text-primary tabular-nums">{formatDuration(health.historyStats.avgDurationMs)}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      )}

      {show('budget') && budgetForecast && <BudgetForecastSection forecast={budgetForecast} now={now} />}

      {show('credentials') && credentialHealth.length > 0 && (
        <CredentialStateSection credentials={credentialHealth} now={now} />
      )}

      {show('dispatch') && <DispatchSection report={dispatchHealth ?? null} now={now} />}

      </section>
      )}

      {/* 3. Trend — only meaningful aggregated over a period. Everything here
          obeys `?window=` and says so; nothing here renders freshness. */}
      {showsTrend && (
      <section data-testid="health-section-trend" className="mb-6">
        {/* On its own page the window picker in the header already names the window. */}
        {page === 'all' && (
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h2 className="section-label">Trend</h2>
            <span className="text-[11px] text-text-muted">last {activeWindow}</span>
          </div>
        )}

        {/* ONE page-level statement of the shared root cause. The per-stat
            em-dashes and tooltips below stay exactly as they were — the collapse
            is of the explanation, not of the markers, which
            docs/design/derived-metric-availability.md requires at each stat. */}
        {show('consumption') && seatAuthConfession && (
          <p data-testid="seat-auth-confession" className="text-[11px] text-text-muted mb-3">
            {seatAuthConfession}
          </p>
        )}

        {show('failureGroups') && (
          <FailureGroupsSection
            groups={failureGroupsView}
            headline={failureAnalytics ? { failureRatePct: failureAnalytics.totals.failureRatePct, failed: failureAnalytics.totals.failed, terminal: failureAnalytics.totals.terminal } : null}
            windowLabel={activeWindow}
            now={now}
          />
        )}

        {/* After the failures: access problems and blocked actions are fewer and fixed-window (24h). */}
        {show('agentAccess') && <AgentAccessSection report={agentAccess} />}

        {show('failureAnalytics') && failureAnalytics && (
          <FailureAnalyticsSection analytics={failureAnalytics} window={activeWindow} now={now} />
        )}

        {show('gates') && gateAnalytics && <GatesSection gates={gateAnalytics} window={activeWindow} />}

        {show('taskOutcomes') && usageStats && usageStats.total > 0 && (
          <TaskOutcomesSection stats={usageStats} window={activeWindow} />
        )}

        {show('experiments') && <ExperimentsSection data={experiments} />}

        {show('consumption') && consumption && consumption.totals.tasks > 0 && (
          <ConsumptionSection stats={consumption} workspaceId={wsFilter} now={now} />
        )}

        {show('subagentDelegation') && subagentDelegation && (
          <SubagentDelegationSection panel={subagentDelegation} window={activeWindow} />
        )}

        {show('errorPatterns') && errorPatterns && (
          <ErrorPatternSection panel={errorPatterns} window={activeWindow} />
        )}
      </section>
      )}

    </div>
  );
}

// ── Consumption ───────────────────────────────────────────────────────────────

/** Compact token counts — per-task input runs into the millions. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return '';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

/**
 * PRs the reconcile sweep gave up on.
 *
 * A row reaches this list only after failing to resolve against GitHub
 * UNRESOLVABLE_FAILURE_THRESHOLD times while older than the unknown TTL, so it
 * is a genuine orphan — a deleted PR, a repo that moved, a workspace whose
 * GitHub App installation no longer covers it. It states the reason rather
 * than a CTA, because there is no one-tap fix: something outside buildd has to
 * change before this row can ever resolve.
 *
 * This is the surface that lets the action queue drop these rows without
 * dropping them silently.
 */
function OrphanedPrsBlock({ rows, now }: { rows: OrphanedPrRow[]; now: number }) {
  // No orphans is the expected state — an empty block would be noise.
  if (rows.length === 0) return null;

  return (
    <div data-testid="health-section-orphaned-prs" className="mt-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="section-label">Orphaned PRs</h3>
        <span className="text-xs text-text-muted">
          {sectionDenominator(rows.length, rows.length === 1 ? 'PR' : 'PRs')}
        </span>
      </div>
      <p className="text-xs text-text-muted mb-2">
        buildd couldn&apos;t resolve these against GitHub and stopped retrying. Home hides
        them. None of them is a merge you can make.
      </p>
      <div className="border border-border divide-y divide-border">
        {rows.map(row => (
          <div key={row.workerId} className="px-4 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] md:text-[10px] px-1.5 py-0.5 rounded bg-surface-raised text-text-muted font-mono shrink-0">
                {row.workspaceName}
              </span>
              <span className="text-sm text-text-primary truncate">
                {row.taskId ? (
                  <a href={`/app/tasks/${row.taskId}`} className="hover:text-primary">
                    {row.taskTitle ?? `PR #${row.prNumber}`}
                  </a>
                ) : (
                  row.taskTitle ?? `PR #${row.prNumber}`
                )}
              </span>
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              {row.reason ?? 'Unresolvable'} · {row.failureCount} failed check
              {row.failureCount === 1 ? '' : 's'} · last tried {timeAgo(row.lastCheckedAt, now)}
              {row.prUrl && (
                <>
                  {' · '}
                  <a href={row.prUrl} target="_blank" rel="noopener noreferrer" className="hover:text-primary">
                    PR #{row.prNumber} ↗
                  </a>
                </>
              )}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What work costs, next to whether it landed. Medians (not means) lead every
 * row: one runaway task skews a mean badly enough to make the number useless.
 */
function ConsumptionSection({
  stats,
  workspaceId,
  now,
}: {
  stats: ConsumptionStats;
  /** Carried into the drill-down link so the scope survives the navigation. */
  workspaceId: string | null;
  now: number;
}) {
  const { totals, tools, groups, window, byModel, modelDivergence, scan } = stats;
  // Group tools and the legacy buildd tool are one row, so history stays continuous.
  const byTool = foldBuilddActionTools(tools.byTool);
  const topTools = byTool.slice(0, CONSUMPTION_TOP_TOOLS);
  const toolGroups = groupToolsByServer(byTool);
  const breakdownFor = (list: typeof tools.byTool) => buildToolBreakdown({
    tools: list,
    // Each source may be absent (older rows, a failed read): that row stays plain.
    bashBuckets: stats.bashBuckets?.classifiedCalls ? stats.bashBuckets : null,
    actions: stats.builddActions ?? null,
    fileAreas: stats.fileAreas?.tasksWithAreas ? stats.fileAreas.byTool : null,
  });
  const topRows = breakdownFor(topTools);
  const maxToolCalls = topTools[0]?.calls ?? 0;
  const coverageGap = tools.coverage.tasks - tools.coverage.histogram;
  const topModels = byModel.slice(0, 6);
  const divergence = divergenceSummary(modelDivergence);
  // Qualifies every number in this section, not just the model rows: the page
  // reads worker rows directly and the read is capped.
  const caveat = scanCaveat(scan, timeAgo(scan.completeSince, now));

  return (
    <div data-testid="health-section-consumption" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">
          Consumption
          <span className="ml-2 font-normal text-text-muted">
            {sectionDenominator(totals.tasks, totals.tasks === 1 ? 'task' : 'tasks')} ({window})
          </span>
        </h3>
        {caveat && (
          <span
            data-testid="consumption-scan-caveat"
            className="text-[11px] text-text-muted text-right"
            title={`Newest ${scan.limit} finished workers only. Figures are floors for ${window}; complete from ${scan.completeSince}.`}
          >
            {caveat}
          </span>
        )}
      </div>
      <div className="card p-4 space-y-4">
        {/* The per-task cost/turn/tool-call tiles that used to sit here now live
            on the usage drill-down, whole — not copied. Publishing them in two
            places is how the same number ends up stated under two windows. */}
        <a
          data-testid="consumption-drilldown-link"
          href={usageDrilldownHref({ window, workspaceId })}
          className="flex items-baseline justify-between gap-3 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <span>Cost per task: tokens, turns, tool calls, cost</span>
          <span className="text-primary shrink-0">usage →</span>
        </a>
        <a
          data-testid="insights-link"
          href="/app/health/insights"
          className="flex items-baseline justify-between gap-3 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <span>How work moves to production, and how much agent time shipped</span>
          <span className="text-primary shrink-0">insights →</span>
        </a>

        {topTools.length > 0 && (
          <div className="space-y-2 pt-1 border-t border-border-default">
            <div className="flex items-center justify-between pt-3">
              <span className="text-xs text-text-secondary">Top tools</span>
              {coverageGap > 0 && (
                <span
                  data-testid="tool-coverage"
                  className="text-xs text-text-muted"
                  title="Older tasks are reconstructed from a capped MCP call log. ≥ marks those counts as floors."
                >
                  {/* `≥` when any counted row is reconstructed rather than
                      measured: without it, a floor reads as an exact count. */}
                  {coverageLabel({
                    covered: tools.coverage.histogram,
                    population: tools.coverage.tasks,
                    hasDerived: tools.coverage.derived > 0,
                  })}{' '}
                  tasks measured exactly
                </span>
              )}
            </div>
            <ToolBreakdownList rows={topRows} maxCalls={maxToolCalls} />

            {/* Every tool, not just the head: anything below the top rows —
                the graph, recall, ToolSearch — was invisible before. Same
                task-keyed counts and coverage as the rows above. */}
            {byTool.length > topTools.length && (
              <details data-testid="consumption-all-tools" className="pt-1 group">
                <summary className="text-xs text-primary cursor-pointer select-none list-none">
                  <span className="group-open:hidden">Show all {byTool.length} tools</span>
                  <span className="hidden group-open:inline">Hide the full list</span>
                </summary>
                <div className="mt-3 space-y-3">
                  {toolGroups.map((g) => (
                    <div key={g.key} data-testid="consumption-tool-group" className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11px] uppercase tracking-wide text-text-muted">{g.label}</span>
                        <span className="text-[11px] text-text-muted tabular-nums">{g.calls.toLocaleString('en-US')}</span>
                      </div>
                      <ToolBreakdownList rows={breakdownFor(g.tools)} maxCalls={maxToolCalls} />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        <div data-testid="consumption-by-model" className="space-y-2 pt-3 border-t border-border-default">
          <span className="text-xs text-text-secondary">By model</span>

          {topModels.length > 0 ? (
            <>
              <div className="flex items-center gap-2 text-[11px] md:text-[9px] uppercase tracking-wide text-text-muted">
                <span className="flex-1 min-w-0">model</span>
                <span className="w-14 text-right">tokens</span>
                <span className="w-16 text-right">cost</span>
                <span className="w-10 text-right">share</span>
                <span
                  className="hidden md:block w-24 text-right"
                  title="Workers that reported this model. A worker whose fallback fired reports two models and counts in both rows, so this column can sum to more than the number of workers."
                >
                  workers reporting
                </span>
              </div>
              {topModels.map((m) => (
                <div key={m.model} className="flex items-center gap-2">
                  <span className="text-xs text-text-primary flex-1 truncate min-w-0" title={m.model}>
                    {getModelDisplayName(m.model)}
                  </span>
                  <span className="w-14 text-right text-[11px] text-text-muted tabular-nums">
                    {fmtTokens(m.inputTokens + m.outputTokens)}
                  </span>
                  <span className="w-16 text-right text-[11px] text-text-muted tabular-nums">
                    {fmtCost(m.costUsd)}
                  </span>
                  <span className="w-10 text-right text-[11px] text-text-muted tabular-nums">
                    {Math.round(m.share * 100)}%
                  </span>
                  <span className="hidden md:block w-24 text-right text-[11px] text-text-muted tabular-nums">
                    {m.workers}
                  </span>
                </div>
              ))}
            </>
          ) : (
            /* Never a silently empty block: on seat/OAuth auth the SDK reports
               no per-model usage at all, for every worker on the team. */
            <p data-testid="consumption-by-model-absent" className="text-[11px] text-text-muted">
              {byModelAbsence(totals.inputTokens)}
            </p>
          )}

          <div className="flex items-baseline justify-between gap-3 pt-2">
            <div className="min-w-0">
              <div
                className="text-[11px] md:text-[9px] uppercase tracking-wide text-text-muted"
                title="How often the model that ran differed from the one assigned. A family alias matches any release in that family."
              >
                assigned vs actual
              </div>
              <div className="text-[11px] text-text-muted">{divergence.note}</div>
            </div>
            <span
              className={`text-sm tabular-nums ${modelDivergence.kind === 'value' ? 'text-text-primary' : 'text-text-muted'}`}
            >
              {divergence.headline}
            </span>
          </div>
        </div>

        {groups.length > 0 && (
          <div className="space-y-2 pt-3 border-t border-border-default">
            <span className="text-xs text-text-secondary">By role</span>
            {groups.slice(0, 5).map((g) => {
              const gIn = g.perTask.inputTokens;
              return (
                <div key={g.key} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                  <span className="text-xs text-text-primary flex-1 truncate">{g.label}</span>
                  <span className="text-xs text-text-muted tabular-nums">
                    {g.tasks} task{g.tasks !== 1 ? 's' : ''}
                    {gIn.kind === 'value' ? ` · ${fmtTokens(gIn.value.median)}` : ''}
                    {g.successRate !== null && ` · ${Math.round(g.successRate * 100)}%`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Delegated work: what share of a session's total agent-effort (wall clock +
 * background subagent time) was handed to background subagents. See
 * `subagent-time.ts` for why background time is additional effort rather than
 * a slice taken out of wall clock, and why pre-capture sessions are excluded
 * rather than counted as zero delegation.
 */
function SubagentDelegationSection({
  panel,
  window,
}: {
  panel: SubagentDelegationPanel;
  window: FailureWindow;
}) {
  return (
    <div data-testid="health-section-subagent-delegation" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Delegated work</h3>
        {/* Sessions, not tasks: subagent spans are flushed per worker attempt,
            with no dedup by task. */}
        <span className="text-[11px] text-text-muted">
          {panel.kind === 'value'
            ? sectionDenominator(panel.value.sessions, panel.value.sessions === 1 ? 'session' : 'sessions')
            : sectionDenominator(0, 'sessions')} ({window})
        </span>
      </div>
      <div className="card p-4 space-y-2">
        {panel.kind === 'value' ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span
                className="text-xs text-text-secondary"
                title="Background subagents run alongside the parent session rather than inside its wall clock, so this is a share of total agent effort (wall clock + background time)."
              >
                Median share of session effort in background subagents
              </span>
              <span className="text-sm tabular-nums text-text-primary" data-testid="subagent-delegation-share">
                {panel.value.isFloor ? '≥' : ''}{panel.value.medianSharePct}%
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-text-muted">Sessions that delegated any work</span>
              <span className="text-xs text-text-muted tabular-nums">
                {countOf(panel.value.sessionsWithDelegation, 'session')} of {panel.value.sessions}
              </span>
            </div>
          </>
        ) : (
          <p data-testid="subagent-delegation-unavailable" className="text-xs text-text-muted">
            {panel.detail}
          </p>
        )}
        {panel.kind === 'value' && panel.value.windowPredatesCapture && (
          <p className="text-[11px] text-text-muted pt-2 border-t border-border-default">
            buildd has tracked background-agent time since {panel.value.capturedSince}. This panel
            excludes earlier sessions instead of counting them as zero delegation.
          </p>
        )}
        {panel.kind === 'value' && panel.value.truncated && (
          <p className="text-[11px] text-text-muted">
            Reads the newest sessions in the window up to a cap. Figures above are a floor.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Error trace patterns ─────────────────────────────────────────────────────

/**
 * Which scanned error pattern (`worker_error_traces.pattern`) is costing us
 * the most, over the page window. See `error-pattern-cost.ts` for the ranking
 * argument — the header line below states the ranking key inline, not just in
 * the PR that shipped it.
 */
function ErrorPatternSection({
  panel,
  window,
}: {
  panel: ErrorPatternPanel;
  window: FailureWindow;
}) {
  return (
    <div data-testid="health-section-error-patterns" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Error trace patterns</h3>
        <span className="text-[11px] text-text-muted">
          {panel.kind === 'value'
            ? sectionDenominator(panel.value.scannedWorkers, panel.value.scannedWorkers === 1 ? 'worker' : 'workers')
            : sectionDenominator(0, 'workers')} ({window})
        </span>
      </div>
      <div className="card p-4 space-y-2">
        {panel.kind === 'value' ? (
          panel.value.patterns.length === 0 ? (
            <p className="text-xs text-text-muted">No error-trace pattern fired in this window.</p>
          ) : (
            <>
              <p
                className="text-[11px] text-text-muted"
                title="Raw occurrence count would rank a pattern that fires often on harmless output above a rare one that always coincides with a dead worker."
              >
                Ranked by distinct workers whose session failed while this pattern fired.
              </p>
              <div className="divide-y divide-border-default">
                {panel.value.patterns.map((p) => {
                  const topFailedWorkers = panel.value.patterns[0]?.failedWorkers ?? 0;
                  return (
                    <div key={p.pattern} className="py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <span className="text-xs font-mono font-bold tabular-nums text-text-primary shrink-0 w-8 text-right">
                          {p.failedWorkers}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs font-mono text-text-primary truncate" title={p.pattern}>
                            {p.pattern}
                          </span>
                          <span className="block text-xs text-text-muted mt-0.5">
                            {countOf(p.workers, 'worker')} hit it · {countOf(p.occurrences, 'occurrence')}
                          </span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 bg-surface-3 overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${topFailedWorkers > 0 ? Math.round((p.failedWorkers / topFailedWorkers) * 100) : 0}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )
        ) : (
          <p data-testid="error-patterns-unavailable" className="text-xs text-text-muted">
            {panel.detail}
          </p>
        )}
        {panel.kind === 'value' && panel.value.windowPredatesCapture && (
          <p className="text-[11px] text-text-muted pt-2 border-t border-border-default">
            The scanner&apos;s false-positive gating landed on {panel.value.gatedSince}. This panel counts
            traces from that date on and excludes earlier ones instead of counting them as zero.
          </p>
        )}
        {panel.kind === 'value' && panel.value.truncated && (
          <p className="text-[11px] text-text-muted">
            Reads the newest traces in the window up to a cap. Counts above are a floor.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Budget Forecast ───────────────────────────────────────────────────────────

function confidenceClass(c: string | null): string {
  if (c === 'high') return 'text-status-success';
  // low/medium confidence is noise, not a warning — keep it muted
  return 'text-text-muted';
}

function timeUntilShort(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / (60 * 60 * 1000));
  if (h < 1) return `${Math.ceil(ms / 60000)}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function formatReset(iso: string, now: number): string {
  const t = timeUntilShort(iso, now);
  return t === 'now' ? 'resetting' : `resets in ${t}`;
}

function ProviderWallRow({ label, state, resetsAt, now }: {
  label: string;
  state: string;
  resetsAt: string | null;
  now: number;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 gap-y-1">
        <span className="text-sm text-text-primary">{label}</span>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-status-error font-medium">{state}</span>
          {resetsAt && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-secondary">{formatReset(resetsAt, now)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BudgetForecastSection({ forecast, now }: { forecast: BudgetForecast; now: number }) {
  const hasAny =
    forecast.oauthSessions.length > 0 ||
    forecast.monthly !== null ||
    // Wall rows only render while exhausted; an elapsed pause alone must not
    // leave an empty card.
    !!forecast.codex?.isExhausted ||
    !!forecast.claudeTenant?.isExhausted ||
    forecast.missions.length > 0;

  if (!hasAny) return null;

  const activeSessions = forecast.oauthSessions.filter(s => s.state === 'active');
  const learningSessions = forecast.oauthSessions.filter(s => s.state === 'learning');

  return (
    <div data-testid="health-section-budget-forecast" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Budget</h3>
        {/* Pinned to each provider's own usage period and the calendar month,
            never to a page window; this page has no window control. */}
        <span className="text-[11px] text-text-muted text-right">usage limits and monthly spend</span>
      </div>
      <div className="card divide-y divide-border-default">

        {/* Active OAuth session rows — labeled by account name */}
        {activeSessions.map((s) => (
          <div key={s.accountId} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 gap-y-1">
              <span className="text-sm text-text-primary">{s.accountName || 'Claude session'}</span>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span
                  className="tabular-nums font-medium text-text-primary"
                  title="Usage vs. conservative floor (p25 of exhaustion history). Remaining capacity is usually higher."
                >
                  {s.pressurePct}% of usual limit
                </span>
                <span className="text-text-muted">·</span>
                <span>{formatReset(s.windowEndsAt, now)}</span>
                {s.confidence && s.confidence !== 'low' && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span
                      className={confidenceClass(s.confidence)}
                      title={
                        s.confidence === 'high'
                          ? `Conservative floor estimate from ${s.episodes} exhaustion episode${s.episodes !== 1 ? 's' : ''}${s.limiter === 'tokens' ? '. OAuth often underreports token data' : ''}`
                          : undefined
                      }
                    >
                      {s.confidence === 'high' ? 'floor est.' : `confidence: ${s.confidence}`}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  s.pressurePct >= 90 ? 'bg-status-error' :
                  s.pressurePct >= 70 ? 'bg-status-warning' :
                  'bg-primary'
                }`}
                style={{ width: `${Math.min(100, s.pressurePct)}%` }}
              />
            </div>
          </div>
        ))}

        {/* Collapsed learning sessions — one summary line instead of per-row cards */}
        {learningSessions.length > 0 && (
          <div className="px-4 py-2.5">
            <span className="text-xs text-text-muted" title="No exhaustion events recorded. Sessions only learn on hitting the session wall.">
              {countOf(learningSessions.length, 'Claude sign-in')} · no usage limit hit so far
            </span>
          </div>
        )}

        {/* Monthly dollar budget */}
        {forecast.monthly && (
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 gap-y-1">
              <span className="text-sm text-text-primary">Monthly budget</span>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                {/* LIFETIME (calendar): spend accumulates from the 1st, so it is
                    labelled with that anchor rather than left to look windowed. */}
                <span className="tabular-nums font-medium text-text-primary" title={ESTIMATED_COST_TITLE}>
                  {formatEstimatedUsd(forecast.monthly.spentUsd)} / ${forecast.monthly.budgetUsd.toFixed(0)}
                </span>
                <span className="text-text-muted">·</span>
                <span data-testid="monthly-anchor">{monthlyAnchor(forecast.monthly.resetsAt)}</span>
                <span className="text-text-muted">·</span>
                <span>{formatReset(forecast.monthly.resetsAt, now)}</span>
                {/* PROJECTION: the runway and the window its burn rate came from
                    are ONE string, so the value can never be read as windowed by
                    the page control. */}
                {depletionProjection(forecast.monthly.daysToDepletion, '24h') && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span data-testid="budget-runway">
                      {depletionProjection(forecast.monthly.daysToDepletion, '24h')}
                    </span>
                  </>
                )}
                {forecast.monthly.confidence !== 'low' && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span
                      className={confidenceClass(forecast.monthly.confidence)}
                      title={forecast.monthly.confidence === 'high' ? 'Burn rate estimate from recent worker costs. High confidence means a stable reading. It is not a guarantee.' : undefined}
                    >
                      {forecast.monthly.confidence === 'high' ? 'burn rate est.' : `confidence: ${forecast.monthly.confidence}`}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  forecast.monthly.pctUsed >= 90 ? 'bg-status-error' :
                  forecast.monthly.pctUsed >= 70 ? 'bg-status-warning' :
                  'bg-primary'
                }`}
                style={{ width: `${Math.min(100, forecast.monthly.pctUsed)}%` }}
              />
            </div>
          </div>
        )}

        {/* Provider walls (only shown while exhausted — for reset-time visibility).
            Codex comes from its own pause log; the Dispatch-tenant row is a
            Claude pool and is labelled as one. */}
        {forecast.codex?.isExhausted && (
          <ProviderWallRow
            label={forecast.codex.reason === 'auth' ? 'Codex credential' : 'Codex budget'}
            state={forecast.codex.reason === 'auth' ? 'rejected' : 'exhausted'}
            resetsAt={forecast.codex.resetsAt}
            now={now}
          />
        )}
        {forecast.claudeTenant?.isExhausted && (
          <ProviderWallRow
            label="Claude tenant budget"
            state="exhausted"
            resetsAt={forecast.claudeTenant.resetsAt}
            now={now}
          />
        )}

        {/* Mission budgets — top 3 nearest to exhaustion */}
        {forecast.missions.slice(0, 3).map((m) => (
          <div key={m.missionId} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 gap-y-1">
              <span className="text-sm text-text-secondary truncate max-w-[10rem]">{m.missionTitle}</span>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <span className={`font-medium tabular-nums ${
                  m.pctUsed >= 90 ? 'text-status-error' :
                  m.pctUsed >= 70 ? 'text-status-warning' :
                  'text-text-primary'
                }`} title={ESTIMATED_COST_TITLE}>
                  {formatEstimatedUsd(m.spentUsd)} / ${m.budgetUsd.toFixed(2)}
                </span>
                <span className="text-text-muted">·</span>
                <span>{m.pctUsed}%</span>
                {m.status === 'budget_exhausted' && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span className="text-status-error">exhausted</span>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Credential health (STATE) ────────────────────────────────────────────────

const CREDENTIAL_PURPOSE_LABELS: Record<string, string> = {
  oauth_token: 'Claude OAuth token',
  anthropic_api_key: 'Anthropic API key',
  codex_credential: 'Codex credential',
};

const CREDENTIAL_STATUS_WORD: Record<CredentialHealthItem['healthStatus'], string> = {
  healthy: 'working',
  degraded: 'failing',
  revoked: 'revoked',
  unknown: 'not checked',
};

const CREDENTIAL_TONE: Record<CredentialHealthItem['healthStatus'], string> = {
  healthy: 'text-status-success',
  degraded: 'text-status-warning',
  revoked: 'text-status-error',
  unknown: 'text-text-muted',
};

/**
 * Backend credentials as a STATE, with each row's own freshness.
 *
 * Freshness comes from the credential's last verification, not from page-render
 * time: a credential last checked three days ago is "healthy as of 3d ago", and
 * one never checked reads `never observed` rather than borrowing the clock.
 *
 * The broken rows also appear under Problems — there as something to fix, here
 * as something to read. The LIFETIME streak sits beside the status rather than
 * merged into it, because a streak is not a state.
 */
function CredentialStateSection({
  credentials,
  now,
}: {
  credentials: CredentialHealthItem[];
  now: number;
}) {
  return (
    <div data-testid="health-section-credentials" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Credentials</h3>
        <span className="text-[11px] text-text-muted">
          {countOf(credentials.length, 'credential')}
        </span>
      </div>
      <div className="card divide-y divide-border-default">
        {credentials.map((c) => (
          <div key={c.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
            <span className="text-sm text-text-primary truncate">
              {CREDENTIAL_PURPOSE_LABELS[c.purpose] ?? c.purpose}
            </span>
            <div className="flex items-center gap-2 text-xs shrink-0">
              <span className={`font-medium ${CREDENTIAL_TONE[c.healthStatus] ?? 'text-text-muted'}`}>
                {CREDENTIAL_STATUS_WORD[c.healthStatus] ?? c.healthStatus}
              </span>
              {c.consecutiveAuthFailures > 0 && (
                <>
                  <span className="text-text-muted">·</span>
                  <span
                    className="text-status-warning"
                    title="Consecutive auth failures: a lifetime streak that resets on the next success. The page window doesn't apply."
                  >
                    {failureStreak(c.consecutiveAuthFailures)}
                  </span>
                </>
              )}
              <span className="text-text-muted">·</span>
              <span
                className="text-text-muted"
                title="Measured from this credential's own last verification, not from when the page rendered."
              >
                {freshness(c.lastVerifiedAt ?? c.lastSuccessAt, now)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Task outcomes (TREND) ────────────────────────────────────────────────────

/**
 * What Usage(30d) uniquely carried, and nothing it duplicated.
 *
 * The per-role done/failed rollup is gone: `/app/team` already renders an
 * identical one, so this links there instead of publishing a second copy that
 * can silently diverge. The two lines that survive are the two `/app/team`
 * cannot serve — it filters `roleSlug IS NOT NULL`, so role-less tasks are
 * invisible there, and it is team-wide, so it cannot honour `?workspace=`.
 *
 * Both are worded TASK-keyed on purpose. The failure rate immediately above is
 * worker-keyed over a different population, and the page does not claim one
 * page-wide failure statement — each section names what it counted.
 */
function TaskOutcomesSection({ stats, window }: { stats: UsageStats; window: FailureWindow }) {
  return (
    <div data-testid="health-section-task-outcomes" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Task outcomes</h3>
        <span className="text-[11px] text-text-muted">
          {sectionDenominator(stats.total, stats.total === 1 ? 'task' : 'tasks')} ({window})
        </span>
      </div>
      <div className="card px-4 py-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-text-secondary">
            {stats.completed}/{stats.total} tasks completed ({window})
          </span>
          {stats.failed > 0 && (
            <span className="text-xs text-status-error tabular-nums">{stats.failed} failed</span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-sm text-text-secondary"
            title="Tasks that ran with no role assigned. A routing-health signal. /app/team can't show it because its query filters roleSlug IS NOT NULL."
          >
            {stats.unassigned} task{stats.unassigned === 1 ? '' : 's'} ran with no role ({window})
          </span>
        </div>
        <a
          href="/app/team"
          data-testid="per-role-link"
          className="inline-flex items-center min-h-11 md:min-h-0 text-xs text-accent-text hover:underline"
        >
          per role →
        </a>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure analytics
//
// Aggregated worker failures. The headline pair (failure rate, died-early count)
// is a stat tile — a bare number is the right form for a single headline value.
// The exit-cause and signature bars encode magnitude only, so they use one hue
// at a fixed step (never a categorical ramp); identity lives in the row label
// and every bar is directly labelled with its count.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_OPTIONS: { value: FailureWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const EXIT_CAUSE_LABELS: Record<string, string> = {
  code_failure: 'code failure',
  budget_limited: 'budget limited',
  infra_failure: 'infra failure',
  reassigned: 'reassigned',
  condition_unmet: 'condition unmet',
  sandbox_mount_gap: 'sandbox mount gap',
  unclassified: 'unclassified',
};

/** Failure rate is a state, so it wears status ink — with the number as the label. */
function failureRateClass(pct: number): string {
  if (pct >= 25) return 'text-status-error';
  if (pct >= 10) return 'text-status-warning';
  return 'text-text-primary';
}

function exitCauseLabel(cause: string): string {
  return EXIT_CAUSE_LABELS[cause] ?? cause;
}

/**
 * The page's ONE window control, in URL state (`?window=`) so the view is
 * shareable. It used to be a per-section control on Worker failures while three
 * other sections were hardcoded to windows of their own.
 *
 * Always writes `window` and always clears `failureWindow`: the deprecated alias
 * is read on entry for old links (`page.tsx`), but a leftover copy of it must not
 * be able to outlive a selection made here.
 */
function WindowPicker({ window: current }: { window: FailureWindow }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const select = (value: FailureWindow) => {
    if (value === current) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('window', value);
    params.delete('failureWindow');
    const qs = params.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false }));
  };

  return (
    <div
      role="group"
      aria-label="Window"
      data-testid="health-window-picker"
      className={`flex border-2 border-border-strong bg-surface-2 ${pending ? 'opacity-60' : ''}`}
    >
      {WINDOW_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => select(o.value)}
          aria-pressed={current === o.value}
          className={`min-h-11 min-w-11 md:min-h-0 md:min-w-0 px-2 py-0.5 font-mono text-[11px] md:text-[10px] uppercase tracking-widest transition-colors ${
            current === o.value
              ? 'bg-surface-3 text-text-primary'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The gate ledger, as a compact trend block.
 *
 * Sits next to Worker failures on purpose: the two answer the same question
 * ("what is the platform doing badly?") over populations that do not overlap at
 * all. A worker that fails is in the section above. A caller the platform
 * REFUSED never became a worker, so it appears here and nowhere else — which is
 * how a creation-time lint could misfire for three weeks with every dashboard
 * reporting healthy.
 *
 * Bypass % leads each row because it is the number that needs no interpretation:
 * a gate being overridden most of the time is wrong about something.
 */
function GatesSection({ gates, window: activeWindow }: { gates: GateAnalytics; window: FailureWindow }) {
  const { totals } = gates;

  return (
    <div data-testid="health-section-gates" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Gates</h3>
        <span data-testid="gate-denominator" className="text-[11px] text-text-muted">
          {sectionDenominator(totals.events, 'gate decisions')} ({activeWindow})
        </span>
      </div>

      {totals.events === 0 ? (
        <div className="card px-4 py-3">
          <p className="text-sm text-text-muted">
            Nothing was refused, deferred, warned or bypassed in this window.
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-border-default">
          <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="gate-headline">
            {([
              ['Rejected', totals.rejected, 'Requests buildd refused with a 4xx the caller had to act on.'],
              ['Deferred', totals.deferred, 'Accepted and held: a wait, a queue, or a single-flight. These are expected.'],
              ['Bypassed', totals.bypassed, 'A gate fired and the caller carried an explicit escape hatch. Over a lint, this IS its false-positive rate.'],
              ['Warned', totals.warned, 'Advisory. The response carried a warning and the work went ahead.'],
              ['Stranded', totals.stranded, 'A task deferred long enough for the sweep to flag it. Nothing re-arms it, so check it.'],
            ] as const).map(([label, value, title]) => (
              <div key={label}>
                <span
                  className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted"
                  title={title}
                >
                  {label}
                </span>
                <p
                  className={`text-xl font-bold tabular-nums leading-tight ${label === 'Stranded' && value > 0 ? 'text-status-error' : ''}`}
                >
                  {value}
                </p>
              </div>
            ))}
          </div>

          <div className="px-4 py-3">
            <p className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted mb-2">
              By gate
            </p>
            <ul className="space-y-1.5">
              {gates.gates.slice(0, 6).map(g => (
                <li key={g.gate} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-mono text-xs text-text-secondary truncate" title={g.surfaces.join(', ')}>
                    {g.gate}
                  </span>
                  <span className="text-[11px] text-text-muted whitespace-nowrap tabular-nums">
                    {g.count}× · bypass {g.bypassRatePct}%
                  </span>
                </li>
              ))}
            </ul>
            {gates.truncatedGates > 0 && (
              <p className="text-[11px] text-text-muted mt-2">
                … {gates.truncatedGates} more gate(s)
              </p>
            )}
          </div>

          <ClaimDeferralsSubsection gates={gates} />
        </div>
      )}
    </div>
  );
}

/**
 * The claim loop's per-reason deferral breakdown, read off the same
 * `claim_loop_deferral` gate row's `topReasons` — no separate query. Absent
 * entirely when the claim loop hasn't fired the gate yet (a clean workspace,
 * or before this shipped).
 */
function ClaimDeferralsSubsection({ gates }: { gates: GateAnalytics }) {
  const claimGate = gates.gates.find(g => g.gate === 'claim_loop_deferral');
  if (!claimGate || claimGate.topReasons.length === 0) return null;

  return (
    <div className="px-4 py-3" data-testid="gate-claim-deferrals">
      <p className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted mb-2">
        Claim-loop deferrals by reason
      </p>
      <ul className="space-y-1.5">
        {claimGate.topReasons.map(r => (
          <li key={r.reason} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-mono text-xs text-text-secondary truncate">{r.reason}</span>
            <span className="text-[11px] text-text-muted whitespace-nowrap tabular-nums">
              {r.outcomes.deferred > 0 ? `${r.outcomes.deferred} deferred` : ''}
              {r.outcomes.stranded > 0 ? `${r.outcomes.deferred > 0 ? ' · ' : ''}${r.outcomes.stranded} stranded` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FailureAnalyticsSection({
  analytics,
  window: activeWindow,
  now,
}: {
  analytics: FailureAnalytics;
  window: FailureWindow;
  now: number;
}) {
  const [expandedSignature, setExpandedSignature] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const { totals, byExitCause, signatures, byRole, byWorkspace, repeatFailureTasks } = analytics;
  const topSignatureCount = signatures[0]?.count ?? 0;
  const topCauseCount = byExitCause[0]?.count ?? 0;

  return (
    <div data-testid="health-section-failure-analytics" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Worker failures</h3>
        {/* This section's own population — terminal worker sessions — stated
            here rather than page-wide, because the sections below count tasks. */}
        <span data-testid="failure-denominator" className="text-[11px] text-text-muted">
          {sectionDenominator(totals.terminal, 'terminal worker sessions')} ({activeWindow})
        </span>
      </div>

      {totals.started === 0 ? (
        <div className="card px-4 py-3">
          <p className="text-sm text-text-muted">No workers ran in this window.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border-default">
          {/* Headline stat tiles */}
          <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="failure-headline">
            <div>
              <span
                className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted"
                title="Failed / finished workers in the window. In-flight workers are excluded."
              >
                Failure rate
              </span>
              <p
                data-testid="failure-rate"
                className={`text-xl font-bold tabular-nums leading-tight ${failureRateClass(totals.failureRatePct)}`}
              >
                {totals.failureRatePct}%
              </p>
              <p className="text-xs text-text-muted tabular-nums">
                {totals.failed} of {totals.terminal} terminal
              </p>
            </div>
            <div>
              <span
                className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted"
                title="Failures that used 2 turns or fewer at $0 cost. They took a slot and produced nothing. A high count points at a platform bug."
              >
                Died early
              </span>
              <p
                data-testid="failure-died-early"
                className={`text-xl font-bold tabular-nums leading-tight ${
                  totals.diedEarly > 0 ? 'text-status-error' : 'text-text-primary'
                }`}
              >
                {totals.diedEarly}
              </p>
              <p className="text-xs text-text-muted tabular-nums">
                {totals.diedEarlySharePct}% of failures · ≤2 turns, $0
              </p>
            </div>
            {/* Two classes, so two tiles. `completed` is a TREND (it counts a
                window); `still running` is a STATE (it is true right now and a
                window cannot make it more true). One tile could only lie about
                one of them. */}
            <div>
              <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted">
                Completed
              </span>
              <p className="text-xl font-bold tabular-nums leading-tight text-text-primary">
                {totals.completed}
              </p>
              <p className="text-xs text-text-muted tabular-nums">
                of {totals.terminal} terminal ({activeWindow})
              </p>
            </div>
            <div>
              <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted">
                Still running
              </span>
              <p
                data-testid="failure-still-running"
                className="text-xl font-bold tabular-nums leading-tight text-text-primary"
              >
                {totals.stillRunning}
              </p>
              <p className="text-xs text-text-muted tabular-nums">as of now</p>
            </div>
          </div>

          {/* Exit-cause breakdown — magnitude only, one hue, direct-labelled */}
          {byExitCause.length > 0 && (
            <div className="px-4 py-3 space-y-2" data-testid="failure-exit-causes">
              <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted">
                By exit cause
              </span>
              {byExitCause.map((c) => (
                <div key={c.exitCause}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-primary truncate">{exitCauseLabel(c.exitCause)}</span>
                    <span className="text-xs text-text-secondary tabular-nums shrink-0">
                      {c.count} · {c.sharePct}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 bg-surface-3 overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${topCauseCount > 0 ? Math.round((c.count / topCauseCount) * 100) : 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Ranked failure signatures — most frequent first */}
          {signatures.length > 0 && (
            <div className="py-1" data-testid="failure-signatures">
              <div className="px-4 pt-2 pb-1">
                <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted">
                  Failure signatures
                </span>
              </div>
              <div className="divide-y divide-border-default">
                {signatures.map((s) => {
                  const open = expandedSignature === s.signature;
                  return (
                    <div key={s.signature} className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandedSignature(open ? null : s.signature)}
                        aria-expanded={open}
                        className="w-full text-left flex items-start gap-3"
                      >
                        <span className="text-xs font-mono font-bold tabular-nums text-text-primary shrink-0 w-8 text-right">
                          {s.count}×
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs font-mono text-text-primary truncate" title={s.signature}>
                            {s.signature}
                          </span>
                          <span className="block text-xs text-text-muted mt-0.5">
                            last {timeAgo(s.lastSeen, now)} · first {timeAgo(s.firstSeen, now)}
                            {s.diedEarlyCount > 0 && (
                              <span className="text-status-error"> · {s.diedEarlyCount} died early</span>
                            )}
                          </span>
                        </span>
                        <svg
                          className={`w-3 h-3 shrink-0 mt-0.5 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"
                        >
                          <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>

                      {/* Magnitude bar, relative to the most frequent signature */}
                      <div className="mt-1.5 h-1 bg-surface-3 overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${topSignatureCount > 0 ? Math.round((s.count / topSignatureCount) * 100) : 0}%` }}
                        />
                      </div>

                      {open && (
                        <div className="mt-2 space-y-1.5">
                          {s.exampleError && (
                            <p className="text-xs font-mono text-status-error whitespace-pre-wrap break-words">
                              {s.exampleError}
                            </p>
                          )}
                          <p className="text-xs text-text-muted">
                            exit cause: {s.exitCauses.map(exitCauseLabel).join(', ')}
                          </p>
                          <div className="flex items-center gap-3">
                            {s.exampleTaskId && (
                              <a
                                href={`/app/tasks/${s.exampleTaskId}`}
                                className="text-xs text-accent hover:underline"
                              >
                                example task →
                              </a>
                            )}
                            {s.exampleWorkerIds.length > 0 && (
                              <span className="text-xs text-text-muted font-mono truncate">
                                worker {s.exampleWorkerIds[0].slice(0, 8)}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Progressive disclosure: per-role / per-workspace / repeat offenders */}
          {(byRole.length > 0 || byWorkspace.length > 1 || repeatFailureTasks.length > 0) && (
            <div className="px-4 py-2.5">
              <button
                type="button"
                onClick={() => setShowDetail((p) => !p)}
                aria-expanded={showDetail}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                {showDetail ? 'Hide breakdown' : 'Breakdown by role, workspace, repeat tasks'}
              </button>

              {showDetail && (
                <div className="mt-3 space-y-4" data-testid="failure-breakdown">
                  {byRole.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted">
                        By role
                      </span>
                      {byRole.slice(0, 6).map((r) => (
                        <div key={r.roleSlug} className="flex items-center justify-between gap-2">
                          <span className="text-xs text-text-primary truncate">{r.roleSlug}</span>
                          <span className="text-xs tabular-nums shrink-0">
                            <span className={failureRateClass(r.failureRatePct)}>{r.failureRatePct}%</span>
                            <span className="text-text-muted"> · {r.failed}/{r.terminal}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {byWorkspace.length > 1 && (
                    <div className="space-y-1">
                      <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted">
                        By workspace
                      </span>
                      {byWorkspace.slice(0, 6).map((w) => (
                        <div key={w.workspaceId} className="flex items-center justify-between gap-2">
                          <span className="text-xs text-text-primary truncate">{w.workspaceName}</span>
                          <span className="text-xs tabular-nums shrink-0">
                            <span className={failureRateClass(w.failureRatePct)}>{w.failureRatePct}%</span>
                            <span className="text-text-muted"> · {w.failed}/{w.terminal}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {repeatFailureTasks.length > 0 && (
                    <div className="space-y-1">
                      <span
                        className="text-[11px] md:text-[10px] font-mono uppercase tracking-widest text-text-muted"
                        title="Tasks that burned more than one worker inside the window"
                      >
                        Repeat-failure tasks
                      </span>
                      {repeatFailureTasks.slice(0, 6).map((t) => (
                        <div key={t.taskId} className="flex items-center justify-between gap-2">
                          <a
                            href={`/app/tasks/${t.taskId}`}
                            className="text-xs text-text-primary hover:text-primary truncate"
                          >
                            {t.taskTitle ?? t.taskId.slice(0, 8)}
                          </a>
                          <span className="text-xs text-status-error tabular-nums shrink-0">
                            {t.failedWorkers}× failed
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
