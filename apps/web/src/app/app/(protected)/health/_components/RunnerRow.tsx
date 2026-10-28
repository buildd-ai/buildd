'use client';

import type { FleetSnapshot } from '@buildd/shared';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import { deriveSandboxPosture } from '@/lib/runner-heartbeats-shared';
import { runnerIsolationDetail, PLATFORM_TEXT } from '@/lib/runner-isolation-health';
import { observedAgo } from '@/lib/health-metric-grammar';
import { describeRunnerRoute } from '@/lib/runner-route';
import RunnerSlotDetail from './RunnerSlotDetail';
import { RunnerIsolation } from './RunnerIsolation';
import { RunnerRoute } from './RunnerRoute';
import { countOf } from '@/lib/plural';
import { pauseView } from '@/components/RunnerPauseControl';

interface RunnerHealthState {
  loading: boolean;
  expanded: boolean;
  doctor?: { timestamp: string; checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string; detail?: string; fixable?: boolean }>; summary: { ok: number; warn: number; error: number } };
  historyStats?: { totalSessions: number; totalCost: number; avgDurationMs: number; byStatus: Record<string, number> };
  error?: string;
  pushOnlyResult?: { online: boolean; message: string };
}

interface RunnerRowProps {
  runner: RunnerHeartbeat;
  fleetRow: FleetSnapshot['runners'][number] | null;
  online: boolean;
  health?: RunnerHealthState;
  onToggleExpanded?: (heartbeatId: string) => void;
  now: number;
  seesTeamWork?: boolean;
  /** Queued work that could start on a free slot here. Only the page knows it; absent means none. */
  workQueuedHere?: number;
  /** Where the queue lives; the idle line links to it. */
  queueHref?: string;
}

const SANDBOX_PLAIN_LABEL: Record<string, string> = {
  sandboxed: 'sandboxed',
  Seatbelt: 'sandboxed',
  unsandboxed: 'not sandboxed',
  'sandbox disabled': 'sandbox off',
  'mounts unrestricted': 'sandbox partly on',
};

const STATUS_ICON: Record<string, string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
};

const STATUS_CLASS: Record<string, string> = {
  ok: 'text-status-success',
  warn: 'text-status-warning',
  error: 'text-status-error',
};

