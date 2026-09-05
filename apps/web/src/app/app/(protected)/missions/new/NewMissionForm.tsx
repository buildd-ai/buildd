'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { BackendSelect, type BackendValue } from '@/components/ui/BackendSelect';
import { Select } from '@/components/ui/Select';
import {
  CRITERION_TYPE_OPTIONS,
  NO_CRITERIA_NOTE,
  newCriterionDraft,
  validateCriteriaDrafts,
  type CriterionDraft,
  type SelectableCriterionType,
} from '@/lib/goal-criteria-form';

const LAST_WORKSPACE_KEY = 'buildd:lastWorkspaceId';

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
          Token expired —{' '}
          <Link href="/app/settings" className="underline">refresh in Settings</Link>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-text-muted shrink-0" />
      <span className="text-xs text-text-muted">
        Not configured —{' '}
        <Link href="/app/settings" className="underline hover:text-text-secondary">
          add credentials in Settings
        </Link>
      </span>
    </div>
  );
}

// ── "Done when…" step (U5) ───────────────────────────────────────────────────
//
// Every rule enforced here comes from `validateCriteriaDrafts`, which calls the
// same `validateGoalCriteria` that POST /api/missions enforces. This component
// renders messages; it never decides them.

const FIELD_CLS =
  'flex-1 bg-surface-1 border border-border-default text-[12px] text-text-primary px-2 py-1 rounded-sm focus:outline-none focus:border-primary';
const FIELD_LABEL_CLS =
  'text-[10px] text-text-muted font-mono uppercase tracking-wide w-24 shrink-0 pt-1';

