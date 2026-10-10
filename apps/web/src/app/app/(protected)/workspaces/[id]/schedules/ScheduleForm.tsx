'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { CronPresets } from '@/components/CronPresets';
import { useBrowserTimezone } from '@/hooks/useBrowserTimezone';
import { TIMEZONE_OPTIONS } from '@/lib/timezone-options';
import PrimaryAction from '@/components/ui/PrimaryAction';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';

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
    oneShot: boolean;
    maxConcurrentFromSchedule: number;
    pauseAfterFailures: number;
  };
}

export function ScheduleForm({ workspaceId, initialData }: Props) {
  const router = useRouter();
  const isEdit = !!initialData;
  const detectedTimezone = useBrowserTimezone('UTC');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Schedule fields
  const [name, setName] = useState(initialData?.name || '');
  const [oneShot, setOneShot] = useState(initialData?.oneShot ?? false);
  const [runAtDate, setRunAtDate] = useState('');
  const [runAtTime, setRunAtTime] = useState('');
  const [cronExpression, setCronExpression] = useState(initialData?.cronExpression || '0 9 * * *');
  const [timezone, setTimezone] = useState(initialData?.timezone || 'UTC');

  // Auto-detect timezone for new schedules (not edits)
  useEffect(() => {
    if (!isEdit && detectedTimezone !== 'UTC') {
      setTimezone(detectedTimezone);
    }
  }, [isEdit, detectedTimezone]);
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
    // Skip cron preview for one-shot with datetime picker
    if (oneShot && runAtDate) {
      setCronPreview(null);
      return;
    }
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
  }, [cronExpression, timezone, workspaceId, oneShot, runAtDate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    // For one-shot schedules with a specific datetime, build a cron expression
    let finalCron = cronExpression;
    if (oneShot && runAtDate && runAtTime) {
      const [year, month, day] = runAtDate.split('-').map(Number);
      const [hour, minute] = runAtTime.split(':').map(Number);
      // Build cron for that exact time: minute hour day month *
      finalCron = `${minute} ${hour} ${day} ${month} *`;
    }

    const body = {
      name,
      cronExpression: finalCron,
      timezone,
      enabled,
      oneShot,
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
      <div className="border border-border-default p-6">
        <h3 className="font-semibold mb-4">{isEdit ? 'Edit schedule' : 'New schedule'}</h3>

        <div className="space-y-4">
          {/* Schedule name */}
          <div>
            <label className="block text-sm font-medium mb-1">Schedule name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
              placeholder="Nightly test suite"
              required
            />
          </div>

          {/* One-shot toggle */}
          <div className="flex items-center gap-3">
            <Switch checked={oneShot} onChange={setOneShot} labelledBy="schedule-one-shot-label" className={SWITCH_HIT_AREA} />
            <span id="schedule-one-shot-label" className="text-sm font-medium">Run once only</span>
            {oneShot && (
              <span className="text-xs text-text-muted">Turns off after it runs</span>
            )}
          </div>

          {/* Schedule timing: datetime picker for one-shot, cron for recurring */}
          {oneShot ? (
            <div>
              <label className="block text-sm font-medium mb-1">Run at</label>
              <div className="flex gap-3">
                <input
                  type="date"
                  value={runAtDate}
                  onChange={(e) => setRunAtDate(e.target.value)}
                  className="flex-1 px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
                  required
                />
                <input
                  type="time"
                  value={runAtTime}
                  onChange={(e) => setRunAtTime(e.target.value)}
                  className="flex-1 px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
                  required
                />
              </div>
              <p className="text-xs text-text-muted mt-1">
                Date and time to run the task, in the timezone below
              </p>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium mb-1">Schedule</label>
              <CronPresets
                value={cronExpression}
                onChange={setCronExpression}
                timezone={timezone}
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
          )}

          {/* Timezone */}
          <div>
            <label className="block text-sm font-medium mb-1">Timezone</label>
            <Select
              value={timezone}
              onChange={setTimezone}
              options={TIMEZONE_OPTIONS}
              searchable
            />
          </div>
        </div>
      </div>

      {/* Task Template */}
      <div className="border border-border-default p-6">
        <h3 className="font-semibold mb-4">Task template</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Task title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
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
              className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
              placeholder="Run the full test suite and report any failures…"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Mode</label>
              <Select
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'execution', label: 'Execution' },
                  { value: 'planning', label: 'Planning' },
                ]}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Priority (0-10)</label>
              <input
                type="number"
                min={0}
                max={10}
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
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
          aria-expanded={showAdvanced}
          className="btn btn-quiet"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced options
        </button>

        {showAdvanced && (
          <div className="mt-4 border border-border-default p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Max concurrent tasks</label>
              <input
                type="number"
                min={0}
                max={10}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
              />
              <p className="text-xs text-text-muted mt-1">
                Skips a run while this many of its tasks are active. 0 = no limit.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Pause after failures</label>
              <input
                type="number"
                min={0}
                max={100}
                value={pauseAfterFailures}
                onChange={(e) => setPauseAfterFailures(parseInt(e.target.value) || 5)}
                className="w-full px-3 py-2 border border-border-default bg-surface-1 text-base md:text-sm"
              />
              <p className="text-xs text-text-muted mt-1">
                Pauses the schedule after this many failures in a row. 0 = never pause.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-4">
        <PrimaryAction type="submit" pending={saving}>
          {saving ? 'Saving…' : isEdit ? 'Update schedule' : 'Create schedule'}
        </PrimaryAction>

        <a
          href={`/app/workspaces/${workspaceId}/schedules`}
          className="btn btn-lg h-11 md:h-10"
        >
          Cancel
        </a>

        {error && (
          <span role="alert" className="text-status-error text-sm">{error}</span>
        )}
      </div>
    </form>
  );
}
