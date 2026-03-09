'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Select } from '@/components/ui/Select';
import { CronPresets } from '@/components/CronPresets';
import { useBrowserTimezone } from '@/hooks/useBrowserTimezone';

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
  const detectedTimezone = useBrowserTimezone('UTC');

  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [workspaceId, setWorkspaceId] = useState('');
  const [cronExpression, setCronExpression] = useState('');

  function resetForm() {
    setTitle('');
    setDescription('');
    setPriority(0);
    setWorkspaceId('');
    setCronExpression('');
    setShowForm(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          workspaceId: workspaceId || undefined,
          cronExpression: cronExpression.trim() || undefined,
        }),
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
            <label className="block text-xs text-text-muted mb-1">Schedule (optional)</label>
            <CronPresets
              value={cronExpression}
              onChange={setCronExpression}
              timezone={detectedTimezone}
            />
            {cronExpression && !workspaceId && (
              <p className="text-xs text-status-warning mt-1">Needs workspace</p>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={creating || !title.trim()}
              className="px-4 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary-hover disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
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
                  <h3 className="font-medium text-text-primary flex-1 truncate">{obj.title}</h3>
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