function CriterionRow({
  draft,
  error,
  onChange,
  onRemove,
}: {
  draft: CriterionDraft;
  error: string | null;
  onChange: (next: CriterionDraft) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<CriterionDraft>) => onChange({ ...draft, ...patch });
  const option = CRITERION_TYPE_OPTIONS.find(o => o.type === draft.type);

  return (
    <div
      className="border border-border-default rounded-sm p-3 space-y-2 bg-surface-1"
      data-testid="criterion-row"
    >
      <div className="flex items-start gap-2">
        <select
          value={draft.type}
          onChange={e => set({ type: e.target.value as SelectableCriterionType })}
          className={FIELD_CLS}
          aria-label="Criterion type"
        >
          {CRITERION_TYPE_OPTIONS.map(o => (
            <option key={o.type} value={o.type}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          className="text-[11px] text-text-muted hover:text-status-error px-1 py-1"
          aria-label="Remove criterion"
        >
          ✕
        </button>
      </div>

      {option && <p className="text-[10px] text-text-muted/80">{option.hint}</p>}

      {draft.type === 'command' && (
        <div className="flex items-start gap-2">
          <label className={FIELD_LABEL_CLS}>Command</label>
          <input
            value={draft.command}
            onChange={e => set({ command: e.target.value })}
            placeholder="e.g. bun run test"
            className={`${FIELD_CLS} font-mono`}
          />
        </div>
      )}

      {draft.type === 'artifact_exists' && (
        <>
          <div className="flex items-start gap-2">
            <label className={FIELD_LABEL_CLS}>Key</label>
            <input
              value={draft.artifactKey}
              onChange={e => set({ artifactKey: e.target.value })}
              placeholder="e.g. deploy-url (optional)"
              className={`${FIELD_CLS} font-mono`}
            />
          </div>
          <div className="flex items-start gap-2">
            <label className={FIELD_LABEL_CLS}>Artifact type</label>
            <input
              value={draft.artifactType}
              onChange={e => set({ artifactType: e.target.value })}
              placeholder="e.g. summary (optional)"
              className={`${FIELD_CLS} font-mono`}
            />
          </div>
        </>
      )}

      {draft.type === 'description' && (
        <>
          <div className="flex items-start gap-2">
            <label className={FIELD_LABEL_CLS}>Criterion</label>
            <textarea
              value={draft.description}
              onChange={e => set({ description: e.target.value })}
              placeholder="e.g. Scorecard artifact covers every retrieval layer"
              rows={2}
              className={`${FIELD_CLS} resize-none`}
            />
          </div>
          <div className="flex items-start gap-2">
            <label className={FIELD_LABEL_CLS}>Why not a script?</label>
            <textarea
              value={draft.notMechanizableReason}
              onChange={e => set({ notMechanizableReason: e.target.value })}
              placeholder="Say why no command / PR / artifact / task check can express this."
              rows={2}
              className={`${FIELD_CLS} resize-none`}
            />
          </div>
        </>
      )}

      <div className="flex items-start gap-2">
        <label className={FIELD_LABEL_CLS}>Label</label>
        <input
          value={draft.label}
          onChange={e => set({ label: e.target.value })}
          placeholder="Shown on the mission page (optional)"
          className={FIELD_CLS}
        />
      </div>

      {error && (
        <p className="text-[11px] text-status-error leading-relaxed" data-testid="criterion-error">
          {error}
        </p>
      )}
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
    const stored = localStorage.getItem(LAST_WORKSPACE_KEY);
    if (stored && workspaces.some(ws => ws.id === stored)) {
      setWorkspaceId(stored);
    } else if (workspaces.length === 1) {
      setWorkspaceId(workspaces[0].id);
    }
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

  // "Done when…" state (U5). Rows carry a stable key so a delete does not
  // transplant one row's error message onto whatever shifts into its index.
  const [criteriaRows, setCriteriaRows] = useState<Array<{ key: string; draft: CriterionDraft }>>([]);
  const [criteriaTouched, setCriteriaTouched] = useState<Record<string, boolean>>({});
  const [criteriaSubmitAttempted, setCriteriaSubmitAttempted] = useState(false);

  const criteriaValidation = validateCriteriaDrafts(criteriaRows.map(r => r.draft));

  function addCriterion() {
    setCriteriaRows(rows => [
      ...rows,
      { key: `c${Date.now()}-${rows.length}`, draft: newCriterionDraft() },
    ]);
  }

  function updateCriterion(key: string, draft: CriterionDraft) {
    setCriteriaRows(rows => rows.map(r => (r.key === key ? { ...r, draft } : r)));
    setCriteriaTouched(t => ({ ...t, [key]: true }));
  }

  function removeCriterion(key: string) {
    setCriteriaRows(rows => rows.filter(r => r.key !== key));
  }

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

    // The criteria step is optional, but a criterion the API would reject must
    // be shown as such here rather than surfacing as a 400 after the round trip.
    if (criteriaRows.length > 0 && !criteriaValidation.ok) {
      setCriteriaSubmitAttempted(true);
      setError(criteriaValidation.formError ?? 'Fix the highlighted criterion before creating the mission.');
      return;
    }

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

      if (criteriaValidation.criteria.length > 0) {
        payload.goalCriteria = criteriaValidation.criteria;
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
        throw new Error(data.error || 'Failed to create mission');
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
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      setSubmitting(false);
    }
  }

  // Which backend status to show based on selection
  const activeStatus = backend === 'codex' ? backendStatus.codex : backendStatus.claude;

  return (
    <main className="min-h-screen pt-14 px-4 pb-8 md:p-8">
      <div className="max-w-lg mx-auto">
        {/* Back link */}
        <Link href="/app/missions" className="text-sm text-text-secondary hover:text-text-primary mb-4 block">
          &larr; Missions
        </Link>

        <p className="text-lg font-medium text-text-primary mb-6">New Mission</p>

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
            className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors"
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
            placeholder="Add more context about what this mission should accomplish…"
            rows={3}
            className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors resize-none"
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
              Uses Claude by default, or the role&apos;s backend if set.
            </p>
          ) : (
            <BackendStatusRow status={activeStatus} backend={backend} />
          )}
        </div>

        {/* Done when… — the mission's definition of done, stated up front (U5) */}
        <div className="mb-5" data-testid="mission-criteria-section">
          <label className="block text-xs text-text-muted mb-1.5">
            Done when… <span className="text-text-muted/60">(optional)</span>
          </label>

          <div className="space-y-2">
            {criteriaRows.map(({ key, draft }, i) => (
              <CriterionRow
                key={key}
                draft={draft}
                error={
                  criteriaTouched[key] || criteriaSubmitAttempted
                    ? criteriaValidation.errors[i] ?? null
                    : null
                }
                onChange={next => updateCriterion(key, next)}
                onRemove={() => removeCriterion(key)}
              />
            ))}
          </div>

          {criteriaRows.length === 0 ? (
            <p className="text-xs text-text-muted/80">{NO_CRITERIA_NOTE}</p>
          ) : (
            criteriaValidation.formError && (
              <p className="text-[11px] text-status-error mt-2">{criteriaValidation.formError}</p>
            )
          )}

          <button
            type="button"
            onClick={addCriterion}
            className="mt-2 text-xs text-text-muted hover:text-text-secondary"
            data-testid="add-criterion-button"
          >
            + Add a criterion
          </button>
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
                  className="w-32 px-3 py-2 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <p className="text-xs text-text-muted mt-1">
                Mission pauses when spend reaches this limit. Empty = uncapped.
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
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit() || submitting}
            className="px-5 py-2 text-sm font-medium bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
            data-testid="create-mission-button"
          >
            {submitting ? 'Creating…' : 'Create Mission'}
          </button>
        </div>

        <p className="mt-8 text-xs text-text-muted text-center border-t border-border-default pt-4">
          To create an individual task, use the{' '}
          <Link href="/app/tasks/new" className="underline hover:text-text-secondary">New Task</Link>
          {' '}form.
        </p>
      </div>
    </main>
  );
}
