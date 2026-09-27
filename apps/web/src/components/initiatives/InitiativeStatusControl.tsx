'use client';

import { INITIATIVE_STATUS_LABEL, SETTABLE_INITIATIVE_STATUSES, type InitiativeStatus } from '@/lib/initiative-view';
import { useSetInitiativeStatus } from './InitiativeCard';
import { Select } from '@/components/ui/Select';

/** The initiative's status, set by hand. Nothing else writes it. */
export default function InitiativeStatusControl({ initiativeId, status }: { initiativeId: string; status: InitiativeStatus }) {
  const { setStatus, pending, error } = useSetInitiativeStatus(initiativeId);
  const options = SETTABLE_INITIATIVE_STATUSES.includes(status) ? SETTABLE_INITIATIVE_STATUSES : [...SETTABLE_INITIATIVE_STATUSES, status];
  return (
    <label className="inline-flex items-center gap-2 font-mono text-[12px] text-text-secondary">
      <span className="section-label text-text-muted">Status</span>
      <Select
        aria-label="Status"
        testId="initiative-status-select"
        size="sm"
        value={status}
        disabled={pending}
        onChange={(v) => setStatus(v as InitiativeStatus)}
        options={options.map((s) => ({ value: s, label: INITIATIVE_STATUS_LABEL[s] }))}
        className="w-36"
      />
      {error && <span role="alert" className="text-status-error">{error}</span>}
    </label>
  );
}
