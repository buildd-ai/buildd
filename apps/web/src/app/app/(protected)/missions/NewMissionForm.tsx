'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';
import { Select } from '@/components/ui/Select';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { initialWorkspaceId } from '@/lib/onboarding-view';

const LAST_WORKSPACE_KEY = 'buildd:lastWorkspaceId';

/** What decides "done" now that hand-written criteria are retired (Living Specs D-44). */
export const DONE_WHEN_NOTE =
  'The spec this mission delivers decides when it is done. Select it on the mission page once the mission exists. A chore with no product intent selects none.';

interface WorkspaceOption {
  id: string;
  name: string;
}

interface RoleOption {
  slug: string;
  name: string;
  color: string;
  workspaceId: string | null;
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

// ── Credential status ─────────────────────────────────────────────────────────

type BackendStatusState = 'loading' | 'connected' | 'expired' | 'not_connected';

function useBackendStatus(teamId: string | undefined, fallbackWorkspaceId: string) {
  const [claude, setClaude] = useState<BackendStatusState>('loading');
  const [codex, setCodex] = useState<BackendStatusState>('loading');

  useEffect(() => {
    if (!teamId) {
      setClaude('not_connected');
      setCodex('not_connected');
      return;
    }

    fetch(`/api/secrets?teamId=${teamId}`)
      .then(r => r.ok ? r.json() : { secrets: [] })
      .then((data: { secrets?: Array<{ purpose: string }> }) => {
        const hasCredential = (data.secrets ?? []).some(
          s => s.purpose === 'oauth_token' || s.purpose === 'anthropic_api_key'
        );
        setClaude(hasCredential ? 'connected' : 'not_connected');
      })
      .catch(() => setClaude('not_connected'));

    if (!fallbackWorkspaceId) {
      setCodex('not_connected');
      return;
    }

    fetch(`/api/workspaces/${fallbackWorkspaceId}/codex-credential?scope=team`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { connected: boolean; expired: boolean } | null) => {
        if (!data?.connected) setCodex('not_connected');
        else if (data.expired) setCodex('expired');
        else setCodex('connected');
      })
      .catch(() => setCodex('not_connected'));
  }, [teamId, fallbackWorkspaceId]);

  return { claude, codex };
}

