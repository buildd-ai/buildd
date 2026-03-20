'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export default function MissionActions({
  missionId,
  status,
  cronExpression: initialCron,
  hasWorkspace,
}: {
  missionId: string;
  status: string;
  cronExpression: string | null;
  hasWorkspace: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [editingCron, setEditingCron] = useState(false);
  const [cronValue, setCronValue] = useState(initialCron || '');
  const [running, setRunning] = useState(false);

  async function handleRunNow() {
    setRunning(true);
    try {
      const res = await fetch(`/api/missions/${missionId}/run`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        startTransition(() => router.refresh());
        if (data.task?.id) {
          router.push(`/app/tasks/${data.task.id}`);
        }
      }
    } finally {
      setRunning(false);
    }
  }

  async function patchMission(body: Record<string, unknown>) {
    setLoading(true);
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      startTransition(() => router.refresh());
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this mission? Linked tasks will be preserved.')) return;
    setLoading(true);
    try {
      await fetch(`/api/missions/${missionId}`, { method: 'DELETE' });
      router.push('/app/missions');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveCron() {
    const trimmed = cronValue.trim();
    await patchMission({ cronExpression: trimmed || null });
    setEditingCron(false);
  }

  const disabled = loading || isPending;

  return (
    <div className="flex flex-col items-end gap-2">
      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Run Now */}
        {status === 'active' && hasWorkspace && (
          <button
            onClick={handleRunNow}
            disabled={disabled || running}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {running ? 'Running...' : 'Run Now'}
          </button>
        )}

        {/* Schedule toggle */}
        {!editingCron && (
          <button
            onClick={() => setEditingCron(true)}
            disabled={disabled}
            className="px-3 py-1.5 text-xs font-medium border border-border-default text-text-secondary rounded-md hover:bg-surface-3 hover:text-text-primary disabled:opacity-50 transition-colors"
          >
            {initialCron ? 'Edit Schedule' : 'Add Schedule'}
          </button>
        )}

        {status === 'active' && (
          <button
            onClick={() => patchMission({ status: 'paused' })}
            disabled={disabled}
            className="px-3 py-1.5 text-xs font-medium border border-border-default text-text-secondary rounded-md hover:bg-surface-3 hover:text-text-primary disabled:opacity-50 transition-colors"
          >
            Pause
          </button>
        )}
        {status === 'paused' && (
          <button
            onClick={() => patchMission({ status: 'active' })}
            disabled={disabled}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Resume
          </button>
        )}
        {(status === 'active' || status === 'paused') && (
          <button
            onClick={() => patchMission({ status: 'completed' })}
            disabled={disabled}
            className="px-3 py-1.5 text-xs font-medium bg-status-success text-white rounded-md hover:bg-status-success/90 disabled:opacity-50 transition-colors"
          >
            Complete
          </button>
        )}
        {status === 'completed' && (
          <button
            onClick={() => patchMission({ status: 'archived' })}
            disabled={disabled}
            className="px-3 py-1.5 text-xs font-medium border border-border-default text-text-muted rounded-md hover:bg-surface-3 hover:text-text-secondary disabled:opacity-50 transition-colors"
          >
            Archive
          </button>
        )}
        <button
          onClick={handleDelete}
          disabled={disabled}
          className="px-3 py-1.5 text-xs font-medium text-status-error border border-status-error/20 hover:bg-status-error/10 rounded-md disabled:opacity-50 transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Inline cron editor */}
      {editingCron && (
        <div className="flex flex-wrap items-center gap-2 p-2 bg-surface-2 border border-border-default rounded-lg">
          <input
            type="text"
            value={cronValue}
            onChange={e => setCronValue(e.target.value)}
            placeholder="e.g. 0 9 * * 1"
            className="w-40 px-2 py-1 bg-surface-1 border border-border-default rounded text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') handleSaveCron();
              if (e.key === 'Escape') setEditingCron(false);
            }}
          />
          {!hasWorkspace && cronValue.trim() && (
            <span className="text-xs text-status-warning">Needs workspace</span>
          )}
          <button
            onClick={handleSaveCron}
            disabled={disabled}
            className="px-2 py-1 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => { setCronValue(initialCron || ''); setEditingCron(false); }}
            className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          {initialCron && (
            <button
              onClick={() => { setCronValue(''); handleSaveCron(); }}
              disabled={disabled}
              className="px-2 py-1 text-xs text-status-error hover:text-status-error/80"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
