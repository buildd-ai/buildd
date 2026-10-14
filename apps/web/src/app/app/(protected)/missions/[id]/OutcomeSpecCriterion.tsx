'use client';

/**
 * The mission's outcome spec inside its goal criteria row (Living Specs
 * Slice 12, spec f7f67f1a R-29..R-31): the pinned revision, coverage on the
 * integrated result in words, what is still open by standing, what a person
 * waived, the final verification and who acts next.
 *
 * Words come from `outcomeSpecView`, the same view the Overview's Verify row
 * reads. Waiving and removing are a person's decisions with a reason; the
 * server refuses them to anything else, and a read-only viewer sees neither.
 */
import { useState } from 'react';
import type { GoalCriteriaState, LivingSpecGoalCriterion } from '@buildd/shared';
import { outcomeSpecView } from '@/lib/mission-outcome-spec-view';

const ACTION = 'min-h-11 md:min-h-0 inline-flex items-center text-meta text-text-muted hover:text-text-primary underline underline-offset-2 touch-manipulation disabled:opacity-40';

type Pending = { kind: 'waive'; criterionId: string } | { kind: 'remove' } | null;

export function OutcomeSpecSummary({ criterion, entry }: { criterion: LivingSpecGoalCriterion; entry: GoalCriteriaState['criteria'][number] | null | undefined }) {
  const v = outcomeSpecView(criterion, entry);
  return (
    <p className="text-meta text-text-muted mt-0.5 leading-snug" data-testid="outcome-spec-summary">
      {v.revisionLine}. {v.coverage ?? 'Not checked on the integrated result.'}
    </p>
  );
}

export default function OutcomeSpecCriterion({ missionId, criterion, entry, readonly, onChanged }: {
  missionId: string;
  criterion: LivingSpecGoalCriterion;
  entry: GoalCriteriaState['criteria'][number] | null | undefined;
  readonly?: boolean;
  onChanged?: () => void;
}) {
  const v = outcomeSpecView(criterion, entry);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(outcomeSpec: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcomeSpec }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not save. Try again.');
        return;
      }
      setPending(null);
      setReason('');
      onChanged?.();
    } catch {
      setError('Could not reach buildd.');
    } finally {
      setSaving(false);
    }
  }

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const enough = reason.trim().length >= 10;

  return (
    <div className="mt-1.5 space-y-1.5" data-testid="outcome-spec-detail" onClick={stop} onKeyDown={stop}>
      {v.narrowed && (
        <p className="text-meta text-text-muted leading-snug">
          Only {v.narrowed.criterionIds.join(', ')}: {v.narrowed.reason}
        </p>
      )}
      {v.open.length > 0 && (
        <ul className="space-y-1" data-testid="outcome-spec-open">
          {v.open.map(o => (
            <li key={o.standing} data-standing={o.standing} className="text-meta leading-snug">
              <span className={o.standing === 'fail' ? 'text-status-error' : 'text-text-secondary'}>{o.label}</span>
              <span className="text-text-muted">: </span>
              {o.criterionIds.map((id, i) => (
                <span key={id} className="font-mono text-text-muted">
                  {i > 0 && ', '}
                  {id}
                  {!readonly && (
                    <button
                      type="button"
                      className={`${ACTION} ml-1`}
                      disabled={saving}
                      data-testid={`waive-${id}`}
                      onClick={() => { setPending({ kind: 'waive', criterionId: id }); setReason(''); }}
                    >
                      Waive
                    </button>
                  )}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {v.waived.length > 0 && (
        <ul className="space-y-1" data-testid="outcome-spec-waived">
          {v.waived.map(w => (
            <li key={w.criterionId} className="text-meta text-text-muted leading-snug">
              <span className="font-mono">{w.criterionId}</span> waived: {w.reason}
              {!readonly && (
                <button
                  type="button"
                  className={`${ACTION} ml-1`}
                  disabled={saving}
                  data-testid={`unwaive-${w.criterionId}`}
                  onClick={() => send({ specId: criterion.specId, unwaive: [w.criterionId] })}
                >
                  Unwaive
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-meta text-text-secondary leading-snug" data-testid="outcome-spec-next">{v.next}</p>
      {v.verificationTaskId && (
        <a href={`/app/tasks/${v.verificationTaskId}`} className={ACTION}>
          Final verification {v.verificationTaskId.slice(0, 8)}
        </a>
      )}
      <a href={`/app/specs/${criterion.specId}`} className={`${ACTION} ml-3`}>Open the spec</a>

      {pending && !readonly && (
        <form
          className="space-y-1.5 pt-1"
          data-testid="outcome-spec-reason"
          onSubmit={(e) => {
            e.preventDefault();
            if (!enough) return;
            if (pending.kind === 'waive') void send({ specId: criterion.specId, waive: [{ criterionId: pending.criterionId, reason: reason.trim() }] });
            else void send({ remove: true, specId: criterion.specId, reason: reason.trim() });
          }}
        >
          <label className="block text-meta text-text-secondary">
            {pending.kind === 'waive'
              ? `Why does this mission not answer for ${pending.criterionId}?`
              : 'Why does this mission no longer answer to this spec?'}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full min-h-11 md:min-h-0 px-2 py-1.5 text-body bg-surface-2"
              autoFocus
            />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={!enough || saving} className="btn min-h-11 md:min-h-0 disabled:opacity-40 touch-manipulation">
              {pending.kind === 'waive' ? `Waive ${pending.criterionId}` : 'Remove the outcome spec'}
            </button>
            <button type="button" className={ACTION} onClick={() => { setPending(null); setReason(''); }}>Cancel</button>
          </div>
        </form>
      )}
      {!readonly && !pending && (
        <button type="button" className={ACTION} disabled={saving} data-testid="outcome-spec-remove" onClick={() => { setPending({ kind: 'remove' }); setReason(''); }}>
          Remove the outcome spec
        </button>
      )}
      {error && <p role="alert" className="text-meta text-status-error leading-snug">{error}</p>}
    </div>
  );
}
