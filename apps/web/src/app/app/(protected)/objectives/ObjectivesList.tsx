'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Select } from '@/components/ui/Select';
import { useBrowserTimezone } from '@/hooks/useBrowserTimezone';
import {
  DEFAULT_HEARTBEAT_CHECKLIST,
  HEARTBEAT_CRON_PRESETS,
  OBJECTIVE_CRON_PRESETS,
  getHourOptions,
  validateActiveHours,
} from '@/lib/heartbeat-helpers';

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Low', color: 'text-text-muted' },
  5: { label: 'Medium', color: 'text-status-warning' },
  10: { label: 'High', color: 'text-status-error' },
};

interface WorkspaceOption {
  id: string;
  name: string;
}

interface ObjectiveItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  workspaceId: string | null;
  cronExpression: string | null;
  isHeartbeat: boolean | null;
  workspace?: { id: string; name: string } | null;
  lastOutput: {
    status: string;
    updatedAt: string;
    prUrl: string | null;
    prNumber: number | null;
  } | null;
}

const HOUR_OPTIONS = getHourOptions();

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function PauseToggle({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isActive = status === 'active';

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const nextStatus = isActive ? 'paused' : 'active';
    await fetch(`/api/objectives/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      title={isActive ? 'Pause objective' : 'Resume objective'}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        isActive ? 'bg-status-success/60' : 'bg-surface-4'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
          isActive ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

function LastOutputChip({ output }: { output: ObjectiveItem['lastOutput'] }) {
  if (!output) return <span className="text-text-muted text-[11px] font-mono">no runs yet</span>;

  const ago = timeAgo(output.updatedAt);

  if (output.prUrl) {
    return (
      <a
        href={output.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-[11px] font-mono text-status-success hover:underline"
        title={`PR #${output.prNumber}`}
      >
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
        </svg>
        PR #{output.prNumber} · {ago}
      </a>
    );
  }

  if (output.status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-status-success">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        done · {ago}
      </span>
    );
  }

  if (output.status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-status-error">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        failed · {ago}
      </span>
    );
  }

  if (output.status === 'running' || output.status === 'claimed') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-status-running animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-status-running inline-block" />
        running
      </span>
    );
  }

  return <span className="text-[11px] font-mono text-text-muted">{output.status} · {ago}</span>;
}

