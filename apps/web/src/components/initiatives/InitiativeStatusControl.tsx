'use client';

import { INITIATIVE_STATUS_LABEL, SETTABLE_INITIATIVE_STATUSES, type InitiativeStatus } from '@/lib/initiative-view';
import { useSetInitiativeStatus } from './InitiativeCard';

/** The initiative's status, set by hand. Nothing else writes it. */
export default function InitiativeStatusControl({ initiativeId, status }: { initiativeId: string; status: InitiativeStatus }) {
  const { setStatus, pending, error } = useSetInitiativeStatus(initiativeId);
  const options = SETTABLE_INITIATIVE_STATUSES.includes(status) ? SETTABLE_INITIATIVE_STATUSES : [...SETTABLE_INITIATIVE_STATUSES, status];
  return (
    <label className="inline-flex items-center gap-2 font-mono text-[12px] text-text-secondary">
      <span className="section-label text-text-muted">Status</span>
      <select
        data-testid="initiative-status-select"
        value={status}
        disabled={pending}
        onChange={(e) => setStatus(e.target.value as InitiativeStatus)}
        className="min-h-11 border border-border-strong bg-surface-1 px-2 font-mono text-[12.5px] text-text-primary focus:border-primary focus:outline-none md:min-h-9"
      >
        {options.map((s) => (
          <option key={s} value={s}>{INITIATIVE_STATUS_LABEL[s]}</option>
        ))}
      </select>
      {error && <span role="alert" className="text-status-error">{error}</span>}
    </label>
  );
}
