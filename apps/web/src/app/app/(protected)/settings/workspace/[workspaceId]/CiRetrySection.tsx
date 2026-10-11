'use client';

import { useState } from 'react';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';

/**
 * gitConfig.enforceGreenCI: a new PR task gets up to 3 fix rounds until its
 * checks pass (the tasks route adds a pr_checks_green loop). It used to be an
 * unlabelled per-row toggle on Settings → Workspaces; it lives here now, and
 * that list shows it only as a chip when it is on.
 */
export default function CiRetrySection({ workspaceId, initial, canEdit }: { workspaceId: string; initial: boolean; canEdit: boolean }) {
  const [on, setOn] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (saving) return;
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitConfig: { enforceGreenCI: next } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Save failed');
      }
    } catch (e) {
      setOn(!next);
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="ci-retry" className="py-4 first:pt-0 last:pb-0 scroll-mt-20">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-primary">Fix until CI passes</h3>
          <p className="text-xs text-text-secondary mt-0.5">Task PRs get up to 3 fix rounds when checks fail.</p>
        </div>
        {canEdit ? (
          <Switch
            checked={on}
            onChange={toggle}
            disabled={saving}
            label="Fix until CI passes"
            className={SWITCH_HIT_AREA}
          />
        ) : (
          <span data-testid="ci-retry-value" className="text-sm text-text-primary shrink-0">{on ? 'On' : 'Off'}</span>
        )}
      </div>
      {error && <p className="text-status-error text-sm mt-2" role="alert">{error}</p>}
    </div>
  );
}
