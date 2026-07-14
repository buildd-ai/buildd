'use client';

import { useEffect, useMemo, useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceFilter } from '@/components/WorkspaceFilter';
import { isRunnerOnline } from '@/lib/runner-heartbeats-shared';
import { findDuplicateScheduleIds } from '@/lib/schedule-health';
import type { WatchedProjectRow, WorkspaceOption, UsageStats, ScheduleRow, RecentFailure } from './page';
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

interface Props {
  initialRows: WatchedProjectRow[];
  workspaces: WorkspaceOption[];
  runners: RunnerHeartbeat[];
  usageStats: UsageStats | null;
  schedules: ScheduleRow[];
  recentFailures: RecentFailure[];
  teamWorkspaces: { id: string; name: string }[];
  wsFilter: string | null;
}

interface FormState {
  workspaceId: string;
  repo: string;
  inFlightWindowMin: number;
  roleSlug: string;
  pushoverApp: 'tasks' | 'alerts';
  baseRef: string;
  labelFilter: string;
  titlePrefix: string;
  notes: string;
  enabled: boolean;
}

function blankForm(workspaceId: string): FormState {
  return {
    workspaceId,
    repo: '',
    inFlightWindowMin: 60,
    roleSlug: 'ops',
    pushoverApp: 'alerts',
    baseRef: 'main',
    labelFilter: '',
    titlePrefix: '',
    notes: '',
    enabled: true,
  };
}

function rowToForm(row: WatchedProjectRow): FormState {
  return {
    workspaceId: row.workspaceId,
    repo: row.repo,
    inFlightWindowMin: row.inFlightWindowMin,
    roleSlug: row.roleSlug,
    pushoverApp: row.pushoverApp,
    baseRef: row.releasePrFilter.base ?? 'main',
    labelFilter: row.releasePrFilter.label ?? '',
    titlePrefix: row.releasePrFilter.titlePrefix ?? '',
    notes: row.notes ?? '',
    enabled: row.enabled,
  };
}

