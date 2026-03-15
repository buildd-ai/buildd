'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type MissionType = 'build' | 'watch' | 'brief';

interface WorkspaceOption {
  id: string;
  name: string;
}

const MISSION_TYPES: {
  type: MissionType;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    type: 'build',
    label: 'Build',
    description: 'Ship something. Track progress, assign agents, reach 100%.',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
      </svg>
    ),
  },
  {
    type: 'watch',
    label: 'Watch',
    description: 'Monitor signals. Recurring scans, flag what matters.',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    type: 'brief',
    label: 'Brief',
    description: 'Produce a finding. Research, analyze, deliver an artifact.',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

const TYPE_CRON_DEFAULTS: Record<MissionType, string | null> = {
  build: null,           // Manual trigger
  watch: '0 */6 * * *',  // Every 6 hours
  brief: null,           // One-shot
};

export default function NewMissionForm({ workspaces }: { workspaces: WorkspaceOption[] }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [type, setType] = useState<MissionType | null>(null);
  const [workspaceId, setWorkspaceId] = useState(workspaces.length === 1 ? workspaces[0].id : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function canAdvance(): boolean {
    if (step === 1) return name.trim().length > 0;
    if (step === 2) return type !== null;
    if (step === 3) return true; // workspace is optional
    return false;
  }

  function advance() {
    if (!canAdvance()) return;
    if (step < 3) {
      setStep(step + 1);
    } else {
      handleSubmit();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && canAdvance()) {
      e.preventDefault();
      advance();
    }
  }

  async function handleSubmit() {
    if (!type || !name.trim()) return;
    setSubmitting(true);
    setError('');

    try {
      const cronExpression = TYPE_CRON_DEFAULTS[type];
      const payload: Record<string, unknown> = {
        title: name.trim(),
        workspaceId: workspaceId || undefined,
      };

      if (cronExpression) {
        payload.cronExpression = cronExpression;
      }

      if (type === 'watch') {
        payload.isHeartbeat = true;
      }

      const res = await fetch('/api/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create mission');
      }

      await res.json();
      router.push(`/app/missions`);
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

        {/* Progress indicator */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 2, 3].map(s => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                s <= step ? 'bg-primary' : 'bg-surface-4'
              }`}
            />
          ))}
        </div>

        {/* Step 1: Name */}
        {step === 1 && (
          <div>
            <h2 className="section-label mb-3">Step 1</h2>
            <p className="text-lg font-medium text-text-primary mb-6">What&apos;s the mission?</p>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Migrate auth to NextAuth v5"
              className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-sm text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary-ring focus:outline-none transition-colors"
              autoFocus
            />
            <p className="text-xs text-text-muted mt-2">Give it a clear name. You can add details later.</p>
          </div>
        )}

        {/* Step 2: Type */}
        {step === 2 && (
          <div>
            <h2 className="section-label mb-3">Step 2</h2>
            <p className="text-lg font-medium text-text-primary mb-6">What kind of mission?</p>
            <div className="space-y-3">
              {MISSION_TYPES.map(mt => {
                const selected = type === mt.type;
                return (
                  <button
                    key={mt.type}
                    type="button"
                    onClick={() => setType(mt.type)}
                    className={`w-full text-left p-4 rounded-[10px] border transition-all duration-150 ${
                      selected
                        ? 'border-primary bg-primary/5 shadow-[0_0_0_1px_var(--primary)]'
                        : 'border-border-default bg-surface-2 hover:border-border-default/80 hover:bg-surface-3/50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 shrink-0 ${selected ? 'text-primary' : 'text-text-muted'}`}>
                        {mt.icon}
                      </div>
                      <div>
                        <h3 className={`text-sm font-medium ${selected ? 'text-primary' : 'text-text-primary'}`}>
                          {mt.label}
                        </h3>
                        <p className="text-xs text-text-secondary mt-0.5">{mt.description}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 3: Workspace */}
        {step === 3 && (
          <div>
            <h2 className="section-label mb-3">Step 3</h2>
            <p className="text-lg font-medium text-text-primary mb-2">Assign a workspace</p>
            <p className="text-xs text-text-muted mb-6">
              {type === 'build' && 'No schedule \u2014 you trigger runs manually.'}
              {type === 'watch' && 'Default: runs every 6 hours. Editable after creation.'}
              {type === 'brief' && 'One-shot \u2014 runs once and delivers a result.'}
            </p>

            {workspaces.length === 0 ? (
              <div className="card p-4 text-center">
                <p className="text-sm text-text-secondary mb-2">No workspaces found</p>
                <p className="text-xs text-text-muted">You can create the mission without one and add a workspace later.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {workspaces.map(ws => {
                  const selected = workspaceId === ws.id;
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => setWorkspaceId(selected ? '' : ws.id)}
                      className={`w-full text-left px-4 py-3 rounded-[10px] border transition-all duration-150 ${
                        selected
                          ? 'border-primary bg-primary/5 shadow-[0_0_0_1px_var(--primary)]'
                          : 'border-border-default bg-surface-2 hover:border-border-default/80 hover:bg-surface-3/50'
                      }`}
                    >
                      <span className={`text-sm font-medium ${selected ? 'text-primary' : 'text-text-primary'}`}>
                        {ws.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {error && (
              <div className="mt-4 text-sm text-status-error">{error}</div>
            )}
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between mt-8">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Back
            </button>
          ) : (
            <div />
          )}

          <button
            type="button"
            onClick={advance}
            disabled={!canAdvance() || submitting}
            className="px-5 py-2 text-sm font-medium bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating...' : step === 3 ? 'Create Mission' : 'Continue'}
          </button>
        </div>
      </div>
    </main>
  );
}
