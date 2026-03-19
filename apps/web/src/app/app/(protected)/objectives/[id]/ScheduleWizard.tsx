'use client';

import { useState, useEffect, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Monday', cron: '0 9 * * 1' },
] as const;

interface Workspace {
  id: string;
  name: string;
}

interface SchedulePreview {
  valid: boolean;
  description: string;
  nextRuns?: string[];
}

export default function ScheduleWizard({
  objectiveId,
  hasWorkspace,
  workspaces,
}: {
  objectiveId: string;
  hasWorkspace: boolean;
  workspaces: Workspace[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [cronExpression, setCronExpression] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaces[0]?.id || '');
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const validateCron = useCallback(async (cron: string) => {
    if (!cron.trim()) {
      setPreview(null);
      return;
    }
    setLoading(true);
    try {
      // Use any workspace ID for validation - the endpoint only validates the cron
      const wsId = hasWorkspace ? 'any' : selectedWorkspaceId || workspaces[0]?.id || 'any';
      const res = await fetch(
        `/api/workspaces/${wsId}/schedules/validate?cron=${encodeURIComponent(cron)}`
      );
      if (res.ok) {
        const data = await res.json();
        setPreview(data);
      }
    } catch {
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [hasWorkspace, selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (!cronExpression) return;
    const timer = setTimeout(() => validateCron(cronExpression), 300);
    return () => clearTimeout(timer);
  }, [cronExpression, validateCron]);

  function selectPreset(cron: string) {
    setCronExpression(cron);
    setCustomMode(false);
  }

  async function enableSchedule() {
    if (!cronExpression || !preview?.valid) return;

    const body: Record<string, unknown> = { cronExpression };
    if (!hasWorkspace && selectedWorkspaceId) {
      body.workspaceId = selectedWorkspaceId;
    }

    setSaving(true);
    try {
      await fetch(`/api/missions/${objectiveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  const needsWorkspace = !hasWorkspace && workspaces.length > 0;
  const canEnable = cronExpression && preview?.valid && (hasWorkspace || selectedWorkspaceId);

  return (
    <div className="p-4 bg-surface-2 border border-border-default rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h3 className="text-sm font-semibold text-text-primary">How often should this run?</h3>
      </div>

      {/* Preset buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        {PRESETS.map(preset => (
          <button
            key={preset.cron}
            onClick={() => selectPreset(preset.cron)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              cronExpression === preset.cron
                ? 'bg-primary text-white'
                : 'bg-surface-3 text-text-secondary hover:bg-surface-3/80 hover:text-text-primary border border-border-default'
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          onClick={() => { setCustomMode(true); setCronExpression(''); setPreview(null); }}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            customMode && !PRESETS.some(p => p.cron === cronExpression)
              ? 'bg-primary text-white'
              : 'bg-surface-3 text-text-secondary hover:bg-surface-3/80 hover:text-text-primary border border-border-default'
          }`}
        >
          Custom...
        </button>
      </div>

      {/* Custom cron input */}
      {customMode && !PRESETS.some(p => p.cron === cronExpression) && (
        <div className="mb-3">
          <input
            type="text"
            value={cronExpression}
            onChange={e => setCronExpression(e.target.value)}
            placeholder="e.g. 0 */6 * * * (every 6 hours)"
            className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            autoFocus
          />
        </div>
      )}

      {/* Workspace picker */}
      {needsWorkspace && cronExpression && (
        <div className="mb-3">
          <label className="block text-xs text-text-muted mb-1">Workspace (required for scheduling)</label>
          <Select
            value={selectedWorkspaceId}
            onChange={setSelectedWorkspaceId}
            options={workspaces.map(ws => ({ value: ws.id, label: ws.name }))}
          />
        </div>
      )}

      {/* No workspaces warning */}
      {!hasWorkspace && workspaces.length === 0 && cronExpression && (
        <div className="mb-3 p-2 bg-status-warning/5 border border-status-warning/20 rounded text-xs text-status-warning">
          No workspaces available. Create a workspace first to enable scheduling.
        </div>
      )}

      {/* Preview */}
      {cronExpression && preview && (
        <div className="mb-3 p-3 bg-surface-1 rounded-md border border-border-default">
          {preview.valid ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-3.5 h-3.5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm font-medium text-text-primary">{preview.description}</span>
              </div>
              {preview.nextRuns && preview.nextRuns.length > 0 && (
                <div className="space-y-1">
                  <span className="text-xs text-text-muted">Next runs:</span>
                  {preview.nextRuns.map((run: string, i: number) => (
                    <div key={i} className="text-xs text-text-secondary pl-4">{run}</div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span className="text-xs text-status-error">{preview.description}</span>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="mb-3 text-xs text-text-muted">Validating...</div>
      )}

      {/* Enable button */}
      {cronExpression && (
        <button
          onClick={enableSchedule}
          disabled={!canEnable || saving}
          className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Enabling...' : 'Enable Schedule'}
        </button>
      )}
    </div>
  );
}
