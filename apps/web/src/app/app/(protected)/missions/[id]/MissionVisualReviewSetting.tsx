'use client';

/**
 * The Settings sheet's "Visual review" row (docs/design/visual-qa-human-review.md,
 * "Where it shows"): the mission's `autoSurfaceAudit` switch, modelled on the
 * auto-verify toggle, with the audit's live Line under it.
 *
 * Optimistic: the switch flips at once and rolls back, with a message, if the
 * PATCH is refused. Turning it off stops new audits; it cancels nothing that
 * is already queued (the Tray's "Turn off for this mission" does both).
 */
import { useId, useState } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import Switch, { SWITCH_HIT_AREA } from '@/components/ui/Switch';
import VisualReviewLine from '@/components/visual-review/VisualReviewLine';
import { useMissionVisualReview } from './MissionVisualReview';
import MissionSurfaceAuditWaiver, { type MissionSurfaceAuditWaiverProps } from './MissionSurfaceAuditWaiver';

export const VISUAL_REVIEW_SETTING_LABEL = 'Audit UI changes automatically';

export default function MissionVisualReviewSetting({
  missionId,
  initialEnabled,
  visual,
  readonly = false,
  auditWaiver = null,
}: {
  missionId: string;
  /** `missions.autoSurfaceAudit`; the column defaults to on. */
  initialEnabled: boolean | null | undefined;
  /** The server's model; the page's live one wins when it is mounted. */
  visual: VisualReviewModel | null | undefined;
  readonly?: boolean;
  /** The person-only "Waive visual audit" action; null hides it (no audit on the mission). */
  auditWaiver?: Omit<MissionSurfaceAuditWaiverProps, 'variant'> | null;
}) {
  const live = useMissionVisualReview(missionId);
  const model = live?.model ?? visual ?? null;
  const server = initialEnabled ?? true;
  const [enabled, setEnabled] = useState(server);
  const [saving, setSaving] = useState(false);
  // Follow the server's value when it changes (a refresh after the Tray's
  // "Turn off for this mission"), unless this switch's own save is in flight.
  const [lastServer, setLastServer] = useState(server);
  if (server !== lastServer && !saving) {
    setLastServer(server);
    setEnabled(server);
  }
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  async function toggle(next: boolean) {
    if (saving) return;
    const prev = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSurfaceAudit: next }),
      });
      if (!res.ok) throw new Error('refused');
    } catch {
      setEnabled(prev);
      setError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="mission-visual-review-setting" className="card p-4">
      <h2 className="section-label mb-3">Visual review</h2>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px] text-text-primary">{VISUAL_REVIEW_SETTING_LABEL}</span>
          <p id={hintId} className="mt-0.5 text-[12px] leading-[1.45] text-text-muted">
            When a task changes a page, an agent screenshots it on a phone and a desktop and flags what looks wrong.
          </p>
        </div>
        <Switch
          checked={enabled}
          onChange={next => void toggle(next)}
          disabled={saving || readonly}
          label={VISUAL_REVIEW_SETTING_LABEL}
          className={SWITCH_HIT_AREA}
        />
      </div>
      {error && <p role="alert" className="mt-2 font-mono text-[12px] text-status-error">{error}</p>}
      <div className="mt-3 border-t border-border-default pt-3">
        {model && model.phase !== 'off' ? (
          <VisualReviewLine model={model} variant="full" />
        ) : (
          <p className="font-mono text-[12px] text-text-muted">No visual audit.</p>
        )}
      </div>
      {auditWaiver && (
        <div className="mt-3 border-t border-border-default pt-3">
          <MissionSurfaceAuditWaiver {...auditWaiver} variant="setting" />
        </div>
      )}
    </section>
  );
}
