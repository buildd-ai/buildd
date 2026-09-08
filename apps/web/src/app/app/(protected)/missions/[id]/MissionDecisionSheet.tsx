'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { GoalCriterion } from '@buildd/shared';
import { AddCriterionForm } from './MissionGoalCriteria';

interface Props {
  missionId: string;
  /** Every stored criterion — needed so "fix" can splice the edited one back in. */
  goalCriteria: GoalCriterion[];
  /** Index (into `goalCriteria`) of the first non-passing criterion, if any. */
  failingCriterionIndex: number | null;
  fileWorkHref: string;
}

/**
 * The three real exits for a blocked mission, attached to the mission-detail
 * "waiting for human decision" banner. Deliberately does not read anything
 * about which reading (`inferCriteriaFailureReading`) applies — that heuristic
 * is shown as a recommendation elsewhere, never used here to open a panel or
 * pick a default: a wrong default would file a phantom task or waive a
 * mission nobody meant to waive.
 */
export default function MissionDecisionSheet({ missionId, goalCriteria, failingCriterionIndex, fileWorkHref }: Props) {
  const router = useRouter();
  const [fixOpen, setFixOpen] = useState(false);
  const [fixSaving, setFixSaving] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [waiveError, setWaiveError] = useState<string | null>(null);

  const failingCriterion = failingCriterionIndex != null ? goalCriteria[failingCriterionIndex] ?? null : null;

  async function handleFix(updated: GoalCriterion) {
    if (failingCriterionIndex == null) return;
    setFixSaving(true);
    setFixError(null);
    try {
      const next = goalCriteria.map((c, i) => (i === failingCriterionIndex ? updated : c));
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalCriteria: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFixError(body.error ?? `Could not save criterion (HTTP ${res.status})`);
        return;
      }
      // The owner should see the new verdict in this same interaction — the
      // mission's heartbeat is stood down and will not produce one on its own.
      await fetch(`/api/missions/${missionId}/evaluate`, { method: 'POST' }).catch(() => {});
      setFixOpen(false);
      router.refresh();
    } catch {
      setFixError('Could not reach buildd. Criterion was not saved.');
    } finally {
      setFixSaving(false);
    }
  }

  async function handleWaiveConfirm() {
    setWaiving(true);
    setWaiveError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setWaiveError(body.error ?? `Could not complete mission (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setWaiveError('Could not reach buildd. Mission was not completed.');
    } finally {
      setWaiving(false);
    }
  }

  return (
    <div className="mt-2" data-testid="mission-decision-sheet">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={fileWorkHref}
          className="text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border-default rounded-md px-2.5 py-1"
        >
          File the work
        </Link>
        {failingCriterion && (
          <button
            type="button"
            onClick={() => setFixOpen(v => !v)}
            className="text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border-default rounded-md px-2.5 py-1"
          >
            Fix the criterion
          </button>
        )}
        <button
          type="button"
          onClick={() => setWaiveOpen(v => !v)}
          className="text-[12px] font-medium text-text-secondary hover:text-text-primary border border-border-default rounded-md px-2.5 py-1"
        >
          Waive and complete
        </button>
      </div>

      {fixOpen && failingCriterion && (
        <div className="mt-2">
          <AddCriterionForm
            initial={failingCriterion}
            submitLabel="Save & re-run"
            onAdd={handleFix}
            onCancel={() => setFixOpen(false)}
          />
          {fixSaving && <p className="text-[11px] text-text-muted mt-1">Saving…</p>}
          {fixError && <p role="alert" className="text-[11px] text-status-error mt-1">{fixError}</p>}
        </div>
      )}

      {waiveOpen && (
        <div className="mt-2 border border-status-warning/30 bg-status-warning/5 rounded-sm p-3">
          <p className="text-[12px] text-text-secondary">
            This marks the mission complete even though its goal criteria have not passed.
            The override is recorded on the mission feed.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => setWaiveOpen(false)}
              disabled={waiving}
              className="text-[12px] font-medium text-text-muted hover:text-text-secondary border border-border-default rounded-md px-2.5 py-1 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleWaiveConfirm}
              disabled={waiving}
              className="text-[12px] font-medium text-white bg-status-warning hover:bg-status-warning/90 rounded-md px-2.5 py-1 disabled:opacity-50"
            >
              {waiving ? 'Completing…' : 'Confirm — mark complete'}
            </button>
          </div>
          {waiveError && <p role="alert" className="text-[11px] text-status-error mt-1.5">{waiveError}</p>}
        </div>
      )}
    </div>
  );
}
