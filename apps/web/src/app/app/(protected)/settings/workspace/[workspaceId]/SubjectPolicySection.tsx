'use client';

import { useState } from 'react';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';
import { ReadOnlyFacts } from './ReadOnlyFacts';
import { useWarnOnUnload } from '@/hooks/useUnsavedChanges';

interface SubjectPolicy {
  mode?: 'observe' | 'propose' | 'enforce';
  autoCloseBuilddSupersededPrs?: boolean;
  priorWorkInjection?: boolean;
  conflictDeadDays?: number;
  proposalGraceHours?: number;
}

interface Props {
  workspaceId: string;
  initialPolicy: SubjectPolicy | null;
  /** Holds manage_workspace_settings. False: the policy as text, no controls. */
  canEdit: boolean;
}

const DEFAULT_CONFLICT_DEAD_DAYS = 7;
const AUTO_CLOSE_LABEL = 'Close older buildd PRs when a newer one merges';
const DAYS_LABEL = 'Close conflicted PRs after (days)';

/**
 * Repeat work: gitConfig.subjectPolicy as a team admin sees it
 * (docs/specs/subject-anchor-liveness.md §5). One switch, and the grace
 * period only while it is on. priorWorkInjection is not shown: its default is
 * right for everyone, and a save writes the stored policy back with only these
 * two fields changed, so a stored value keeps working.
 */
export default function SubjectPolicySection({ workspaceId, initialPolicy, canEdit }: Props) {
  const [stored, setStored] = useState<SubjectPolicy>(initialPolicy ?? {});
  const autoClose = stored.autoCloseBuilddSupersededPrs === true;
  const savedDays = stored.conflictDeadDays ?? DEFAULT_CONFLICT_DEAD_DAYS;
  const [days, setDays] = useState(String(savedDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useWarnOnUnload(canEdit && days !== String(savedDays));

  async function save(changes: Pick<SubjectPolicy, 'autoCloseBuilddSupersededPrs' | 'conflictDeadDays'>) {
    if (saving) return;
    const next: SubjectPolicy = { ...stored, ...changes };
    const prev = stored;
    setStored(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { subjectPolicy: next } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Save failed');
      }
    } catch (e) {
      setStored(prev);
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function saveDays() {
    const n = parseInt(days, 10);
    const value = Number.isFinite(n) && n >= 1 ? Math.min(n, 90) : DEFAULT_CONFLICT_DEAD_DAYS;
    setDays(String(value));
    save({ conflictDeadDays: value });
  }

  if (!canEdit) {
    return (
      <div className="py-4 first:pt-0 last:pb-0">
        <h3 className="text-sm font-medium text-text-primary mb-2">Repeat work</h3>
        <ReadOnlyFacts
          facts={[
            { label: AUTO_CLOSE_LABEL, value: autoClose ? 'On' : 'Off' },
            ...(autoClose ? [{ label: 'Close conflicted PRs after', value: `${savedDays} days` }] : []),
          ]}
        />
      </div>
    );
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-primary">Repeat work</h3>
          <p id="subject-auto-close-label" className="text-xs text-text-secondary mt-0.5">{AUTO_CLOSE_LABEL}</p>
        </div>
        <Switch
          checked={autoClose}
          onChange={(next) => save({
            autoCloseBuilddSupersededPrs: next,
            ...(next && stored.conflictDeadDays === undefined ? { conflictDeadDays: DEFAULT_CONFLICT_DEAD_DAYS } : {}),
          })}
          disabled={saving}
          labelledBy="subject-auto-close-label"
          className={SWITCH_HIT_AREA}
        />
      </div>

      {autoClose && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1" htmlFor="conflict-dead-days">{DAYS_LABEL}</label>
            <input
              id="conflict-dead-days"
              type="number"
              min={1}
              max={90}
              className="w-24 border border-border-default px-3 py-1.5 bg-surface-1 font-mono text-base md:text-sm"
              value={days}
              onChange={e => setDays(e.target.value)}
            />
          </div>
          {days !== String(savedDays) && (
            <button type="button" onClick={saveDays} disabled={saving} className="btn min-h-11">
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      )}
      {error && <p className="text-status-error text-sm mt-2" role="alert">{error}</p>}
    </div>
  );
}
