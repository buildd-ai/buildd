'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface WorkspaceOption {
  id: string;
  name: string;
}

interface RoleOption {
  slug: string;
  name: string;
  color: string;
  workspaceId: string;
}

interface SchedulePreview {
  valid: boolean;
  description: string;
  nextRuns?: string[];
}

const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Monday', cron: '0 9 * * 1' },
] as const;

export default function NewMissionForm({ workspaces, roles = [] }: { workspaces: WorkspaceOption[]; roles?: RoleOption[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState(workspaces.length === 1 ? workspaces[0].id : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [defaultRoleSlug, setDefaultRoleSlug] = useState('');

  // Schedule state
  const [cronExpression, setCronExpression] = useState('');
  const [customCron, setCustomCron] = useState(false);
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreview | null>(null);
  const [validatingCron, setValidatingCron] = useState(false);

  const validateCron = useCallback(async (cron: string) => {
    if (!cron.trim()) {
      setSchedulePreview(null);
      return;
    }
    setValidatingCron(true);
    try {
      const wsId = workspaceId || workspaces[0]?.id || 'any';
      const res = await fetch(
        `/api/workspaces/${wsId}/schedules/validate?cron=${encodeURIComponent(cron)}`
      );
      if (res.ok) {
        setSchedulePreview(await res.json());
      }
    } catch {
      setSchedulePreview(null);
    } finally {
      setValidatingCron(false);
    }
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (!cronExpression) return;
    const timer = setTimeout(() => validateCron(cronExpression), 300);
    return () => clearTimeout(timer);
  }, [cronExpression, validateCron]);

  function canSubmit(): boolean {
    return name.trim().length > 0;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && canSubmit() && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleSubmit() {
    if (!name.trim()) return;
    setSubmitting(true);
    setError('');

    try {
      const payload: Record<string, unknown> = {
        title: name.trim(),
        workspaceId: workspaceId || undefined,
      };

      if (description.trim()) {
        payload.description = description.trim();
      }

      if (cronExpression) {
        payload.cronExpression = cronExpression;
      }

      if (defaultRoleSlug) {
        payload.defaultRoleSlug = defaultRoleSlug;
      }

      const res = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create mission');
      }

      await res.json();
      router.push('/app/missions');
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-lg mx-auto">
        {/* Back link */}
        <Link href="/app/missions" className="text-sm text-text-secondary hover:text-text-primary mb-4 block">
          &larr; Missions
        </Link>

        <p className="text-lg font-medium text-text-primary mb-6">New Mission</p>

        {/* Mission name */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-text-primary mb-2">
            Name your mission
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Migrate auth to NextAuth v5"
            className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors"
            autoFocus
            data-testid="mission-name-input"
          />
        </div>

        {/* Description */}
        <div className="mb-4">
          <label className="block text-xs text-text-muted mb-1.5">
            Description <span className="text-text-muted/60">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Add more context about what this mission should accomplish..."
            rows={3}
            className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors resize-none"
            data-testid="mission-description-input"
          />
        </div>

        {/* Workspace picker — only show if multiple workspaces */}
        {workspaces.length > 1 && (
          <div className="mb-4">
            <label className="block text-xs text-text-muted mb-1.5">Workspace</label>
            <select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors"
              data-testid="mission-workspace-select"
            >
              <option value="">Select a workspace</option>
              {workspaces.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Assign to role */}
        {roles.length > 0 && (
          <div className="mb-4">
            <label className="block text-xs text-text-muted mb-1.5">
              Assign to role <span className="text-text-muted/60">(optional)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {roles
                .filter(r => !workspaceId || r.workspaceId === workspaceId)
                .map(role => (
                <button
                  key={role.slug}
                  type="button"
                  onClick={() => setDefaultRoleSlug(defaultRoleSlug === role.slug ? '' : role.slug)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    defaultRoleSlug === role.slug
                      ? 'bg-primary/10 border-primary text-primary'
                      : 'bg-surface-2 border-border-default text-text-secondary hover:text-text-primary hover:border-border-default/80'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: role.color }}
                  />
                  {role.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted mt-1">Tasks from this mission will be routed to the selected role.</p>
          </div>
        )}

        {/* Schedule section — always visible, optional */}
        <div className="mb-4 p-4 bg-surface-2 border border-border-default rounded-lg" data-testid="schedule-section">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-semibold text-text-primary">
              Schedule (optional)
            </h3>
          </div>

          {!cronExpression && (
            <p className="text-xs text-text-muted mb-3">
              Add a schedule to run this mission periodically.
            </p>
          )}

          {/* Preset buttons */}
          <div className="flex flex-wrap gap-2 mb-3">
            {SCHEDULE_PRESETS.map(preset => (
              <button
                key={preset.cron}
                type="button"
                onClick={() => { setCronExpression(preset.cron); setCustomCron(false); }}
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
              type="button"
              onClick={() => { setCustomCron(true); setCronExpression(''); setSchedulePreview(null); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                customCron && !SCHEDULE_PRESETS.some(p => p.cron === cronExpression)
                  ? 'bg-primary text-white'
                  : 'bg-surface-3 text-text-secondary hover:bg-surface-3/80 hover:text-text-primary border border-border-default'
              }`}
            >
              Custom...
            </button>
          </div>

          {/* Custom cron input */}
          {customCron && !SCHEDULE_PRESETS.some(p => p.cron === cronExpression) && (
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

          {/* Cron preview */}
          {cronExpression && schedulePreview && (
            <div className="p-3 bg-surface-1 rounded-md border border-border-default">
              {schedulePreview.valid ? (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <svg className="w-3.5 h-3.5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-sm font-medium text-text-primary">{schedulePreview.description}</span>
                  </div>
                  {schedulePreview.nextRuns && schedulePreview.nextRuns.length > 0 && (
                    <div className="space-y-0.5 mt-1">
                      <span className="text-xs text-text-muted">Next runs:</span>
                      {schedulePreview.nextRuns.map((run: string, i: number) => (
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
                  <span className="text-xs text-status-error">{schedulePreview.description}</span>
                </div>
              )}
            </div>
          )}

          {validatingCron && (
            <div className="text-xs text-text-muted mt-2">Validating...</div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 text-sm text-status-error">{error}</div>
        )}

        {/* Submit */}
        <div className="flex items-center justify-end mt-6">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit() || submitting}
            className="px-5 py-2 text-sm font-medium bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
            data-testid="create-mission-button"
          >
            {submitting ? 'Creating...' : 'Create Mission'}
          </button>
        </div>
      </div>
    </main>
  );
}
