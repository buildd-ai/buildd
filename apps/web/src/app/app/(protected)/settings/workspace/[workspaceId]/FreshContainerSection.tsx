'use client';

import { useState } from 'react';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';

/**
 * gitConfig.warmHandover: 'off'. Warm handover is the platform's decision
 * (packages/shared/src/warm-handover.ts); a workspace can only opt out, for
 * tasks that act on outside input, where a task could leave something behind
 * for the next one. Off clears the opt-out (null).
 */
export default function FreshContainerSection({ workspaceId, initial, canEdit }: { workspaceId: string; initial: boolean; canEdit: boolean }) {
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
        body: JSON.stringify({ gitConfig: { warmHandover: next ? 'off' : null } }),
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
    <div id="fresh-container" className="py-4 first:pt-0 last:pb-0 scroll-mt-20">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 id="fresh-container-label" className="text-sm font-medium text-text-primary">Start every task from a clean copy</h3>
          <p className="text-xs text-text-secondary mt-0.5">Tasks normally reuse the copy of the repository the last task cleaned up, so they start faster. Turn this on if tasks here act on outside input, like public issues.</p>
        </div>
        {canEdit ? (
          <Switch
            checked={on}
            onChange={toggle}
            disabled={saving}
            labelledBy="fresh-container-label"
            className={SWITCH_HIT_AREA}
          />
        ) : (
          <span data-testid="fresh-container-value" className="text-sm text-text-primary shrink-0">{on ? 'On' : 'Off'}</span>
        )}
      </div>
      {error && <p className="text-status-error text-sm mt-2" role="alert">{error}</p>}
    </div>
  );
}