export function RunnerRow({
  runner,
  fleetRow,
  online,
  health,
  onToggleExpanded,
  now,
  seesTeamWork = false,
  workQueuedHere = 0,
  queueHref = '/app/health/queue',
}: RunnerRowProps) {
  const name = fleetRow?.name ?? runner.accountName ?? 'Runner';
  const tokenName = fleetRow && runner.accountName && runner.accountName !== fleetRow.name ? runner.accountName : null;
  const activeCount = fleetRow ? fleetRow.slots.filter(sl => sl.worker).length : runner.activeWorkerCount;
  const busyLine = `${activeCount} of ${fleetRow?.maxSlots ?? runner.maxConcurrentWorkers} slots in use`;
  const posture = deriveSandboxPosture(runner);
  const sandboxLabel = runnerIsolationDetail(runner).state === 'verified' ? SANDBOX_PLAIN_LABEL[posture.label] ?? null : null;
  const sandboxClass = posture.tier === 'success'
    ? 'text-status-success'
    : posture.tier === 'warning'
      ? 'text-status-warning'
      : 'text-text-muted';

  const working = activeCount > 0;
  const freeSlot = runner.maxConcurrentWorkers > activeCount;
  // Another person's run is named only to those who may read the team's work (same masking as the slot list).
  const workNames = (fleetRow?.slots ?? []).flatMap(sl => {
    const w = sl.worker;
    if (!w) return [];
    if (!seesTeamWork && w.mine !== true && w.mine !== undefined) return [w.mine === null ? 'Unattributed work' : 'A teammate\'s work'];
    return [w.name ?? w.title ?? w.label];
  });
  const savedChange = runner.slots?.desired != null && runner.slots.origin === 'dashboard' && runner.slots.desired !== runner.maxConcurrentWorkers;
  const pause = pauseView({ active: activeCount, online, info: runner.pause ?? null, now });
  // One extra line for the states the dot cannot say: paused, idle with work that could start here, and offline with a saved change.
  const stateLine = !online
    ? savedChange || pause.chip
      ? <p data-testid="health-runner-state-line" className="text-meta text-text-muted">{savedChange ? 'A slot change is saved and applies when it checks in.' : pause.chip}</p>
      : null
    : pause.state
      ? <p data-testid="health-runner-state-line" data-paused="true" className="text-meta text-text-secondary">{pause.state}</p>
    : !working && freeSlot && workQueuedHere > 0
      ? (
        <p data-testid="health-runner-state-line" className="text-meta text-status-warning">
          Idle, but {countOf(workQueuedHere, 'task')} queued could start here.{' '}
          <a href={queueHref} className="underline hover:text-text-primary">See the queue</a>
        </p>
      )
      : working && workNames.length > 0
        ? <p data-testid="health-runner-state-line" className="text-meta text-text-secondary truncate">Working on {workNames.join(', ')}</p>
        : null;

  const handleToggle = () => {
    if (onToggleExpanded) {
      onToggleExpanded(runner.id);
    }
  };

  return (
    <div data-testid="health-runner-row">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={`glow-dot ${online ? 'glow-dot-success' : ''}`}
          style={!online ? { background: 'var(--text-muted)' } : undefined}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p data-testid="health-runner-name" className="text-sm text-text-primary truncate">{name}</p>
            {tokenName && (
              <span className="text-meta text-text-muted truncate" title="The runner token it signs in with">{tokenName}</span>
            )}
            {runner.runnerClass && runner.runnerClass !== 'unknown' && (
              <span data-testid="health-runner-class" className="text-chip font-mono text-text-muted">
                {runner.runnerClass === 'managed' ? 'managed' : runner.runnerClass === 'team' ? 'team host' : runner.mine ? 'personal' : 'teammate\'s'}
              </span>
            )}
            {!online && <span className="text-chip font-mono text-text-muted">offline</span>}
            {sandboxLabel && (
              <span
                className={`text-chip font-mono ${sandboxClass}`}
              >
                {sandboxLabel}
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">
            {runner.isolation && runner.isolation.platform !== 'other' ? `${PLATFORM_TEXT[runner.isolation.platform] ?? runner.isolation.platform} · ` : ''}{busyLine} ·{' '}
            {online ? `seen ${observedAgo(runner.lastHeartbeatAt, now) ?? 'just now'}` : `last seen ${observedAgo(runner.lastHeartbeatAt, now) ?? 'never'}`}
          </p>
          {stateLine}
        </div>
        <button
          onClick={handleToggle}
          disabled={health?.loading}
          className="text-meta px-2.5 h-7 border border-border-default text-text-secondary hover:text-text-primary hover:border-border-strong disabled:opacity-50 transition-colors shrink-0"
        >
          {health?.loading ? '…' : health?.expanded ? 'Hide' : 'Details'}
        </button>
      </div>
      <RunnerIsolation runner={runner} now={now} expanded={!!health?.expanded} />
      {health?.expanded && <RunnerRoute runner={{ ...runner, recentRoutes: fleetRow?.routes }} />}
      {health?.expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border-default bg-surface-1/50">
          <RunnerSlotDetail
            fleetRow={fleetRow}
            runner={runner}
            online={online}
            lastHeartbeatAt={runner.lastHeartbeatAt}
            now={now}
            seesTeamWork={seesTeamWork}
            ownerLabel={runner.runnerClass === 'managed' ? 'managed' : runner.runnerClass === 'team' ? 'team host' : runner.runnerClass === 'unknown' || !runner.runnerClass ? 'unknown' : runner.mine ? 'personal' : 'teammate\'s'}
            route={describeRunnerRoute(runner)}
          />
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
              <p className="text-meta font-medium text-text-secondary mb-2">
                Doctor checks
                <span className="ml-2 font-normal text-text-muted">
                  {health.doctor.summary.ok} ok
                  {health.doctor.summary.warn > 0 && ` · ${health.doctor.summary.warn} warn`}
                  {health.doctor.summary.error > 0 && ` · ${health.doctor.summary.error} error`}
                </span>
              </p>
              <div className="space-y-1">
                {health.doctor.checks.map((c) => (
                  <div key={c.name} className="flex items-start gap-2">
                    <span className={`text-meta font-mono shrink-0 mt-0.5 ${STATUS_CLASS[c.status]}`}>
                      {STATUS_ICON[c.status]}
                    </span>
                    <div className="min-w-0">
                      <span className="text-xs text-text-primary font-mono">{c.name}</span>
                      {c.message && (
                        <span className="text-xs text-text-muted ml-1.5">{c.message}</span>
                      )}
                      {c.detail && (
                        <p className="text-meta text-text-tertiary mt-0.5 break-words">{c.detail}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {runner.mine && health.historyStats && (
            <div className={health.doctor ? 'border-t border-border-default pt-3' : 'pt-3'}>
              <p className="text-meta font-medium text-text-secondary mb-2">
                Session history
                <span className="ml-2 font-normal text-text-muted">
                  lifetime
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
                    <p className="text-sm font-medium text-text-primary tabular-nums">${health.historyStats.totalCost.toFixed(2)}</p>
                  </div>
                )}
                {health.historyStats.avgDurationMs > 0 && (
                  <div>
                    <span className="text-xs text-text-muted">Avg duration</span>
                    <p className="text-sm font-medium text-text-primary tabular-nums">
                      {health.historyStats.avgDurationMs < 1000
                        ? `${Math.round(health.historyStats.avgDurationMs)}ms`
                        : health.historyStats.avgDurationMs < 60000
                          ? `${(health.historyStats.avgDurationMs / 1000).toFixed(1)}s`
                          : `${Math.round(health.historyStats.avgDurationMs / 60000)}m`}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