export default function ObjectivesList({
  objectives,
  teamId,
  workspaces,
}: {
  objectives: ObjectiveItem[];
  teamId: string;
  workspaces: WorkspaceOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [filterActive, setFilterActive] = useState(true);
  const browserTimezone = useBrowserTimezone();

  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [workspaceId, setWorkspaceId] = useState('');
  const [cronExpression, setCronExpression] = useState('');

  // Heartbeat fields
  const [isHeartbeat, setIsHeartbeat] = useState(false);
  const [heartbeatChecklist, setHeartbeatChecklist] = useState('');
  const [activeHoursEnabled, setActiveHoursEnabled] = useState(false);
  const [activeHoursStart, setActiveHoursStart] = useState(8);
  const [activeHoursEnd, setActiveHoursEnd] = useState(22);
  const [activeHoursTimezone, setActiveHoursTimezone] = useState('');

  const effectiveTimezone = activeHoursTimezone || browserTimezone;

  function resetForm() {
    setTitle('');
    setDescription('');
    setPriority(0);
    setWorkspaceId('');
    setCronExpression('');
    setIsHeartbeat(false);
    setHeartbeatChecklist('');
    setActiveHoursEnabled(false);
    setActiveHoursStart(8);
    setActiveHoursEnd(22);
    setActiveHoursTimezone('');
    setShowForm(false);
  }

  function handleHeartbeatToggle(enabled: boolean) {
    setIsHeartbeat(enabled);
    if (enabled) {
      if (!heartbeatChecklist) setHeartbeatChecklist(DEFAULT_HEARTBEAT_CHECKLIST);
      if (!cronExpression) setCronExpression('0 * * * *');
    }
  }

  const activeHoursError = activeHoursEnabled
    ? validateActiveHours(activeHoursStart, activeHoursEnd)
    : null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (isHeartbeat && !heartbeatChecklist.trim()) return;
    if (activeHoursError) return;

    setCreating(true);
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        workspaceId: workspaceId || undefined,
        cronExpression: cronExpression.trim() || undefined,
      };

      if (isHeartbeat) {
        payload.isHeartbeat = true;
        payload.heartbeatChecklist = heartbeatChecklist.trim();
        if (activeHoursEnabled) {
          payload.activeHoursStart = activeHoursStart;
          payload.activeHoursEnd = activeHoursEnd;
          payload.activeHoursTimezone = effectiveTimezone;
        }
      }

      const res = await fetch('/api/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        resetForm();
        startTransition(() => router.refresh());
      }
    } finally {
      setCreating(false);
    }
  }

  const workspaceOptions = [
    { value: '', label: 'All workspaces' },
    ...workspaces.map(ws => ({ value: ws.id, label: ws.name })),
  ];

  const cronPresets = isHeartbeat ? HEARTBEAT_CRON_PRESETS : OBJECTIVE_CRON_PRESETS;

  const activeObjectives = objectives.filter(o => o.status === 'active');
  const pausedObjectives = objectives.filter(o => o.status === 'paused');
  const displayed = filterActive ? activeObjectives : objectives;

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-1 bg-surface-2 border border-border-default rounded-lg p-0.5">
          <button
            onClick={() => setFilterActive(true)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filterActive ? 'bg-surface-3 text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Active
            {activeObjectives.length > 0 && (
              <span className={`ml-1.5 text-[10px] font-mono ${filterActive ? 'text-text-muted' : 'text-text-muted'}`}>
                {activeObjectives.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setFilterActive(false)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              !filterActive ? 'bg-surface-3 text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            All
            <span className="ml-1.5 text-[10px] font-mono text-text-muted">{objectives.length}</span>
          </button>
        </div>

        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-md hover:bg-primary-hover transition-colors"
          >
            + New objective
          </button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="mb-5 p-4 bg-surface-2 border border-border-default rounded-xl space-y-3 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Objective title"
            className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            disabled={creating}
          />

          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            disabled={creating}
          />

          {/* Heartbeat mode toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={isHeartbeat}
              onClick={() => handleHeartbeatToggle(!isHeartbeat)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                isHeartbeat ? 'bg-primary' : 'bg-surface-4'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  isHeartbeat ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
            <label className="text-xs text-text-secondary select-none cursor-pointer" onClick={() => handleHeartbeatToggle(!isHeartbeat)}>
              Heartbeat mode
            </label>
            {isHeartbeat && (
              <span className="text-xs text-text-muted ml-1">— recurring check-in with a checklist</span>
            )}
          </div>

          {/* Heartbeat checklist */}
          {isHeartbeat && (
            <div>
              <label className="block text-xs text-text-muted mb-1">
                Heartbeat checklist <span className="text-status-error">*</span>
              </label>
              <textarea
                value={heartbeatChecklist}
                onChange={e => setHeartbeatChecklist(e.target.value)}
                placeholder={DEFAULT_HEARTBEAT_CHECKLIST}
                rows={6}
                className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono resize-y"
                disabled={creating}
              />
            </div>
          )}

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-text-muted mb-1">Priority</label>
              <div className="flex gap-1.5">
                {([0, 5, 10] as const).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                      priority === p
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'border-border-default text-text-secondary hover:border-primary/30'
                    }`}
                  >
                    {PRIORITY_LABELS[p].label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1">
              <label className="block text-xs text-text-muted mb-1">Workspace</label>
              <Select
                value={workspaceId}
                onChange={setWorkspaceId}
                options={workspaceOptions}
                placeholder="All workspaces"
                size="sm"
              />
            </div>
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Schedule {isHeartbeat ? '' : '(optional)'}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={cronExpression}
                onChange={e => setCronExpression(e.target.value)}
                placeholder={isHeartbeat ? 'e.g. 0 * * * * (every hour)' : 'e.g. 0 9 * * 1 (Mon 9am)'}
                className="flex-1 px-3 py-1.5 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                disabled={creating}
              />
              {cronExpression && !workspaceId && (
                <span className="text-xs text-status-warning shrink-0">Needs workspace</span>
              )}
            </div>
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {cronPresets.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setCronExpression(preset.value)}
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    cronExpression === preset.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border-default text-text-muted hover:border-primary/30 hover:text-text-secondary'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Active hours (heartbeat only) */}
          {isHeartbeat && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={activeHoursEnabled}
                  onClick={() => setActiveHoursEnabled(!activeHoursEnabled)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    activeHoursEnabled ? 'bg-primary' : 'bg-surface-4'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      activeHoursEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
                <label className="text-xs text-text-secondary select-none cursor-pointer" onClick={() => setActiveHoursEnabled(!activeHoursEnabled)}>
                  Active hours only
                </label>
              </div>

              {activeHoursEnabled && (
                <div className="flex items-end gap-2 pl-11">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Start</label>
                    <Select
                      value={String(activeHoursStart)}
                      onChange={v => setActiveHoursStart(Number(v))}
                      options={HOUR_OPTIONS}
                      size="sm"
                    />
                  </div>
                  <span className="text-xs text-text-muted pb-2">to</span>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">End</label>
                    <Select
                      value={String(activeHoursEnd)}
                      onChange={v => setActiveHoursEnd(Number(v))}
                      options={HOUR_OPTIONS}
                      size="sm"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-text-muted mb-1">Timezone</label>
                    <input
                      type="text"
                      value={activeHoursTimezone || browserTimezone}
                      onChange={e => setActiveHoursTimezone(e.target.value)}
                      placeholder="e.g. America/New_York"
                      className="w-full px-2 py-1 bg-surface-1 border border-border-default rounded-md text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
                      disabled={creating}
                    />
                  </div>
                  {activeHoursError && (
                    <span className="text-xs text-status-error shrink-0 pb-2">{activeHoursError}</span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={creating || !title.trim() || (isHeartbeat && !heartbeatChecklist.trim()) || !!activeHoursError}
              className="px-4 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {creating ? 'Creating...' : isHeartbeat ? 'Create heartbeat' : 'Create'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Objectives list */}
      {objectives.length === 0 ? (
        <div className="text-center py-12 text-text-secondary">
          <div className="w-12 h-12 mx-auto mb-4 bg-surface-3 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p>No objectives yet. Create one to get started.</p>
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-10 text-text-secondary text-sm">
          No active objectives.{' '}
          <button onClick={() => setFilterActive(false)} className="text-primary hover:underline">
            Show all {objectives.length}
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {displayed.map(obj => {
            const pri = PRIORITY_LABELS[obj.priority] || PRIORITY_LABELS[0];
            const isPaused = obj.status === 'paused';
            return (
              <Link
                key={obj.id}
                href={`/app/objectives/${obj.id}`}
                className={`block p-4 bg-surface-2 border border-border-default rounded-xl transition-all duration-150 shadow-[0_1px_3px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.06)] hover:-translate-y-px hover:border-border-default/80 ${
                  isPaused ? 'opacity-60' : ''
                }`}
              >
                {/* Top row: type badge + title + toggle */}
                <div className="flex items-start gap-3">
                  {/* Type icon */}
                  <div className={`mt-0.5 w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                    obj.isHeartbeat
                      ? 'bg-status-success/10 text-status-success'
                      : obj.cronExpression
                        ? 'bg-primary/10 text-primary'
                        : 'bg-surface-3 text-text-muted'
                  }`}>
                    {obj.isHeartbeat ? (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                    ) : obj.cronExpression ? (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <h3 className="text-sm font-medium text-text-primary truncate">{obj.title}</h3>
                      {obj.priority > 0 && (
                        <span className={`text-[10px] font-mono shrink-0 ${pri.color}`}>{pri.label}</span>
                      )}
                    </div>
                    {obj.description && (
                      <p className="text-xs text-text-secondary line-clamp-1 mb-1">{obj.description}</p>
                    )}
                    {/* Footer: workspace + last output */}
                    <div className="flex items-center gap-3 mt-1.5">
                      {obj.workspace && (
                        <span className="text-[10px] font-mono text-text-muted px-1.5 py-0.5 bg-surface-3 rounded shrink-0">
                          {obj.workspace.name}
                        </span>
                      )}
                      <LastOutputChip output={obj.lastOutput} />
                    </div>
                  </div>

                  {/* Pause toggle */}
                  <div className="shrink-0 flex items-center pt-1">
                    <PauseToggle id={obj.id} status={obj.status} />
                  </div>
                </div>
              </Link>
            );
          })}

          {/* Paused hint when in active filter */}
          {filterActive && pausedObjectives.length > 0 && (
            <button
              onClick={() => setFilterActive(false)}
              className="w-full pt-1 text-xs text-text-muted hover:text-text-secondary transition-colors text-left pl-1"
            >
              + {pausedObjectives.length} paused
            </button>
          )}
        </div>
      )}
    </div>
  );
}
