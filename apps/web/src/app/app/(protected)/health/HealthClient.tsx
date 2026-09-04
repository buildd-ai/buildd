'use client';

import { useEffect, useMemo, useState, useTransition, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { deriveSandboxPosture, isRunnerOnline } from '@/lib/runner-heartbeats-shared';
import { findDuplicateScheduleIds } from '@/lib/schedule-health';
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
  CbmHealthSummary,
  OrphanedPrRow,
} from './page';
import { getModelDisplayName } from '@buildd/core/model-display';
import { Stat } from '@/components/StatTile';
import { byModelAbsence, divergenceSummary, scanCaveat } from '@/lib/model-presentation';
import { shortToolName, usageDrilldownHref } from '@/lib/usage-drilldown';
import {
  coverageLabel,
  depletionProjection,
  failureStreak,
  freshness,
  groupFailuresBySignature,
  lifetimeRuns,
  monthlyAnchor,
  RUNNER_LIFETIME_LABEL,
  sectionDenominator,
} from '@/lib/health-metric-grammar';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';

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

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'due';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
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

interface Props {
  /** Worker rows whose PR the reconcile sweep gave up on — see OrphanedPrRow. */
  orphanedPrs: OrphanedPrRow[];
  runners: RunnerHeartbeat[];
  usageStats: UsageStats | null;
  consumption: ConsumptionStats | null;
  schedules: ScheduleRow[];
  recentFailures: RecentFailure[];
  credentialHealth: CredentialHealthItem[];
  strandedBackends: StrandedBackendRow[];
  teamWorkspaces: { id: string; name: string }[];
  wsFilter: string | null;
  budgetForecast: BudgetForecast | null;
  failureAnalytics: FailureAnalytics | null;
  /** The one page window (`?window=`) every TREND section reads. */
  window: FailureWindow;
  cbm: CbmHealthSummary | null;
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
  teamWorkspaces,
  wsFilter,
  budgetForecast,
  failureAnalytics,
  window: activeWindow,
  cbm,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [runnerHealth, setRunnerHealth] = useState<Map<string, RunnerHealthState>>(new Map());
  const [showSchedules, setShowSchedules] = useState(false);
  const [showPausedSchedules, setShowPausedSchedules] = useState(false);
  const [showHeartbeatSchedules, setShowHeartbeatSchedules] = useState(false);
  const [expandedCronId, setExpandedCronId] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleBusyId, setScheduleBusyId] = useState<string | null>(null);
  const [scheduleToDelete, setScheduleToDelete] = useState<ScheduleRow | null>(null);

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
      const online = isRunnerOnline(hb.lastHeartbeatAt);
      const idlePushOnly = online && hb.activeWorkerCount === 0;
      const beat = timeAgo(hb.lastHeartbeatAt);
      setRunnerHealth(prev => {
        const next = new Map(prev);
        next.set(heartbeatId, {
          loading: false,
          expanded: true,
          pushOnlyResult: {
            online,
            message: online
              ? idlePushOnly ? `last beat ${beat} — healthy (idle)` : `last beat ${beat} — healthy`
              : `last beat ${beat} — stale`,
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

      const errMsg = !doctor && !historyStats ? 'Runner unreachable — check that it is running and accessible.' : undefined;

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

  const refresh = () => startTransition(() => router.refresh());

  const duplicateScheduleIds = useMemo(() => findDuplicateScheduleIds(schedules), [schedules]);

  const [overdueHeartbeatCount, setOverdueHeartbeatCount] = useState(0);
  useEffect(() => {
    const now = Date.now();
    setOverdueHeartbeatCount(
      schedules.filter(s => s.isHeartbeat && s.enabled && s.nextRunAt != null && new Date(s.nextRunAt).getTime() < now).length,
    );
  }, [schedules]);

  const toggleSchedule = async (s: ScheduleRow) => {
    setScheduleBusyId(s.id);
    setScheduleError(null);
    try {
      const res = await fetch(`/api/workspaces/${s.workspaceId}/schedules/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed');
      refresh();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setScheduleBusyId(null);
    }
  };

  const confirmDeleteSchedule = async () => {
    if (!scheduleToDelete) return;
    setScheduleBusyId(scheduleToDelete.id);
    setScheduleError(null);
    try {
      const res = await fetch(`/api/workspaces/${scheduleToDelete.workspaceId}/schedules/${scheduleToDelete.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      setScheduleToDelete(null);
      refresh();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setScheduleBusyId(null);
    }
  };

  // One clock read for every freshness string on the page. Freshness is measured
  // from each stat's OWN last-observed timestamp — this is only the instant we
  // measure against, never a substitute for a missing timestamp.
  const now = Date.now();

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
  const offlineRunners = runners.filter(r => !isRunnerOnline(r.lastHeartbeatAt));
  // Every online runner whose sandbox posture is not actually enforced — bwrap
  // denied, or bwrap available with the mount allowlist off. Both are degraded;
  // neither may render as green.
  const degradedSandboxRunners = runners.filter(
    r => isRunnerOnline(r.lastHeartbeatAt) && deriveSandboxPosture(r).tier === 'warning',
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
    return 'Seat-based (OAuth) auth reports no per-model usage and no cost, so some numbers below '
      + 'are absent rather than zero. Each one still carries its own reason where it sits.';
  }, [consumption]);

  const failedSchedules = schedules.filter(s => s.enabled && !!s.lastError);
  const hasProblems =
    brokenCredentials.length > 0 ||
    strandedBackends.length > 0 ||
    offlineRunners.length > 0 ||
    degradedSandboxRunners.length > 0 ||
    failedSchedules.length > 0 ||
    recentFailures.length > 0;

  // Partition schedules: heartbeat (mission internals) vs regular
  const heartbeatSchedules = schedules.filter(s => s.isHeartbeat);
  const regularSchedules = schedules.filter(s => !s.isHeartbeat);
  const activeRegular = regularSchedules.filter(s => s.enabled);
  const pausedRegular = regularSchedules.filter(s => !s.enabled);

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      {/* Header — one window control for the whole page, not one per section. */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="hidden md:block text-2xl font-bold">Health</h1>
          <div className="flex items-center gap-2 ml-auto">
            <WindowPicker window={activeWindow} />
            <span className="hidden md:block">
              <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter} />
            </span>
          </div>
        </div>
      </div>

      {/* 1. Problems now */}
      <section data-testid="health-section-problems" className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="section-label">Problems</h2>
          {failureGroups.total > 0 && (
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
          <div className="card divide-y divide-border-default">
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
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          isRevoked
                            ? 'bg-status-error/10 text-status-error'
                            : 'bg-status-warning/10 text-status-warning'
                        }`}>
                          {isRevoked ? 'revoked' : 'degraded'}
                        </span>
                        {cred.consecutiveAuthFailures > 0 && (
                          <span
                            className="text-[10px] text-text-muted"
                            title="Consecutive auth failures — a lifetime streak, reset by the next success. It does not obey the page window."
                          >
                            auth failures {failureStreak(cred.consecutiveAuthFailures)}
                          </span>
                        )}
                      </div>
                      {cred.lastFailureAt && (
                        <p className="text-xs text-text-muted mt-0.5">
                          Last failure: {timeAgo(cred.lastFailureAt)}
                          {cred.lastFailureMessage && (
                            <span className={`ml-1 ${isRevoked ? 'text-status-error' : 'text-status-warning'}`}>
                              — {cred.lastFailureMessage.slice(0, 100)}
                            </span>
                          )}
                        </p>
                      )}
                      {cred.lastVerifiedAt && (
                        <p className="text-xs text-text-muted mt-0.5">
                          Last verified: {timeAgo(cred.lastVerifiedAt)}
                        </p>
                      )}
                    </div>
                    <a
                      href="/app/settings?section=agent-backends"
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
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-status-error/10 text-status-error">
                        {b.strandedPending} task{b.strandedPending === 1 ? '' : 's'} unclaimable
                      </span>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      Pending work is routed to {b.label}, so no runner can claim it
                      {b.enabledForTeam ? ' — connect it, or disable it team-wide to reroute' : ''}.
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
                    href="/app/settings?section=agent-backends"
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
                  <p className="text-xs text-text-muted">last beat {timeAgo(hb.lastHeartbeatAt)}</p>
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
            {failureGroups.groups.map((g) => {
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
                        last {timeAgo(g.lastSeen)} · {sample.workspaceName}
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
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/10 text-status-error font-medium shrink-0">
                      last 24h
                    </span>
                  </div>
                </div>
              );
            })}

            {failureGroups.hiddenFailures > 0 && (
              <div className="px-4 py-2.5">
                <span className="text-xs text-text-muted">
                  +{failureGroups.hiddenFailures} more failure
                  {failureGroups.hiddenFailures === 1 ? '' : 's'} in{' '}
                  {failureGroups.hiddenGroups} other group
                  {failureGroups.hiddenGroups === 1 ? '' : 's'} — see Worker failures below
                </span>
              </div>
            )}
          </div>
        )}

        <OrphanedPrsBlock rows={orphanedPrs} />
      </section>

      {/* 2. State — what is true right now. Every number here renders its own
          freshness (`as of {N}h ago`) from the stat's own timestamp, and never
          the page window: a window does not make a state more true. */}
      <section data-testid="health-section-state" className="mb-6">
        <h2 className="section-label mb-3">State</h2>

      <div data-testid="health-section-runners" className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h3 className="text-xs font-medium text-text-secondary">Capacity</h3>
          {runners.length > 0 && (
            <span className="text-[11px] text-text-muted">
              {sectionDenominator(runners.length, runners.length === 1 ? 'runner' : 'runners')}
            </span>
          )}
        </div>
        <div className="card">
          {runners.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-sm text-text-muted">No runners connected</p>
              <p className="text-xs text-text-muted mt-1">Runners appear here when they send heartbeats.</p>
            </div>
          ) : (
            <div className="divide-y divide-border-default">
              {runners.map((hb) => {
                const online = isRunnerOnline(hb.lastHeartbeatAt);
                const idle = online && hb.activeWorkerCount === 0;
                const health = runnerHealth.get(hb.id);
                const statusLabel = online ? (idle ? 'idle' : 'online') : 'stale';
                const statusClass = online
                  ? idle ? 'text-text-muted' : 'text-status-success'
                  : 'text-text-muted';
                // Green means ENFORCED (namespace + mount allowlist), never merely
                // "bwrap is installed here" — see deriveSandboxPosture.
                const posture = deriveSandboxPosture(hb);
                const sandboxLabel = posture.label;
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
                          <span className={`text-[10px] font-mono ${statusClass}`}>
                            {statusLabel}
                          </span>
                          <span
                            className={`text-[10px] font-mono ${sandboxClass}`}
                            title={`${posture.detail}${hb.sandboxProbeAt ? ` · probed ${timeAgo(hb.sandboxProbeAt)}` : ' · not yet probed'}`}
                          >
                            {sandboxLabel}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted">
                          {hb.activeWorkerCount}/{hb.maxConcurrentWorkers} workers ·{' '}
                          {freshness(hb.lastHeartbeatAt, now)}
                        </p>
                      </div>
                      <button
                        onClick={() => checkRunnerHealth(hb.id)}
                        disabled={health?.loading}
                        className="text-[11px] px-2.5 h-7 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:border-border-strong disabled:opacity-50 transition-colors shrink-0"
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

      {budgetForecast && <BudgetForecastSection forecast={budgetForecast} />}

      {credentialHealth.length > 0 && (
        <CredentialStateSection credentials={credentialHealth} now={now} />
      )}

      {/* Schedules — collapsed by default. Lives under State because what it
          carries is a STATE (enabled, next run) plus two LIFETIME counters
          (total runs, consecutive failures), none of which obey the window. */}
      {schedules.length > 0 && (
        <div data-testid="health-section-schedules" className="mb-6">
          <button
            onClick={() => setShowSchedules(p => !p)}
            className="flex items-center gap-2 section-label mb-3 hover:text-text-primary transition-colors w-full text-left"
          >
            <svg
              className={`w-3 h-3 transition-transform shrink-0 ${showSchedules ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Schedules
            <span className="font-normal text-text-muted ml-1">
              ({activeRegular.length} active{pausedRegular.length > 0 ? `, ${pausedRegular.length} paused` : ''}{heartbeatSchedules.length > 0 ? `, ${heartbeatSchedules.length} heartbeat` : ''})
            </span>
          </button>

          {showSchedules && (
            <>
              {duplicateScheduleIds.size > 0 && (
                <div className="mb-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm">
                  <div className="font-medium text-status-warning">Duplicate crons detected</div>
                  <p className="text-text-secondary mt-1">
                    {duplicateScheduleIds.size} enabled schedules share the same cron and timezone within one
                    workspace — they fire simultaneously. Pause the stale copy below.
                  </p>
                </div>
              )}

              {overdueHeartbeatCount > 0 && (
                <div className="mb-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm">
                  <div className="font-medium text-status-warning">
                    {overdueHeartbeatCount} overdue heartbeat{overdueHeartbeatCount > 1 ? 's' : ''}
                  </div>
                  <p className="text-text-secondary mt-1">
                    {overdueHeartbeatCount === 1
                      ? 'A heartbeat schedule missed its last run — the cron may have stalled or the run errored before advancing nextRunAt. Check the schedule below.'
                      : `${overdueHeartbeatCount} heartbeat schedules missed their last run — the cron may have stalled. Check schedules below.`}
                  </p>
                </div>
              )}

              {scheduleError && (
                <div className="mb-3 text-sm text-status-error">{scheduleError}</div>
              )}

              {(() => {
                const renderRow = (s: ScheduleRow) => {
                  const isDupe = duplicateScheduleIds.has(s.id);
                  const humanLabel = humanizeCron(s.cronExpression);
                  const isRawDifferent = humanLabel !== s.cronExpression;
                  const cronExpanded = expandedCronId === s.id;
                  return (
                    <div key={s.id} className={`px-4 py-3 ${isDupe ? 'bg-status-warning/5' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-text-primary truncate">{s.name}</p>
                            {isDupe && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning font-medium">
                                duplicate cron
                              </span>
                            )}
                            {s.missionTitle && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-info/10 text-status-info truncate max-w-[10rem]">
                                {s.missionTitle}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-muted mt-0.5">
                            {isRawDifferent ? (
                              <button
                                onClick={() => setExpandedCronId(cronExpanded ? null : s.id)}
                                className="text-left hover:text-text-secondary transition-colors"
                                title={cronExpanded ? 'Hide raw cron' : 'Show raw cron'}
                              >
                                <span>{humanLabel}</span>
                                {cronExpanded && (
                                  <span className="font-mono ml-1.5 text-text-tertiary">({s.cronExpression})</span>
                                )}
                              </button>
                            ) : (
                              <span className="font-mono">{s.cronExpression}</span>
                            )}
                            <span className="mx-1">·</span>
                            <span>{s.timezone}</span>
                            <span className="mx-1">·</span>
                            <span>{s.workspaceName}</span>
                          </div>
                          {/* `{N} runs since created` / `{N} in a row` — both
                              LIFETIME. Rendered with their own anchor so neither
                              reads as a count over the page window. */}
                          <p className="text-xs text-text-tertiary mt-0.5">
                            {s.enabled ? `next ${timeUntil(s.nextRunAt)}` : 'paused'} · last {timeAgo(s.lastRunAt)}
                            {' · '}
                            <span title={s.createdAt ? `Created ${timeAgo(s.createdAt)} — an all-time counter, not a windowed one` : undefined}>
                              {lifetimeRuns(s.totalRuns)}
                            </span>
                            {s.consecutiveFailures > 0 && (
                              <span className="text-status-error" title="Consecutive failed runs — a streak, reset by the next success">
                                {' · '}{failureStreak(s.consecutiveFailures)} failed
                              </span>
                            )}
                          </p>
                          {s.lastError && (
                            <p className="text-xs text-status-error mt-1 truncate">⚠ {s.lastError}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => toggleSchedule(s)}
                            disabled={scheduleBusyId === s.id}
                            className={`text-xs px-3 h-8 rounded-lg border font-medium disabled:opacity-50 ${
                              s.enabled ? 'text-text-secondary' : 'text-status-success border-status-success/40'
                            }`}
                          >
                            {scheduleBusyId === s.id ? '…' : s.enabled ? 'Pause' : 'Resume'}
                          </button>
                          <button
                            data-testid="schedule-delete-btn"
                            onClick={() => setScheduleToDelete(s)}
                            disabled={scheduleBusyId === s.id}
                            className="h-8 w-8 flex items-center justify-center rounded-lg text-text-muted hover:text-status-error hover:bg-status-error/10 disabled:opacity-50 transition-colors"
                            title="Delete schedule"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                };

                return (
                  <>
                    {activeRegular.length > 0 && (
                      <div className="card divide-y divide-border-default mb-2">
                        {activeRegular.map(renderRow)}
                      </div>
                    )}

                    {pausedRegular.length > 0 && (
                      <div className="mb-2">
                        <button
                          onClick={() => setShowPausedSchedules(p => !p)}
                          className="flex items-center gap-2 text-xs text-text-muted hover:text-text-secondary mb-2 transition-colors"
                        >
                          <svg
                            className={`w-3 h-3 transition-transform ${showPausedSchedules ? 'rotate-90' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          {pausedRegular.length} paused {pausedRegular.length === 1 ? 'schedule' : 'schedules'}
                        </button>
                        {showPausedSchedules && (
                          <div className="card divide-y divide-border-default opacity-75">
                            {pausedRegular.map(renderRow)}
                          </div>
                        )}
                      </div>
                    )}

                    {heartbeatSchedules.length > 0 && (
                      <div>
                        <button
                          onClick={() => setShowHeartbeatSchedules(p => !p)}
                          className="flex items-center gap-2 text-xs text-text-muted hover:text-text-secondary mb-2 transition-colors"
                        >
                          <svg
                            className={`w-3 h-3 transition-transform ${showHeartbeatSchedules ? 'rotate-90' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          {heartbeatSchedules.length} mission heartbeat{heartbeatSchedules.length !== 1 ? 's' : ''}
                        </button>
                        {showHeartbeatSchedules && (
                          <div className="card divide-y divide-border-default opacity-75">
                            {heartbeatSchedules.map(renderRow)}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}
        </div>
      )}
      </section>

      {/* 3. Trend — only meaningful aggregated over a period. Everything here
          obeys `?window=` and says so; nothing here renders freshness. */}
      <section data-testid="health-section-trend" className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="section-label">Trend</h2>
          <span className="text-[11px] text-text-muted">last {activeWindow}</span>
        </div>

        {/* ONE page-level statement of the shared root cause. The per-stat
            em-dashes and tooltips below stay exactly as they were — the collapse
            is of the explanation, not of the markers, which
            docs/design/derived-metric-availability.md requires at each stat. */}
        {seatAuthConfession && (
          <p data-testid="seat-auth-confession" className="text-[11px] text-text-muted mb-3">
            {seatAuthConfession}
          </p>
        )}

        {failureAnalytics && (
          <FailureAnalyticsSection analytics={failureAnalytics} window={activeWindow} />
        )}

        {usageStats && usageStats.total > 0 && (
          <TaskOutcomesSection stats={usageStats} window={activeWindow} />
        )}

        {consumption && consumption.totals.tasks > 0 && (
          <ConsumptionSection stats={consumption} workspaceId={wsFilter} />
        )}

        {cbm && <CodebaseGraphSection cbm={cbm} window={activeWindow} />}
      </section>

      {/* Delete schedule confirm modal */}
      {scheduleToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
          onClick={() => setScheduleToDelete(null)}
        >
          <div
            data-testid="schedule-delete-confirm"
            className="w-full sm:max-w-sm sm:rounded-xl rounded-t-2xl bg-surface-elevated p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold mb-1">Delete schedule?</h3>
            <p className="text-sm text-text-secondary mb-4">
              This is permanent and cannot be undone.
            </p>
            <div className="rounded-lg bg-surface-3 px-4 py-3 mb-5 space-y-1">
              <p className="text-sm font-medium text-text-primary truncate">{scheduleToDelete.name}</p>
              <p className="text-xs text-text-muted font-mono">{scheduleToDelete.cronExpression}</p>
              <p className="text-xs text-text-muted">
                {scheduleToDelete.totalRuns} runs · last {timeAgo(scheduleToDelete.lastRunAt)}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setScheduleToDelete(null)}
                className="flex-1 h-11 rounded-lg border border-border-default text-sm font-medium text-text-secondary"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteSchedule}
                disabled={scheduleBusyId === scheduleToDelete.id}
                className="flex-1 h-11 rounded-lg bg-status-error text-white text-sm font-medium disabled:opacity-50"
              >
                {scheduleBusyId === scheduleToDelete.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Consumption ───────────────────────────────────────────────────────────────

/** Compact token counts — per-task input runs into the millions. */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return '—';
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
function OrphanedPrsBlock({ rows }: { rows: OrphanedPrRow[] }) {
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
        buildd could not resolve these against GitHub and has stopped retrying. They are
        excluded from Home — nothing here is a merge you can make.
      </p>
      <div className="border border-border rounded-[10px] divide-y divide-border">
        {rows.map(row => (
          <div key={row.workerId} className="px-4 py-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-raised text-text-muted font-mono shrink-0">
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
              {row.failureCount === 1 ? '' : 's'} · last tried {timeAgo(row.lastCheckedAt)}
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
}: {
  stats: ConsumptionStats;
  /** Carried into the drill-down link so the scope survives the navigation. */
  workspaceId: string | null;
}) {
  const { totals, tools, groups, window, byModel, modelDivergence, scan } = stats;
  const topTools = tools.byTool.slice(0, 5);
  const maxToolCalls = topTools[0]?.calls ?? 0;
  const coverageGap = tools.coverage.tasks - tools.coverage.histogram;
  const topModels = byModel.slice(0, 6);
  const divergence = divergenceSummary(modelDivergence);
  // Qualifies every number in this section, not just the model rows: the page
  // reads worker rows directly and the read is capped.
  const caveat = scanCaveat(scan, timeAgo(scan.completeSince));

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
            title={`The scan reads the newest ${scan.limit} terminal workers, newest first. Rows older than the cap were not read, so every figure in this section — including the per-model rows — is a floor for the ${window} window, and a complete count only from ${scan.completeSince} onward.`}
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
          <span>What a task costs — tokens, turns, tool calls, cost</span>
          <span className="text-primary shrink-0">usage →</span>
        </a>

        {topTools.length > 0 && (
          <div className="space-y-2 pt-1 border-t border-border-default">
            <div className="flex items-center justify-between pt-3">
              <span className="text-xs text-text-secondary">Top tools</span>
              {coverageGap > 0 && (
                <span
                  data-testid="tool-coverage"
                  className="text-xs text-text-muted"
                  title="Exact per-tool counts exist only for workers that ran after the tool histogram shipped. Older tasks are reconstructed from a capped MCP call log, so their counts are a floor — which is what the ≥ marks. Orthogonal to the scan cap noted above, which truncates the population rather than the attribution."
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
            {topTools.map((t) => (
              <div key={t.name} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-primary flex-1 truncate" title={t.name}>
                    {shortToolName(t.name)}
                  </span>
                  <span className="text-xs text-text-muted tabular-nums">
                    {t.calls} · {Math.round(t.share * 100)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${maxToolCalls > 0 ? (t.calls / maxToolCalls) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <div data-testid="consumption-by-model" className="space-y-2 pt-3 border-t border-border-default">
          <span className="text-xs text-text-secondary">By model</span>

          {topModels.length > 0 ? (
            <>
              <div className="flex items-center gap-2 text-[9px] uppercase tracking-wide text-text-muted">
                <span className="flex-1">model</span>
                <span className="w-14 text-right">tokens</span>
                <span className="w-16 text-right">cost</span>
                <span className="w-10 text-right">share</span>
                <span
                  className="w-24 text-right"
                  title="Workers that reported this model. A worker whose fallback fired reports two models and counts in both rows, so this column can sum to more than the number of workers."
                >
                  workers reporting
                </span>
              </div>
              {topModels.map((m) => (
                <div key={m.model} className="flex items-center gap-2">
                  <span className="text-xs text-text-primary flex-1 truncate" title={m.model}>
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
                  <span className="w-24 text-right text-[11px] text-text-muted tabular-nums">
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
                className="text-[9px] uppercase tracking-wide text-text-muted"
                title="How often the model that ran disagreed with the model the router assigned (tasks.predicted_model). Aliases match any release in their family, so a team-less task assigned a bare family alias that ran a release of that same family counts as agreement, not divergence."
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

/** Copy for each CBM state — the label carries the diagnosis, not just a colour. */
const CBM_STATE: Record<
  CbmHealthSummary['state'],
  { label: string; tone: string; hint: string }
> = {
  healthy: {
    label: 'In use',
    tone: 'text-success',
    hint: 'Most CBM-enabled tasks queried the graph.',
  },
  partial: {
    label: 'Partly used',
    tone: 'text-warning',
    hint: 'A minority of CBM-enabled tasks queried the graph.',
  },
  unused: {
    label: 'Never queried',
    tone: 'text-error',
    hint: 'The graph was mounted and warm on every task and no agent called it. '
      + 'Indexing is being paid for and nothing is using it — this is a steering problem, not an availability one.',
  },
  unavailable: {
    label: 'Not mounted',
    tone: 'text-error',
    hint: 'No task had the graph mounted. Check the binary and the disable reasons below.',
  },
  no_data: {
    label: 'No data',
    tone: 'text-text-muted',
    hint: 'No completed task in this window recorded CBM metrics.',
  },
};

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/**
 * Codebase graph (CBM) health.
 *
 * Replaces reading CBM off the generic top-tools list, which could only ever show
 * which graph tools were called — and therefore looked identical whether the graph
 * was unused or absent. The question this answers first is adoption: mounted, warm,
 * and never queried is the failure mode that hid for weeks.
 */
function CodebaseGraphSection({ cbm, window }: { cbm: CbmHealthSummary; window: FailureWindow }) {
  const state = CBM_STATE[cbm.state];
  const deltaSuppressed = cbm.deltasSuppressedBecause;

  return (
    <div data-testid="health-section-cbm" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Codebase Graph</h3>
        {/* Sessions, not tasks: these rows are workers, with no dedup by task,
            so a retried task counts once per attempt. */}
        <span className="text-[11px] text-text-muted">
          {sectionDenominator(
            cbm.activeCount,
            cbm.activeCount === 1 ? 'CBM-enabled session' : 'CBM-enabled sessions',
          )} ({window})
        </span>
      </div>
      <div className="card p-4 space-y-4">

        {/* The alarm, not the adoption percentage. "Mounted, warm, and never
            queried" is the regression this panel exists to catch; the adoption
            RATIO itself lives on the usage drill-down, so the same number is not
            published twice under two different windows. */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <span className={`text-sm font-medium ${state.tone}`} data-testid="cbm-state">
              {state.label}
            </span>
            <p className="text-xs text-text-secondary max-w-prose">{state.hint}</p>
          </div>
          <span className="text-xs text-text-muted tabular-nums shrink-0" title="Graph tool calls in the window">
            {cbm.totalGraphCalls} call{cbm.totalGraphCalls !== 1 ? 's' : ''}
          </span>
        </div>

        {/* What agents did instead — the substitution the graph is meant to replace. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 pt-3 border-t border-border-default">
          <Stat
            label="Graph calls / session"
            value={cbm.avgGraphCallsOnActive === null ? '—' : cbm.avgGraphCallsOnActive.toFixed(1)}
            sub="on CBM sessions"
          />
          <Stat
            label="File reads / session"
            value={cbm.avgFileAccessOnActive === null ? '—' : Math.round(cbm.avgFileAccessOnActive).toString()}
            sub="Read + Grep + Glob"
          />
          <Stat
            label="Warm starts"
            value={pct(cbm.warmStartRate)}
            sub={`${cbm.warmStarts} served by seed`}
          />
          <Stat
            label="Index failures"
            value={cbm.indexAttempted === 0 ? '—' : pct(cbm.indexFailureRate)}
            sub={`${cbm.indexFailed}/${cbm.indexAttempted} builds`}
          />
        </div>

        {/* Why a task had no graph. Decisions and breakage read differently. */}
        {(cbm.binaryAbsent > 0 || cbm.mountUnavailable > 0 || Object.keys(cbm.byDesignSkips).length > 0 || cbm.topIndexFailReason) && (
          <div className="space-y-1 pt-3 border-t border-border-default">
            {cbm.binaryAbsent > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-error">Binary absent from the runner image</span>
                <span className="text-xs text-text-muted tabular-nums">{cbm.binaryAbsent} session(s)</span>
              </div>
            )}
            {cbm.mountUnavailable > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs text-error"
                  title="A mount CBM needs was missing, so CBM was dropped for the task rather than indexing into a tmpfs that is discarded at session end."
                >
                  Sandbox mount unavailable
                </span>
                <span className="text-xs text-text-muted tabular-nums">{cbm.mountUnavailable} session(s)</span>
              </div>
            )}
            {cbm.topIndexFailReason && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-warning truncate" title={cbm.topIndexFailReason.reason}>
                  Top index failure: {cbm.topIndexFailReason.reason}
                </span>
                <span className="text-xs text-text-muted tabular-nums shrink-0">
                  {cbm.topIndexFailReason.count}
                </span>
              </div>
            )}
            {Object.entries(cbm.byDesignSkips).map(([reason, count]) => (
              <div key={reason} className="flex items-center justify-between gap-2">
                <span
                  className="text-xs text-text-secondary"
                  title="A decision, not a failure — excluded from the fallback rate."
                >
                  Skipped by design: {reason.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-text-muted tabular-nums">{count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Payoff, or an honest refusal to claim one. */}
        <div className="pt-3 border-t border-border-default">
          {deltaSuppressed ? (
            <p className="text-xs text-text-muted">
              {deltaSuppressed === 'no_graph_tool_calls_observed'
                ? 'Token and file-access deltas withheld: no graph call was observed, so any cohort difference has no mechanism behind it.'
                : 'Token and file-access deltas withheld: cohorts are too small to compare yet.'}
            </p>
          ) : (
            <div className="flex items-center gap-4">
              <span className="text-xs text-text-secondary">
                Input tokens{' '}
                <span className="tabular-nums text-text-primary">{pct(cbm.inputTokenDeltaPct)}</span>
              </span>
              <span className="text-xs text-text-secondary">
                File access{' '}
                <span className="tabular-nums text-text-primary">{pct(cbm.fileAccessDeltaPct)}</span>
              </span>
              <span className="text-xs text-text-muted">vs comparable non-CBM tasks</span>
            </div>
          )}
        </div>

        {/* Per-tool counts last: useful once adoption is non-zero, meaningless before. */}
        {cbm.topTools.length > 0 && (
          <div className="space-y-1 pt-3 border-t border-border-default">
            <span className="text-xs text-text-secondary">Tools used</span>
            {cbm.topTools.map((t) => (
              <div key={t.tool} className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-primary truncate">{t.tool}</span>
                <span className="text-xs text-text-muted tabular-nums">{t.avgCalls.toFixed(1)} / session</span>
              </div>
            ))}
          </div>
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

function timeUntilShort(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / (60 * 60 * 1000));
  if (h < 1) return `${Math.ceil(ms / 60000)}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function formatReset(iso: string): string {
  const t = timeUntilShort(iso);
  return t === 'now' ? 'resetting' : `resets in ${t}`;
}

function BudgetForecastSection({ forecast }: { forecast: BudgetForecast }) {
  const hasAny =
    forecast.oauthSessions.length > 0 ||
    forecast.monthly !== null ||
    forecast.codex !== null ||
    forecast.missions.length > 0;

  if (!hasAny) return null;

  const activeSessions = forecast.oauthSessions.filter(s => s.state === 'active');
  const learningSessions = forecast.oauthSessions.filter(s => s.state === 'learning');

  return (
    <div data-testid="health-section-budget-forecast" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Budget forecast</h3>
        {/* Documented exception: pinned to the provider's own session window and
            the calendar month. It cannot obey `?window=`, so it says what it
            does obey instead of quietly ignoring the control. */}
        <span className="text-[11px] text-text-muted">provider session window · not {'?window='}</span>
      </div>
      <div className="card divide-y divide-border-default">

        {/* Active OAuth session rows — labeled by account name */}
        {activeSessions.map((s) => (
          <div key={s.accountId} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-primary">{s.accountName || 'Claude session'}</span>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span
                  className="tabular-nums font-medium text-text-primary"
                  title="Usage vs. conservative floor (p25 of exhaustion history). Real remaining capacity is typically higher."
                >
                  {s.pressurePct}% of floor
                </span>
                <span className="text-text-muted">·</span>
                <span>{formatReset(s.windowEndsAt)}</span>
                {s.confidence && s.confidence !== 'low' && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span
                      className={confidenceClass(s.confidence)}
                      title={
                        s.confidence === 'high'
                          ? `Conservative floor estimate from ${s.episodes} exhaustion episode${s.episodes !== 1 ? 's' : ''}${s.limiter === 'tokens' ? ' — token data is often underreported on OAuth' : ''}`
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
            <span className="text-xs text-text-muted" title="No exhaustion events recorded — sessions only learn on hitting the session wall">
              {learningSessions.length} session{learningSessions.length !== 1 ? 's' : ''} — no exhaustion data
            </span>
          </div>
        )}

        {/* Monthly dollar budget */}
        {forecast.monthly && (
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-primary">Monthly budget</span>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                {/* LIFETIME (calendar): spend accumulates from the 1st, so it is
                    labelled with that anchor rather than left to look windowed. */}
                <span className="tabular-nums font-medium text-text-primary">
                  ${forecast.monthly.spentUsd.toFixed(2)} / ${forecast.monthly.budgetUsd.toFixed(0)}
                </span>
                <span className="text-text-muted">·</span>
                <span data-testid="monthly-anchor">{monthlyAnchor(forecast.monthly.resetsAt)}</span>
                <span className="text-text-muted">·</span>
                <span>{formatReset(forecast.monthly.resetsAt)}</span>
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
                      title={forecast.monthly.confidence === 'high' ? 'Burn rate estimate from recent worker costs. High confidence = stable reading, not a certainty signal.' : undefined}
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

        {/* Codex budget (only show when exhausted — for reset-time visibility) */}
        {forecast.codex?.isExhausted && (
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-primary">Codex budget</span>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-status-error font-medium">exhausted</span>
                {forecast.codex.resetsAt && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span className="text-text-secondary">{formatReset(forecast.codex.resetsAt)}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Mission budgets — top 3 nearest to exhaustion */}
        {forecast.missions.slice(0, 3).map((m) => (
          <div key={m.missionId} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-secondary truncate max-w-[10rem]">{m.missionTitle}</span>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className={`font-medium tabular-nums ${
                  m.pctUsed >= 90 ? 'text-status-error' :
                  m.pctUsed >= 70 ? 'text-status-warning' :
                  'text-text-primary'
                }`}>
                  ${m.spentUsd.toFixed(2)} / ${m.budgetUsd.toFixed(2)}
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
          {sectionDenominator(
            credentials.length,
            credentials.length === 1 ? 'backend credential' : 'backend credentials',
          )}
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
                {c.healthStatus}
              </span>
              {c.consecutiveAuthFailures > 0 && (
                <>
                  <span className="text-text-muted">·</span>
                  <span
                    className="text-status-warning"
                    title="Consecutive auth failures — a lifetime streak, reset by the next success. Not a count over the page window."
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
            title="Tasks that ran with no role assigned — a routing-health signal, and the one number /app/team cannot show, because its query filters roleSlug IS NOT NULL."
          >
            {stats.unassigned} task{stats.unassigned === 1 ? '' : 's'} ran with no role ({window})
          </span>
        </div>
        <a
          href="/app/team"
          data-testid="per-role-link"
          className="inline-block text-xs text-accent hover:underline"
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
          className={`px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
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

function FailureAnalyticsSection({
  analytics,
  window: activeWindow,
}: {
  analytics: FailureAnalytics;
  window: FailureWindow;
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
                className="text-[10px] font-mono uppercase tracking-widest text-text-muted"
                title="Failed / terminal workers in the window. Workers still in flight are excluded from the denominator — they have not had the chance to fail yet, and counting them made this number drift downward as work landed."
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
                className="text-[10px] font-mono uppercase tracking-widest text-text-muted"
                title="Failures that used 2 turns or fewer at $0 cost — they consumed a slot and produced nothing. A high count points at a platform bug, not bad agent work."
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
              <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
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
              <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
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
              <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
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
                <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
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
                            last {timeAgo(s.lastSeen)} · first {timeAgo(s.firstSeen)}
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
                      <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
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
                      <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
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
                        className="text-[10px] font-mono uppercase tracking-widest text-text-muted"
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