function formToBody(form: FormState): Record<string, unknown> {
  const releasePrFilter: Record<string, string> = {};
  if (form.baseRef) releasePrFilter.base = form.baseRef;
  if (form.labelFilter) releasePrFilter.label = form.labelFilter;
  if (form.titlePrefix) releasePrFilter.titlePrefix = form.titlePrefix;
  return {
    repo: form.repo.trim(),
    enabled: form.enabled,
    inFlightWindowMin: Number(form.inFlightWindowMin),
    roleSlug: form.roleSlug.trim() || 'ops',
    pushoverApp: form.pushoverApp,
    releasePrFilter,
    notes: form.notes.trim() || null,
  };
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

export function HealthClient({
  initialRows,
  workspaces,
  runners,
  usageStats,
  schedules,
  recentFailures,
  teamWorkspaces,
  wsFilter,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; row?: WatchedProjectRow } | null>(null);
  const [form, setForm] = useState<FormState>(blankForm(workspaces[0]?.id ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runnerHealth, setRunnerHealth] = useState<Map<string, RunnerHealthState>>(new Map());

  const checkRunnerHealth = useCallback(async (heartbeatId: string) => {
    setRunnerHealth(prev => {
      const next = new Map(prev);
      const existing = next.get(heartbeatId);
      if (existing?.expanded && !existing.loading) {
        // Toggle off
        next.set(heartbeatId, { ...existing, expanded: false });
        return next;
      }
      next.set(heartbeatId, { loading: true, expanded: true, ...(existing ?? {}) });
      return next;
    });

    // If already loaded, just toggling — no refetch needed
    const current = runnerHealth.get(heartbeatId);
    if (current?.doctor || current?.error) return;

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
  }, [runnerHealth]);

  const refresh = () => startTransition(() => router.refresh());

  const startCreate = () => {
    setError(null);
    setForm(blankForm(workspaces[0]?.id ?? ''));
    setEditing({ mode: 'create' });
  };
  const startEdit = (row: WatchedProjectRow) => {
    setError(null);
    setForm(rowToForm(row));
    setEditing({ mode: 'edit', row });
  };
  const close = () => {
    setEditing(null);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing?.mode === 'create') {
        if (!form.workspaceId) throw new Error('Workspace required');
        const res = await fetch(`/api/workspaces/${form.workspaceId}/watched-projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formToBody(form)),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Create failed');
      } else if (editing?.mode === 'edit' && editing.row) {
        const res = await fetch(`/api/watched-projects/${editing.row.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formToBody(form)),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed');
      }
      close();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row: WatchedProjectRow) => {
    if (!confirm(`Delete watched project ${row.repo}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watched-projects/${row.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      close();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const duplicateScheduleIds = useMemo(() => findDuplicateScheduleIds(schedules), [schedules]);
  // useState(0) ensures SSR and initial hydration agree on 0; useEffect computes
  // the real count client-side to avoid a hydration mismatch from Date.now() differences.
  const [overdueHeartbeatCount, setOverdueHeartbeatCount] = useState(0);
  useEffect(() => {
    const now = Date.now();
    setOverdueHeartbeatCount(
      schedules.filter(s => s.isHeartbeat && s.enabled && s.nextRunAt != null && new Date(s.nextRunAt).getTime() < now).length,
    );
  }, [schedules]);
  const [scheduleBusyId, setScheduleBusyId] = useState<string | null>(null);
  const [scheduleToDelete, setScheduleToDelete] = useState<ScheduleRow | null>(null);
  const [showPausedSchedules, setShowPausedSchedules] = useState(false);

  const toggleSchedule = async (s: ScheduleRow) => {
    setScheduleBusyId(s.id);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${s.workspaceId}/schedules/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setScheduleBusyId(null);
    }
  };

  const confirmDeleteSchedule = async () => {
    if (!scheduleToDelete) return;
    setScheduleBusyId(scheduleToDelete.id);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${scheduleToDelete.workspaceId}/schedules/${scheduleToDelete.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
      setScheduleToDelete(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setScheduleBusyId(null);
    }
  };

  const runNow = async (row: WatchedProjectRow) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watched-projects/${row.id}/run`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Run failed');
      alert(`Ran check. Fired ${data.fired} alert(s).`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Project Health</h1>
          <WorkspaceFilter workspaces={teamWorkspaces} selectedId={wsFilter} />
        </div>
        <p className="text-sm text-text-tertiary mt-1">
          Watcher fires a task + Pushover when CI breaks on release PRs.
        </p>
      </div>

      {/* Runners */}
      <section data-testid="health-section-runners" className="mb-6">
        <h2 className="section-label mb-3">Runners</h2>
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
                const health = runnerHealth.get(hb.id);
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
                          <span className={`text-[10px] font-mono ${online ? 'text-status-success' : 'text-text-muted'}`}>
                            {online ? 'online' : 'stale'}
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
                {usageStats.byRole.map((r) => (
                  <div key={r.slug} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                    <span className="text-xs text-text-primary flex-1 truncate">{r.name}</span>
                    <span className="text-xs text-text-muted tabular-nums">
                      {r.completed} done{r.failed > 0 ? ` / ${r.failed} failed` : ''}
                    </span>
                  </div>
                ))}
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

      {/* Schedules */}
      {schedules.length > 0 && (
        <section data-testid="health-section-schedules" className="mb-6">
          <h2 className="section-label mb-3">Schedules</h2>

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

          {(() => {
            const activeSchedules = schedules.filter(s => s.enabled);
            const pausedSchedules = schedules.filter(s => !s.enabled);

            const renderRow = (s: ScheduleRow) => {
              const isDupe = duplicateScheduleIds.has(s.id);
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
                      <p className="text-xs text-text-muted mt-0.5">
                        <span className="font-mono">{s.cronExpression}</span> · {s.timezone} · {s.workspaceName}
                      </p>
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
                {activeSchedules.length > 0 && (
                  <div className="card divide-y divide-border-default mb-2">
                    {activeSchedules.map(renderRow)}
                  </div>
                )}

                {pausedSchedules.length > 0 && (
                  <div>
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
                      {pausedSchedules.length} paused {pausedSchedules.length === 1 ? 'schedule' : 'schedules'}
                    </button>
                    {showPausedSchedules && (
                      <div className="card divide-y divide-border-default opacity-75">
                        {pausedSchedules.map(renderRow)}
                      </div>
                    )}
                  </div>
                )}

                {activeSchedules.length === 0 && pausedSchedules.length === 0 && null}
              </>
            );
          })()}
        </section>
      )}

      {/* Recent failures (24h) */}
      {recentFailures.length > 0 && (
        <section data-testid="health-section-recent-failures" className="mb-6">
          <h2 className="section-label mb-3">Recent Failures (24h)</h2>
          <div className="card divide-y divide-border-default">
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

      {/* Watched Projects */}
      <section data-testid="health-section-watched-projects">
        <h2 className="section-label mb-3">Watched Projects</h2>

        {initialRows.length === 0 ? (
          <div className="border border-dashed border-border-strong p-8 text-center text-text-muted">
            <p className="mb-3">No watched projects yet.</p>
            <button
              onClick={startCreate}
              className="inline-flex items-center px-4 h-11 rounded-sm bg-primary text-white font-medium hover:bg-primary-hover transition-colors"
            >
              Add a project
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {initialRows.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border bg-surface-elevated p-4 active:bg-surface-pressed"
              >
                <button onClick={() => startEdit(row)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{row.repo}</div>
                      <div className="text-xs text-text-tertiary mt-0.5">{row.workspaceName}</div>
                    </div>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${row.enabled ? 'bg-status-success/10 text-status-success' : 'bg-text-tertiary/10 text-text-tertiary'}`}>
                      {row.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs text-text-secondary">
                    <div>Last check: {timeAgo(row.lastCheckedAt)}</div>
                    <div>In-flight: {row.inFlightWindowMin}m</div>
                  </div>
                  {row.lastError && (
                    <div className="mt-2 text-xs text-status-error truncate">⚠ {row.lastError}</div>
                  )}
                  {row.recentEvents.length > 0 && (
                    <div className="mt-2 text-xs text-text-tertiary">
                      {row.recentEvents.length} recent firing(s) — latest {timeAgo(row.recentEvents[0].firedAt)}
                    </div>
                  )}
                </button>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => runNow(row)}
                    disabled={busy}
                    className="flex-1 h-11 rounded-sm bg-surface-3 text-text-primary border border-border-strong text-sm font-medium disabled:opacity-50"
                  >
                    Run now
                  </button>
                  <button
                    onClick={() => startEdit(row)}
                    className="flex-1 h-11 rounded-sm bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {initialRows.length > 0 && (
        <div className="fixed left-0 right-0 bottom-0 p-4 bg-surface-2/95 backdrop-blur border-t border-border-default">
          <button
            onClick={startCreate}
            className="w-full h-12 rounded-sm bg-primary text-white font-medium hover:bg-primary-hover transition-colors"
          >
            Add a project
          </button>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={close}>
          <div
            className="w-full sm:max-w-lg sm:rounded-xl rounded-t-2xl bg-surface-elevated max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-surface-elevated border-b px-4 py-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing.mode === 'create' ? 'Add watched project' : 'Edit watched project'}
              </h2>
              <button onClick={close} className="text-text-tertiary text-sm">Cancel</button>
            </div>
            <div className="px-4 py-4 space-y-4">
              {editing.mode === 'create' && (
                <Field label="Workspace">
                  <select
                    value={form.workspaceId}
                    onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}
                    className="w-full h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Repo (owner/name)">
                <input
                  value={form.repo}
                  onChange={(e) => setForm({ ...form, repo: e.target.value })}
                  placeholder="buildd-ai/buildd"
                  inputMode="text"
                  autoCapitalize="off"
                  className="w-full h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                />
              </Field>
              <Field label="In-flight window (min)">
                <input
                  type="number"
                  min={1}
                  value={form.inFlightWindowMin}
                  onChange={(e) => setForm({ ...form, inFlightWindowMin: Number(e.target.value) })}
                  className="w-full h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                />
              </Field>
              <Field label="Release PR filter">
                <div className="grid grid-cols-3 gap-2">
                  <input
                    value={form.baseRef}
                    onChange={(e) => setForm({ ...form, baseRef: e.target.value })}
                    placeholder="base"
                    className="h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                  />
                  <input
                    value={form.labelFilter}
                    onChange={(e) => setForm({ ...form, labelFilter: e.target.value })}
                    placeholder="label"
                    className="h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                  />
                  <input
                    value={form.titlePrefix}
                    onChange={(e) => setForm({ ...form, titlePrefix: e.target.value })}
                    placeholder="title prefix"
                    className="h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                  />
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Role slug (auto-seeded)">
                  <input
                    value={form.roleSlug}
                    onChange={(e) => setForm({ ...form, roleSlug: e.target.value })}
                    placeholder="ops"
                    className="w-full h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                  />
                </Field>
                <Field label="Pushover app">
                  <select
                    value={form.pushoverApp}
                    onChange={(e) => setForm({ ...form, pushoverApp: e.target.value as 'tasks' | 'alerts' })}
                    className="w-full h-11 px-3 rounded-sm border border-border-default bg-surface-1"
                  >
                    <option value="alerts">alerts</option>
                    <option value="tasks">tasks</option>
                  </select>
                </Field>
              </div>
              <Field label="Notes">
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 rounded-sm border border-border-default bg-surface-1"
                />
              </Field>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-5 h-5"
                />
                <span>Enabled</span>
              </label>

              {error && <div className="text-sm text-status-error">{error}</div>}
            </div>
            <div className="sticky bottom-0 bg-surface-elevated border-t px-4 py-3 flex gap-2">
              {editing.mode === 'edit' && editing.row && (
                <button
                  onClick={() => editing.row && deleteRow(editing.row)}
                  disabled={busy}
                  className="h-11 px-4 rounded-lg border text-status-error font-medium"
                >
                  Delete
                </button>
              )}
              <button
                onClick={submit}
                disabled={busy}
                className="flex-1 h-11 rounded-sm bg-primary text-white font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}
