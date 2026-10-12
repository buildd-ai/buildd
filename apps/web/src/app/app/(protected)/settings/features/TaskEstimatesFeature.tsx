'use client';

import { useState } from 'react';
import Link from 'next/link';
import Section from '@/components/ui/Section';
import type { TaskEstimatesState } from '@buildd/core/task-estimate-rollout';

/** "On, turned on by your team" and the like: whether it is on, and who decided. */
export function taskEstimatesStatusLine(s: Pick<TaskEstimatesState, 'enabled' | 'source' | 'defaultOn'>): string {
  if (s.source === 'default') return s.enabled ? 'On (the default)' : 'Off (the default)';
  if (s.enabled) return 'On, turned on by your team';
  return s.defaultOn ? 'Off, turned off by your team. Other teams have it on by default.' : 'Off, turned off by your team';
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
  defaultOffReason,
}: {
  teamId: string;
  initial: TaskEstimatesState;
  canManage: boolean;
  /** Why the default is off (task-estimate-rollout.ts), or null when it is on. */
  defaultOffReason: string | null;
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
        throw new Error(data.error || 'Could not save. Try again.');
      }
      setState((s) => ({ ...s, enabled, source: 'team' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Task estimates">
      <div className="space-y-3 text-sm" data-testid="feature-task-estimates">
        <p className="text-text-secondary max-w-prose">
          Each new task gets a typical time and an upper time most similar tasks finished within. A forecast
          only: it never decides what runs or when.
        </p>
        <p className="max-w-prose text-text-muted">
          A repo with little history gets a rough estimate, marked as such.
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
              {saving ? 'Saving...' : state.enabled ? 'Turn off' : 'Turn on'}
            </button>
          )}
        </div>
        {defaultOffReason && (
          <p className="max-w-prose text-meta text-text-muted" data-testid="task-estimates-default-reason">
            {defaultOffReason} Teams can still turn it on.
          </p>
        )}
        {error && <p className="text-status-error" role="alert">{error}</p>}
        {state.enabled && (
          <Link href="/app/health/estimates" className="inline-block text-accent-text hover:underline">
            How accurate they have been
          </Link>
        )}
      </div>
    </Section>
  );
}
