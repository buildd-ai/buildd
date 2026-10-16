'use client';

import { useState } from 'react';
import Link from 'next/link';
import Section from '@/components/ui/Section';
import type { TaskEstimatesState } from '@buildd/core/task-estimate-rollout';

/** "On, turned on by your team" and the like: whether it is on, and who decided. */
export function taskEstimatesStatusLine(s: Pick<TaskEstimatesState, 'enabled' | 'source'>): string {
  if (s.source === 'default') return s.enabled ? 'On (default)' : 'Off (default)';
  if (s.enabled) return 'On for this team';
  return 'Off for this team';
}

/**
 * Settings › Team › Features › Task estimates. Owners and admins
 * (manage_team_settings) turn it on or off for the team with
 * PATCH /api/teams/[id] { taskEstimates: { enabled } }; the choice is stored and
 * outlives any later change to the default. Everyone else sees the state.
 */
export default function TaskEstimatesFeature({
  teamId,
  initial,
  canManage,
}: {
  teamId: string;
  initial: TaskEstimatesState;
  canManage: boolean;
}) {
  const [state, setState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setEnabled(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskEstimates: { enabled } }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not save. Try again.");
      }
      setState((s) => ({ ...s, enabled, source: 'team' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Task estimates">
      <div className="space-y-3 text-sm" data-testid="feature-task-estimates">
        <p className="text-text-secondary max-w-prose">
          Shows a typical duration and an upper bound for each new task, based on similar past tasks.
          Estimates don&apos;t affect which tasks run or when.
        </p>
        <p className="max-w-prose text-text-muted">
          Estimates for repos with little history are marked as rough.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="task-estimates-state" className={state.enabled ? 'font-medium text-text-primary' : 'text-text-muted'}>
            {taskEstimatesStatusLine(state)}
          </span>
          {canManage && (
            <button
              type="button"
              data-testid="task-estimates-toggle"
              onClick={() => setEnabled(!state.enabled)}
              disabled={saving}
              className="btn btn-sm h-11 md:h-8"
            >
              {saving ? 'Saving…' : state.enabled ? 'Turn off' : 'Turn on'}
            </button>
          )}
        </div>
        {error && <p className="text-status-error" role="alert">{error}</p>}
        {state.enabled && (
          <Link href="/app/health/estimates" className="inline-block text-accent-text hover:underline">
            View estimate accuracy
          </Link>
        )}
      </div>
    </Section>
  );
}