function BackendStatusRow({ status, backend }: { status: BackendStatusState; backend: BackendValue }) {
  if (backend === null || status === 'loading') return null;

  if (status === 'connected') {
    return (
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0" />
        <span className="text-xs text-status-success">Connected</span>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-status-warning shrink-0" />
        <span className="text-xs text-status-warning">
          Token expired:{' '}
          <Link href="/app/settings/runners" className="underline">refresh in Settings › Runners</Link>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted shrink-0" />
      <span className="text-xs text-text-muted">
        No credentials.{' '}
        <Link href="/app/settings/runners" className="underline hover:text-text-secondary">
          Add them in Settings › Runners
        </Link>
      </span>
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────────

export default function NewMissionForm({
  workspaces,
  roles = [],
  teamId,
}: {
  workspaces: WorkspaceOption[];
  roles?: RoleOption[];
  teamId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const artifactId = searchParams.get('artifactId');
  const artifactTitle = searchParams.get('artifactTitle');
  const sourceMission = searchParams.get('sourceMission');
  // When creating from an initiative detail page, file the new mission under it.
  const initiativeId = searchParams.get('initiative');

  const [name, setName] = useState(
    artifactTitle ? `Build: ${artifactTitle}` : ''
  );
  const [description, setDescription] = useState(
    artifactTitle && sourceMission
      ? `Execute the plan from ${sourceMission}: ${artifactTitle}`
      : ''
  );
  const [workspaceId, setWorkspaceId] = useState('');
  const [backend, setBackend] = useState<BackendValue>(null);

  // Default to last-used workspace from localStorage
  useEffect(() => {
    // `?workspace=<id>` (the onboarding flow's last step) beats the last-used one.
    const picked = initialWorkspaceId(workspaces, searchParams.get('workspace'), localStorage.getItem(LAST_WORKSPACE_KEY));
    if (picked) setWorkspaceId(picked);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleWorkspaceChange(id: string) {
    setWorkspaceId(id);
    if (id) localStorage.setItem(LAST_WORKSPACE_KEY, id);
  }

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Schedule state
  const [cronExpression, setCronExpression] = useState('');
  const [customCron, setCustomCron] = useState(false);
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreview | null>(null);
  const [validatingCron, setValidatingCron] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Budget state
  const [costBudgetUsd, setCostBudgetUsd] = useState('');

  // Credential status — fetched on mount using first available workspace as fallback
  const fallbackWorkspaceId = workspaces[0]?.id ?? '';
  const backendStatus = useBackendStatus(teamId, fallbackWorkspaceId);

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
        // Default to the active team passed from the server; fall back to the
        // last-used team only when no active team is available.
        teamId:
          teamId ||
          (typeof window !== 'undefined' ? localStorage.getItem('buildd:lastTeamId') || undefined : undefined),
      };

      if (description.trim()) {
        payload.description = description.trim();
      }

      if (cronExpression) {
        payload.cronExpression = cronExpression;
      }

      if (backend) {
        payload.backend = backend;
      }

      if (artifactId) {
        payload.contextArtifactIds = [artifactId];
      }

      if (initiativeId) {
        payload.initiativeId = initiativeId;
      }

      const parsedBudget = costBudgetUsd.trim() ? parseFloat(costBudgetUsd.trim()) : null;
      if (parsedBudget != null && !isNaN(parsedBudget) && parsedBudget > 0) {
        payload.costBudgetUsd = parsedBudget;
      }

      const res = await fetch('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not create the mission. Try again.');
      }

      const created = await res.json();
      if (created.teamId) {
        localStorage.setItem('buildd:lastTeamId', created.teamId);
      }
      if (workspaceId) {
        localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
      }
      router.push(`/app/missions/${created.id}`);
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not create the mission.';
      setError(message);
      setSubmitting(false);
    }
  }

  // Which backend status to show based on selection
  const activeStatus = backend === 'codex' ? backendStatus.codex : backendStatus.claude;

  return (
    <div>
      {/* Artifact reference badge */}
      {artifactTitle && (
        <div className="flex items-center gap-2 px-3 py-2.5 mb-4 rounded-md bg-primary/8 border border-primary/15">
          <svg className="w-3.5 h-3.5 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.34 8.798" />
          </svg>
          <span className="text-[13px] text-text-secondary truncate">
            Referencing: <span className="text-text-primary font-medium">{artifactTitle}</span>
          </span>
        </div>
      )}

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
          className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-base md:text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors"
          autoFocus
          data-testid="mission-name-input"
        />
      </div>

      {/* Description */}
      <div className="mb-5">
        <label className="block text-xs text-text-muted mb-1.5">
          Description <span className="text-text-muted/60">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Goal, scope, constraints, links…"
          rows={3}
          className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-base md:text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors resize-none"
          data-testid="mission-description-input"
        />
      </div>

      {/* Workspace selection */}
      {workspaces.length > 0 && (
        <div className="mb-5" data-testid="mission-workspace-select">
          <label className="block text-xs text-text-muted mb-1.5">
            Workspace <span className="text-text-muted/60">(optional)</span>
          </label>
          <Select
            value={workspaceId}
            onChange={handleWorkspaceChange}
            placeholder="No workspace"
            options={[
              { value: '', label: 'None' },
              ...workspaces.map(ws => ({ value: ws.id, label: ws.name })),
            ]}
          />
        </div>
      )}

      {/* Backend selection — prominent in main form */}
      <div className="mb-5">
        <label className="block text-xs text-text-muted mb-1.5">Run with</label>
        <BackendSelect value={backend} onChange={setBackend} inheritLabel="Default" />
        {backend === null ? (
          <p className="text-xs text-text-muted/70 mt-1.5">
            Uses Claude by default, or the agent&apos;s backend if set.
          </p>
        ) : (
          <BackendStatusRow status={activeStatus} backend={backend} />
        )}
      </div>

      {/* Done when… Living Specs D-44: a mission is done when the spec it
          delivers passes. Hand-written criteria are no longer offered. */}
      <div className="mb-5" data-testid="mission-criteria-section">
        <label className="block text-xs text-text-muted mb-1.5">Done when…</label>
        <p className="text-xs text-text-muted/80">{DONE_WHEN_NOTE}</p>
      </div>

      {/* Advanced options toggle */}
      {!showAdvanced ? (
        <button
          type="button"
          onClick={() => setShowAdvanced(true)}
          className="text-xs text-text-muted hover:text-text-secondary mb-4"
        >
          Advanced options (cost budget, schedule) &rarr;
        </button>
      ) : (
        <>
          {/* Cost budget */}
          <div className="mb-4">
            <label className="block text-xs text-text-muted mb-1.5">
              Cost budget (USD) <span className="text-text-muted/60">(optional)</span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-muted">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={costBudgetUsd}
                onChange={e => setCostBudgetUsd(e.target.value)}
                placeholder="e.g. 10.00"
                className="w-32 px-3 py-2 bg-surface-1 border border-border-default rounded-sm text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <p className="text-xs text-text-muted mt-1">
              Mission pauses when estimated spend (API list price) reaches this limit. Empty = uncapped.
            </p>
          </div>

          {/* Schedule section */}
          <div className="mb-4 p-4 bg-surface-2 border border-border-default rounded-lg" data-testid="schedule-section">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className="text-sm font-semibold text-text-primary">
                Schedule <span className="text-xs font-normal text-text-muted">(optional)</span>
              </h3>
            </div>

            {!cronExpression && (
              <p className="text-xs text-text-muted mb-3">
                Run this mission on a schedule.
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
                Custom…
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
                  className="w-full px-3 py-2 bg-surface-1 border border-border-default rounded-md text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono"
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
              <div className="text-xs text-text-muted mt-2">Validating…</div>
            )}
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 text-sm text-status-error">{error}</div>
      )}

      {/* Submit */}
      <div className="flex items-center justify-end mt-6">
        <PrimaryAction
          onClick={handleSubmit}
          disabled={!canSubmit()}
          pending={submitting}
          data-testid="create-mission-button"
        >
          {submitting ? 'Creating…' : 'Create mission'}
        </PrimaryAction>
      </div>

      <p className="mt-8 text-xs text-text-muted text-center border-t border-border-default pt-4">
        To create an individual task, use the{' '}
        <Link href="/app/chat?new=task" className="underline hover:text-text-secondary">New Task</Link>
        {' '}form.
      </p>
    </div>
  );
}
