'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  workspaceId: string;
  initialData?: {
    id: string;
    name: string;
    cronExpression: string;
    timezone: string;
    taskTemplate: {
      title: string;
      description?: string;
      mode?: string;
      priority?: number;
      runnerPreference?: string;
    };
    enabled: boolean;
    maxConcurrentFromSchedule: number;
    pauseAfterFailures: number;
  };
}

export function ScheduleForm({ workspaceId, initialData }: Props) {
  const router = useRouter();
  const isEdit = !!initialData;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Schedule fields
  const [name, setName] = useState(initialData?.name || '');
  const [cronExpression, setCronExpression] = useState(initialData?.cronExpression || '0 9 * * *');
  const [timezone, setTimezone] = useState(initialData?.timezone || 'UTC');
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true);
  const [maxConcurrent, setMaxConcurrent] = useState(initialData?.maxConcurrentFromSchedule ?? 1);
  const [pauseAfterFailures, setPauseAfterFailures] = useState(initialData?.pauseAfterFailures ?? 5);

  // Task template fields
  const [title, setTitle] = useState(initialData?.taskTemplate.title || '');
  const [description, setDescription] = useState(initialData?.taskTemplate.description || '');
  const [mode, setMode] = useState(initialData?.taskTemplate.mode || 'execution');
  const [priority, setPriority] = useState(initialData?.taskTemplate.priority ?? 5);

  // Cron validation preview
  const [cronPreview, setCronPreview] = useState<{ valid: boolean; description?: string; nextRuns?: string[] } | null>(null);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!cronExpression.trim()) {
        setCronPreview(null);
        return;
      }
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/schedules/validate?cron=${encodeURIComponent(cronExpression)}&timezone=${encodeURIComponent(timezone)}`);
        if (res.ok) {
          const data = await res.json();
          setCronPreview(data);
        }
      } catch {
        // Non-critical preview
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [cronExpression, timezone, workspaceId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body = {
      name,
      cronExpression,
      timezone,
      enabled,
      maxConcurrentFromSchedule: maxConcurrent,
      pauseAfterFailures,
      taskTemplate: {
        title,
        description: description || undefined,
        mode,
        priority,
      },
    };

    try {
      const url = isEdit
        ? `/api/workspaces/${workspaceId}/schedules/${initialData.id}`
        : `/api/workspaces/${workspaceId}/schedules`;

      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      router.push(`/app/workspaces/${workspaceId}/schedules`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="border border-border-default rounded-lg p-6">
        <h3 className="font-semibold text-lg mb-4">{isEdit ? 'Edit Schedule' : 'New Schedule'}</h3>

        <div className="space-y-4">
          {/* Schedule name */}
          <div>
            <label className="block text-sm font-medium mb-1">Schedule Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="Nightly test suite"
              required
            />
          </div>

          {/* Cron expression */}
          <div>
            <label className="block text-sm font-medium mb-1">Cron Expression</label>
            <input
              type="text"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1 font-mono text-sm"
              placeholder="0 9 * * *"
              required
            />
            {cronPreview && (
              <div className="mt-2">
                {cronPreview.valid ? (
                  <div className="text-sm">
                    <p className="text-status-success">{cronPreview.description}</p>
                    {cronPreview.nextRuns && cronPreview.nextRuns.length > 0 && (
                      <div className="text-text-muted mt-1">
                        <p className="text-xs font-medium">Next runs:</p>
                        {cronPreview.nextRuns.map((run, i) => (
                          <p key={i} className="text-xs">{run}</p>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-status-error">{cronPreview.description}</p>
                )}
              </div>
            )}
            <p className="text-xs text-text-muted mt-1">
              Standard 5-field cron: minute hour day-of-month month day-of-week
            </p>
          </div>

          {/* Timezone */}
          <div>
            <label className="block text-sm font-medium mb-1">Timezone</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
            >
              <option value="UTC">UTC</option>
              <option value="America/New_York">Eastern (America/New_York)</option>
              <option value="America/Chicago">Central (America/Chicago)</option>
              <option value="America/Denver">Mountain (America/Denver)</option>
              <option value="America/Los_Angeles">Pacific (America/Los_Angeles)</option>
              <option value="Europe/London">London (Europe/London)</option>
              <option value="Europe/Berlin">Berlin (Europe/Berlin)</option>
              <option value="Asia/Tokyo">Tokyo (Asia/Tokyo)</option>
              <option value="Asia/Shanghai">Shanghai (Asia/Shanghai)</option>
              <option value="Australia/Sydney">Sydney (Australia/Sydney)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Task Template */}
      <div className="border border-border-default rounded-lg p-6">
        <h3 className="font-semibold text-lg mb-4">Task Template</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Task Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="Run nightly tests"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              placeholder="Run the full test suite and report any failures..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              >
                <option value="execution">Execution</option>
                <option value="planning">Planning</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Priority (0-10)</label>
              <input
                type="number"
                min={0}
                max={10}
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Advanced */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-text-muted hover:text-text-secondary"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced options
        </button>

        {showAdvanced && (
          <div className="mt-4 border border-border-default rounded-lg p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Max Concurrent Tasks</label>
              <input
                type="number"
                min={0}
                max={10}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              />
              <p className="text-xs text-text-muted mt-1">
                Skip creating new tasks if this many are already active. 0 = no limit.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Pause After Failures</label>
              <input
                type="number"
                min={0}
                max={100}
                value={pauseAfterFailures}
                onChange={(e) => setPauseAfterFailures(parseInt(e.target.value) || 5)}
                className="w-full px-3 py-2 border border-border-default rounded-md bg-surface-1"
              />
              <p className="text-xs text-text-muted mt-1">
                Auto-disable schedule after this many consecutive failures. 0 = never pause.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-primary text-white hover:bg-primary-hover rounded-md disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEdit ? 'Update Schedule' : 'Create Schedule'}
        </button>

        <a
          href={`/app/workspaces/${workspaceId}/schedules`}
          className="px-4 py-2 border border-border-default rounded-md hover:bg-surface-3"
        >
          Cancel
        </a>

        {error && (
          <span className="text-status-error text-sm">{error}</span>
        )}
      </div>
    </form>
  );
}
