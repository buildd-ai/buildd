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

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success/15 text-status-success',
  paused: 'bg-status-warning/15 text-status-warning',
  completed: 'bg-primary/15 text-primary',
  archived: 'bg-surface-3 text-text-muted',
};

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
  workspace?: { id: string; name: string } | null;
  totalTasks: number;
  completedTasks: number;
  progress: number;
  recentActivity?: {
    status: string;
    completedAt: string | null;
    prUrl: string | null;
  } | null;
}

const HOUR_OPTIONS = getHourOptions();

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

  // Set timezone from browser on first render (activeHoursTimezone default)
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
      // Pre-fill checklist if empty
      if (!heartbeatChecklist) {
        setHeartbeatChecklist(DEFAULT_HEARTBEAT_CHECKLIST);
      }
      // Default to "Every hour" cron if no cron set
      if (!cronExpression) {
        setCronExpression('0 * * * *');
      }
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

  return (
    <div>
      {/* Create toggle / form */}
      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="w-full mb-6 px-4 py-3 border border-dashed border-border-default rounded-lg text-sm text-text-secondary hover:border-primary/40 hover:text-primary transition-colors"
        >
          + New objective
        </button>
      ) : (
        <form onSubmit={handleCreate} className="mb-6 p-4 bg-surface-2 border border-border-default rounded-lg space-y-3">
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
              <span className="text-xs text-text-muted ml-1">
                — recurring check-in with a checklist
              </span>
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
            {/* Priority pills */}
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

            {/* Workspace picker */}
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
            {/* Cron presets */}
            <div className="flex gap-1.5 mt-1.5">
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
      ) : (
        <div className="space-y-3">
          {objectives.map(obj => {
            const pri = PRIORITY_LABELS[obj.priority] || PRIORITY_LABELS[0];
            return (
              <Link
                key={obj.id}
                href={`/app/objectives/${obj.id}`}
                className="block p-4 bg-surface-2 border border-border-default rounded-lg hover:border-primary/30 transition-colors"
              >
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="font-medium text-text-primary flex-1 truncate flex items-center gap-1.5">
                    {(obj as any).isHeartbeat && (
                      <svg className="w-4 h-4 text-status-success shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                      </svg>
                    )}
                    {obj.title}
                  </h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[obj.status] || ''}`}>
                    {obj.status}
                  </span>
                  {obj.priority > 0 && (
                    <span className={`text-xs font-medium ${pri.color}`}>
                      {pri.label}
                    </span>
                  )}
                </div>

                {obj.description && (
                  <p className="text-sm text-text-secondary mb-2 line-clamp-1">{obj.description}</p>
                )}

                <div className="flex items-center gap-4 text-xs text-text-muted">
                  {/* Progress bar */}
                  {obj.totalTasks > 0 && (
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${obj.progress}%` }}
                        />
                      </div>
                      <span>{obj.completedTasks}/{obj.totalTasks}</span>
                    </div>
                  )}
                  {obj.totalTasks === 0 && (
                    <span className="flex-1 text-text-muted">No tasks yet</span>
                  )}

                  {obj.workspace ? (
                    <span className="shrink-0">{obj.workspace.name}</span>
                  ) : (
                    <span className="shrink-0 text-text-muted">All workspaces</span>
                  )}

                  {obj.cronExpression && (
                    <span className="shrink-0" title={obj.cronExpression}>Scheduled</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
