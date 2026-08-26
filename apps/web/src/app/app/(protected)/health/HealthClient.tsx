'use client';

import { useEffect, useMemo, useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { isRunnerOnline } from '@/lib/runner-heartbeats-shared';
import { findDuplicateScheduleIds } from '@/lib/schedule-health';
import type { UsageStats, ScheduleRow, RecentFailure, CredentialHealthItem, BudgetForecast } from './page';
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
  runners: RunnerHeartbeat[];
  usageStats: UsageStats | null;
  schedules: ScheduleRow[];
  recentFailures: RecentFailure[];
  credentialHealth: CredentialHealthItem[];
  teamWorkspaces: { id: string; name: string }[];
  wsFilter: string | null;
  budgetForecast: BudgetForecast | null;
}

export function HealthClient({
  runners,
  usageStats,
  schedules,
  recentFailures,
  credentialHealth,
  teamWorkspaces,
  wsFilter,
  budgetForecast,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [runnerHealth, setRunnerHealth] = useState<Map<string, RunnerHealthState>>(new Map());
  const [showSchedules, setShowSchedules] = useState(false);
  const [showPausedSchedules, setShowPausedSchedules] = useState(false);
  const [showHeartbeatSchedules, setShowHeartbeatSchedules] = useState(false);
  const [expandedCronId, setExpandedCronId] = useState<string | null>(null);
  const [showMoreRoles, setShowMoreRoles] = useState(false);
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

  // Derive problems
  const offlineRunners = runners.filter(r => !isRunnerOnline(r.lastHeartbeatAt));
  const unsandboxedRunners = runners.filter(r => isRunnerOnline(r.lastHeartbeatAt) && r.sandboxEnabled === false);
  const failedSchedules = schedules.filter(s => s.enabled && !!s.lastError);
  const hasProblems =
    credentialHealth.length > 0 ||
    offlineRunners.length > 0 ||
    failedSchedules.length > 0 ||
    recentFailures.length > 0;

  // Partition schedules: heartbeat (mission internals) vs regular
  const heartbeatSchedules = schedules.filter(s => s.isHeartbeat);
  const regularSchedules = schedules.filter(s => !s.isHeartbeat);
  const activeRegular = regularSchedules.filter(s => s.enabled);
  const pausedRegular = regularSchedules.filter(s => !s.enabled);

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="hidden md:block text-2xl font-bold">Health</h1>
          <span className="hidden md:block">
            <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter} />
          </span>
        </div>
      </div>

      {/* 1. Problems now */}
      <section data-testid="health-section-problems" className="mb-6">
        <h2 className="section-label mb-3">Problems</h2>
        {!hasProblems ? (
          <div className="card px-4 py-3 flex items-center gap-2">
            <span className="glow-dot glow-dot-success" />
            <span className="text-sm text-status-success font-medium">All systems healthy</span>
          </div>
        ) : (
          <div className="card divide-y divide-border-default">
            {/* Revoked / degraded credentials */}
            {credentialHealth.map((cred) => {
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
                          <span className="text-[10px] text-text-muted">
                            {cred.consecutiveAuthFailures} consecutive failure{cred.consecutiveAuthFailures !== 1 ? 's' : ''}
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

            {/* Unsandboxed runners — degraded-but-working posture, warning tier */}
            {unsandboxedRunners.map((hb) => (
              <div key={`sandbox-${hb.id}`} className="px-4 py-3 flex items-center gap-3">
                <span className="text-status-warning shrink-0 text-sm">⚠</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    {hb.accountName || 'Runner'} running unsandboxed
                  </p>
                  <p className="text-xs text-text-muted">user namespaces denied · tasks run without bwrap isolation</p>
                </div>
              </div>
            ))}

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

            {/* Recent failures (24h) */}
            {recentFailures.map((f) => (
              <div key={f.workerId} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {f.taskId ? (
                      <a
                        href={`/app/tasks/${f.taskId}`}
                        className="text-sm text-text-primary hover:text-primary truncate block"
                      >
                        {f.taskTitle}
                      </a>
                    ) : (
                      <p className="text-sm text-text-primary truncate">{f.taskTitle}</p>
                    )}
                    <p className="text-xs text-text-muted mt-0.5">{f.workspaceName} · {timeAgo(f.completedAt)}</p>
                    {f.error && (
                      <p className="text-xs text-status-error mt-1 truncate" title={f.error}>{f.error}</p>
                    )}
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-error/10 text-status-error font-medium shrink-0">failed</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Capacity — runners */}
      <section data-testid="health-section-runners" className="mb-6">
        <h2 className="section-label mb-3">Capacity</h2>
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
                const sandboxLabel = hb.sandboxEnabled === null
                  ? 'sandbox unknown'
                  : hb.sandboxEnabled
                    ? 'sandboxed'
                    : 'unsandboxed';
                const sandboxClass = hb.sandboxEnabled === null
                  ? 'text-text-muted'
                  : hb.sandboxEnabled
                    ? 'text-status-success'
                    : 'text-status-warning';
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
                          <span className={`text-[10px] font-mono ${sandboxClass}`} title={hb.sandboxProbeAt ? `probed ${timeAgo(hb.sandboxProbeAt)}` : 'not yet probed'}>
                            {sandboxLabel}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted">
                          {hb.activeWorkerCount}/{hb.maxConcurrentWorkers} workers · last beat {timeAgo(hb.lastHeartbeatAt)}
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
                            <p className="text-[11px] font-medium text-text-secondary mb-2 uppercase tracking-wide">Session history</p>
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
      </section>

      {budgetForecast && <BudgetForecastSection forecast={budgetForecast} />}

      {/* Usage (30d) */}
      {usageStats && usageStats.total > 0 && (
        <section data-testid="health-section-usage" className="mb-6">
          <h2 className="section-label mb-3">Usage (30d)</h2>
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">{usageStats.total} tasks</span>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-status-success">{usageStats.completed} done</span>
                {usageStats.failed > 0 && (
                  <span className="text-status-error">{usageStats.failed} failed</span>
                )}
              </div>
            </div>
            {usageStats.byRole.length > 0 && (
              <div className="space-y-2 pt-1">
                {usageStats.byRole.slice(0, 3).map((r) => (
                  <div key={r.slug} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                    <span className="text-xs text-text-primary flex-1 truncate">{r.name}</span>
                    <span className="text-xs text-text-muted tabular-nums">
                      {r.completed} done{r.failed > 0 ? ` / ${r.failed} failed` : ''}
                    </span>
                  </div>
                ))}
                {usageStats.byRole.length > 3 && (
                  <>
                    {showMoreRoles && usageStats.byRole.slice(3).map((r) => (
                      <div key={r.slug} className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                        <span className="text-xs text-text-primary flex-1 truncate">{r.name}</span>
                        <span className="text-xs text-text-muted tabular-nums">
                          {r.completed} done{r.failed > 0 ? ` / ${r.failed} failed` : ''}
                        </span>
                      </div>
                    ))}
                    <button
                      onClick={() => setShowMoreRoles(p => !p)}
                      className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                      {showMoreRoles
                        ? 'Show less'
                        : `+${usageStats.byRole.length - 3} more role${usageStats.byRole.length - 3 !== 1 ? 's' : ''}`}
                    </button>
                  </>
                )}
                {usageStats.unassigned > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0 bg-text-muted" />
                    <span className="text-xs text-text-muted flex-1">No role</span>
                    <span className="text-xs text-text-muted tabular-nums">{usageStats.unassigned}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 4. Schedules — collapsed by default */}
      {schedules.length > 0 && (
        <section data-testid="health-section-schedules" className="mb-6">
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
                          <p className="text-xs text-text-tertiary mt-0.5">
                            {s.enabled ? `next ${timeUntil(s.nextRunAt)}` : 'paused'} · last {timeAgo(s.lastRunAt)} · {s.totalRuns} runs
                            {s.consecutiveFailures > 0 && (
                              <span className="text-status-error"> · {s.consecutiveFailures} consecutive failures</span>
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
        </section>
      )}

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
    <section data-testid="health-section-budget-forecast" className="mb-6">
      <h2 className="section-label mb-3">Budget Forecast</h2>
      <div className="card divide-y divide-border-default">

        {/* Active OAuth session rows — labeled by account name */}
        {activeSessions.map((s) => (
          <div key={s.accountId} className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-primary">{s.accountName || 'Claude session'}</span>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="tabular-nums font-medium text-text-primary">{s.pressurePct}% used</span>
                <span className="text-text-muted">·</span>
                <span>{formatReset(s.windowEndsAt)}</span>
                {s.confidence && s.confidence !== 'low' && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span
                      className={confidenceClass(s.confidence)}
                      title={s.confidence === 'high' ? 'High episode count — conservative floor estimate, not a certainty signal' : undefined}
                    >
                      {s.confidence === 'high' ? 'calibrated' : `confidence: ${s.confidence}`}
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
            <span className="text-xs text-text-muted">
              {learningSessions.length} session{learningSessions.length !== 1 ? 's' : ''} still learning
            </span>
          </div>
        )}

        {/* Monthly dollar budget */}
        {forecast.monthly && (
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text-primary">Monthly budget</span>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="tabular-nums font-medium text-text-primary">
                  ${forecast.monthly.spentUsd.toFixed(2)} / ${forecast.monthly.budgetUsd.toFixed(0)}
                </span>
                <span className="text-text-muted">·</span>
                <span>{formatReset(forecast.monthly.resetsAt)}</span>
                {forecast.monthly.daysToDepletion !== null && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span>
                      depletes in {forecast.monthly.daysToDepletion < 1
                        ? `${Math.round(forecast.monthly.daysToDepletion * 24)}h`
                        : `${forecast.monthly.daysToDepletion.toFixed(1)}d`
                      }
                    </span>
                  </>
                )}
                {forecast.monthly.confidence !== 'low' && (
                  <>
                    <span className="text-text-muted">·</span>
                    <span className={confidenceClass(forecast.monthly.confidence)}>
                      confidence: {forecast.monthly.confidence}
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
    </section>
  );
}
