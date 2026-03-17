'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type MissionType = 'build' | 'watch' | 'brief';

interface WorkspaceOption {
  id: string;
  name: string;
}

interface SchedulePreview {
  valid: boolean;
  description: string;
  nextRuns?: string[];
}

const MISSION_TYPES: {
  type: MissionType;
  label: string;
  description: string;
  icon: React.ReactNode;
  placeholder: string;
}[] = [
  {
    type: 'build',
    label: 'Build',
    description: 'Ship something. Track progress, assign agents, reach 100%.',
    placeholder: 'e.g. Migrate auth to NextAuth v5',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
      </svg>
    ),
  },
  {
    type: 'watch',
    label: 'Watch',
    description: 'Monitor signals. Recurring scans, flag what matters.',
    placeholder: 'e.g. Monitor competitor pricing changes',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    type: 'brief',
    label: 'Brief',
    description: 'Produce a finding. Research, analyze, deliver an artifact.',
    placeholder: 'e.g. Research GDPR compliance requirements',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Weekly Monday', cron: '0 9 * * 1' },
] as const;

const TYPE_CRON_DEFAULTS: Record<MissionType, string | null> = {
  build: null,
  watch: '0 */6 * * *',
  brief: null,
};

export default function NewMissionForm({ workspaces }: { workspaces: WorkspaceOption[] }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [type, setType] = useState<MissionType | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState(workspaces.length === 1 ? workspaces[0].id : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Schedule state
  const [cronExpression, setCronExpression] = useState('');
  const [customCron, setCustomCron] = useState(false);
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreview | null>(null);
  const [validatingCron, setValidatingCron] = useState(false);

  const showSchedule = type === 'watch' || type === 'brief';
  const totalSteps = 2;

  // Initialize cron default when type is selected and moving to step 2
  useEffect(() => {
    if (step === 2 && type !== null) {
      const defaultCron = TYPE_CRON_DEFAULTS[type as MissionType];
      if (defaultCron && !cronExpression) {
        setCronExpression(defaultCron);
      }
    }
  }, [step, type, cronExpression]);

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

  function selectType(t: MissionType) {
    setType(t);
    // Reset schedule state when switching type
    setCronExpression('');
    setCustomCron(false);
    setSchedulePreview(null);
    // Move to step 2
    setStep(2);
  }

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
    if (!type || !name.trim()) return;
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

      // Use custom schedule if set, otherwise use type default for watch
      const effectiveCron = cronExpression || TYPE_CRON_DEFAULTS[type as MissionType];
      if (effectiveCron) {
        payload.cronExpression = effectiveCron;
      }

      if (type === 'watch') {
        payload.isHeartbeat = true;
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

  const selectedTypeConfig = MISSION_TYPES.find(mt => mt.type === type);

  return (
    <main className="min-h-screen pt-14 px-4 pb-4 md:p-8">
      <div className="max-w-lg mx-auto">
        {/* Back link */}
        <Link href="/app/missions" className="text-sm text-text-secondary hover:text-text-primary mb-4 block">
          &larr; Missions
        </Link>

        {/* Progress indicator */}
        <div className="flex items-center gap-2 mb-8">
          {Array.from({ length: totalSteps }, (_, i) => i + 1).map(s => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                s <= step ? 'bg-primary' : 'bg-surface-4'
              }`}
            />
          ))}
        </div>

        {/* Step 1: Pick type */}
        {step === 1 && (
          <div>
            <p className="text-lg font-medium text-text-primary mb-6">What kind of mission?</p>
            <div className="space-y-3">
              {MISSION_TYPES.map(mt => (
                <button
                  key={mt.type}
                  type="button"
                  onClick={() => selectType(mt.type)}
                  className="w-full text-left p-5 rounded-[10px] border border-border-default bg-surface-2 hover:border-primary/50 hover:bg-surface-3/50 transition-all duration-150 group"
                  data-testid={`mission-type-${mt.type}`}
                >
                  <div className="flex items-start gap-4">
                    <div className="mt-0.5 shrink-0 text-text-muted group-hover:text-primary transition-colors">
                      {mt.icon}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary group-hover:text-primary transition-colors">
                        {mt.label}
                      </h3>
                      <p className="text-xs text-text-secondary mt-1">{mt.description}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Name + description + schedule */}
        {step === 2 && type && (
          <div>
            {/* Type badge */}
            <div className="flex items-center gap-2 mb-6">
              <button
                type="button"
                onClick={() => { setStep(1); setType(null); }}
                className="text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                &larr;
              </button>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium">
                {selectedTypeConfig?.icon && (
                  <span className="[&_svg]:w-3.5 [&_svg]:h-3.5">{selectedTypeConfig.icon}</span>
                )}
                {selectedTypeConfig?.label}
              </span>
            </div>

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
                placeholder={selectedTypeConfig?.placeholder}
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

            {/* Schedule section — inline for Watch (required), optional for Brief, hidden for Build */}
            {showSchedule && (
              <div className="mb-4 p-4 bg-surface-2 border border-border-default rounded-lg" data-testid="schedule-section">
                <div className="flex items-center gap-2 mb-3">
                  <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h3 className="text-sm font-semibold text-text-primary">
                    {type === 'watch' ? 'How often should this run?' : 'Schedule (optional)'}
                  </h3>
                </div>

                {type === 'brief' && !cronExpression && (
                  <p className="text-xs text-text-muted mb-3">
                    Runs once by default. Add a schedule to run it periodically.
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
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 text-sm text-status-error">{error}</div>
            )}

            {/* Submit */}
            <div className="flex items-center justify-between mt-6">
              <button
                type="button"
                onClick={() => { setStep(1); setType(null); }}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                Back
              </button>
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
        )}
      </div>
    </main>
  );
}
