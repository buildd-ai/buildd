'use client';

import { useState, useMemo, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export type UnifiedScheduleItem = {
  id: string;
  name: string;
  type: 'heartbeat' | 'cron-objective' | 'workspace-schedule';
  workspaceId: string | null;
  workspaceName: string | null;
  cronExpression: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  totalRuns: number;
  consecutiveFailures: number;
  isEnabled: boolean;
  href: string;
  apiType: 'objective' | 'taskSchedule';
  apiId: string;
  apiWorkspaceId: string | null;
};

type WorkspaceOption = { id: string; name: string };
type FilterType = 'all' | 'heartbeat' | 'cron-objective' | 'workspace-schedule';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function TypeBadge({ type }: { type: UnifiedScheduleItem['type'] }) {
  if (type === 'heartbeat') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-status-success/10 text-status-success border border-status-success/20">
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
        heartbeat
      </span>
    );
  }
  if (type === 'cron-objective') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        objective
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-3 text-text-secondary border border-border-default">
      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
      </svg>
      schedule
    </span>
  );
}

function ToggleSwitch({
  item,
  onToggle,
  loading,
}: {
  item: UnifiedScheduleItem;
  onToggle: (item: UnifiedScheduleItem) => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={item.isEnabled}
      disabled={loading}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(item);
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        item.isEnabled ? 'bg-primary' : 'bg-surface-4'
      }`}
      title={item.isEnabled ? 'Pause' : 'Resume'}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          item.isEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

function ScheduleRow({
  item,
  onToggle,
  toggling,
}: {
  item: UnifiedScheduleItem;
  onToggle: (item: UnifiedScheduleItem) => void;
  toggling: boolean;
}) {
  const isOverdue = item.nextRunAt && new Date(item.nextRunAt) < new Date() && item.isEnabled;
  const hasFailures = item.consecutiveFailures > 0;

  return (
    <div className={`group flex items-center gap-3 p-4 bg-surface-2 border rounded-xl transition-all duration-150 hover:border-primary/20 hover:-translate-y-px shadow-[0_1px_3px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.06)] ${
      !item.isEnabled ? 'opacity-60' : ''
    } ${isOverdue ? 'border-status-warning/30' : 'border-border-default'}`}>
      {/* Toggle */}
      <div className="shrink-0">
        <ToggleSwitch item={item} onToggle={onToggle} loading={toggling} />
      </div>

      {/* Main content — click to navigate */}
      <Link href={item.href} className="flex-1 min-w-0 flex items-center gap-3">
        {/* Name + type badge */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <TypeBadge type={item.type} />
            {item.workspaceName && (
              <span className="text-[10px] font-mono text-text-muted px-1.5 py-0.5 bg-surface-3 rounded">
                {item.workspaceName}
              </span>
            )}
            {hasFailures && (
              <span className="text-[10px] font-mono text-status-error" title={`${item.consecutiveFailures} consecutive failures`}>
                {item.consecutiveFailures} fail{item.consecutiveFailures !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="text-sm font-medium text-text-primary truncate">{item.name}</div>
          <code className="text-[10px] text-text-muted font-mono mt-0.5 block">{item.cronExpression}</code>
        </div>

        {/* Stats column */}
        <div className="shrink-0 text-right hidden sm:block">
          {item.nextRunAt && item.isEnabled ? (
            <div className={`text-xs font-medium ${isOverdue ? 'text-status-warning' : 'text-text-primary'}`}>
              {timeUntil(item.nextRunAt)}
            </div>
          ) : item.isEnabled ? (
            <div className="text-xs text-text-muted">—</div>
          ) : (
            <div className="text-xs text-text-muted">paused</div>
          )}
          <div className="text-[10px] text-text-muted mt-0.5">
            {item.totalRuns > 0 ? `${item.totalRuns} run${item.totalRuns !== 1 ? 's' : ''}` : 'never run'}
          </div>
          {item.lastRunAt && (
            <div className="text-[10px] text-text-muted">last {timeAgo(item.lastRunAt)}</div>
          )}
        </div>

        {/* Chevron */}
        <svg className="w-4 h-4 text-text-muted shrink-0 group-hover:text-text-secondary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </div>
  );
}

export default function SchedulesUnified({
  items: initialItems,
  workspaces,
}: {
  items: UnifiedScheduleItem[];
  workspaces: WorkspaceOption[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [items, setItems] = useState(initialItems);
  const [filter, setFilter] = useState<FilterType>('all');
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('all');
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    return items.filter(item => {
      if (filter !== 'all' && item.type !== filter) return false;
      if (workspaceFilter !== 'all' && item.workspaceId !== workspaceFilter) return false;
      return true;
    });
  }, [items, filter, workspaceFilter]);

  // Stats
  const total = items.length;
  const enabled = items.filter(i => i.isEnabled).length;
  const paused = total - enabled;
  const dueIn24h = items.filter(i => {
    if (!i.nextRunAt || !i.isEnabled) return false;
    const diff = new Date(i.nextRunAt).getTime() - Date.now();
    return diff > 0 && diff < 24 * 60 * 60 * 1000;
  }).length;
  const heartbeats = items.filter(i => i.type === 'heartbeat').length;
  const objectives = items.filter(i => i.type === 'cron-objective').length;
  const scheduleCount = items.filter(i => i.type === 'workspace-schedule').length;

  async function handleToggle(item: UnifiedScheduleItem) {
    const newEnabled = !item.isEnabled;

    // Optimistic update
    setItems(prev =>
      prev.map(i => i.id === item.id ? { ...i, isEnabled: newEnabled } : i)
    );
    setToggling(prev => new Set(prev).add(item.id));

    try {
      if (item.apiType === 'objective') {
        await fetch(`/api/objectives/${item.apiId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newEnabled ? 'active' : 'paused' }),
        });
      } else {
        await fetch(`/api/workspaces/${item.apiWorkspaceId}/schedules/${item.apiId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: newEnabled }),
        });
      }
      startTransition(() => router.refresh());
    } catch {
      // Revert on error
      setItems(prev =>
        prev.map(i => i.id === item.id ? { ...i, isEnabled: !newEnabled } : i)
      );
    } finally {
      setToggling(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  const filterTabs: { key: FilterType; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: total },
    { key: 'heartbeat', label: 'Heartbeats', count: heartbeats },
    { key: 'cron-objective', label: 'Objectives', count: objectives },
    { key: 'workspace-schedule', label: 'Workspace', count: scheduleCount },
  ];

  if (total === 0) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-text-primary">Schedules</h1>
        </div>
        <div className="text-center py-16">
          <div className="w-14 h-14 mx-auto mb-4 bg-surface-3 rounded-full flex items-center justify-center">
            <svg className="w-7 h-7 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-1">No automation yet</h2>
          <p className="text-text-secondary text-sm mb-6 max-w-xs mx-auto">
            Set up heartbeats for periodic monitoring or schedule objectives to run automatically on a cron.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/app/objectives?new=1"
              className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover transition-colors"
            >
              + New objective
            </Link>
            {workspaces.length > 0 && (
              <Link
                href={`/app/workspaces/${workspaces[0].id}/schedules?new=1`}
                className="px-4 py-2 bg-surface-3 text-text-primary text-sm rounded-lg border border-border-default hover:border-primary/30 transition-colors"
              >
                + Workspace schedule
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Schedules</h1>
          <p className="text-sm text-text-secondary mt-0.5">All automated task creation across your workspaces</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/app/objectives"
            className="px-3 py-1.5 text-xs text-text-secondary bg-surface-3 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
          >
            + Objective
          </Link>
          {workspaces.length > 0 && (
            <Link
              href={`/app/workspaces/${workspaces[0].id}/schedules?new=1`}
              className="px-3 py-1.5 text-xs text-text-secondary bg-surface-3 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
            >
              + Workspace schedule
            </Link>
          )}
        </div>
      </div>

      {/* Stats strip */}
      <div className="flex gap-6 mb-6 p-4 bg-surface-2 rounded-lg border border-border-default">
        <div>
          <div className="text-xl font-semibold text-text-primary">{total}</div>
          <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">total</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-status-success">{enabled}</div>
          <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">active</div>
        </div>
        {paused > 0 && (
          <div>
            <div className="text-xl font-semibold text-status-warning">{paused}</div>
            <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">paused</div>
          </div>
        )}
        {dueIn24h > 0 && (
          <div>
            <div className="text-xl font-semibold text-primary">{dueIn24h}</div>
            <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">next 24h</div>
          </div>
        )}
        <div className="ml-auto flex gap-3 text-xs text-text-muted self-center">
          {heartbeats > 0 && <span>{heartbeats} heartbeat{heartbeats !== 1 ? 's' : ''}</span>}
          {objectives > 0 && <span>{objectives} objective{objectives !== 1 ? 's' : ''}</span>}
          {scheduleCount > 0 && <span>{scheduleCount} workspace schedule{scheduleCount !== 1 ? 's' : ''}</span>}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex gap-1 border-b border-border-default">
          {filterTabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                filter === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 text-[10px] text-text-muted">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {workspaces.length > 1 && (
          <select
            value={workspaceFilter}
            onChange={e => setWorkspaceFilter(e.target.value)}
            className="ml-auto text-xs bg-surface-2 border border-border-default rounded-md px-2 py-1.5 text-text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">All workspaces</option>
            {workspaces.map(ws => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Schedule list */}
      {filtered.length === 0 ? (
        <div className="text-center py-10 text-text-muted text-sm">
          No schedules match this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => (
            <ScheduleRow
              key={`${item.apiType}-${item.id}`}
              item={item}
              onToggle={handleToggle}
              toggling={toggling.has(item.id)}
            />
          ))}
        </div>
      )}

      {/* Footer: explain the types */}
      <div className="mt-8 p-4 bg-surface-2 rounded-lg border border-border-default">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">About automation types</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-text-muted">
          <div>
            <div className="flex items-center gap-1.5 mb-1 text-status-success font-medium">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              Heartbeat
            </div>
            Periodic awareness check. Runs with a checklist and suppresses output if nothing needs attention.
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1 text-primary font-medium">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Objective
            </div>
            Scheduled goal. Creates a planning task on each run to make progress toward the objective.
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1 text-text-secondary font-medium">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              Workspace schedule
            </div>
            Cron-based task template. Creates a new task directly from a fixed template on each run.
          </div>
        </div>
      </div>
    </div>
  );
}
