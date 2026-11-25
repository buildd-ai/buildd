/**
 * Declared access nobody granted, as the one `WaitingReason` every surface
 * reads (queue wait, Start probe). The need is decided by the claim gate's own
 * check (`checkAccessGate`, loaded through the composition root), so a page
 * cannot disagree with the gate: this file only words it and points at the
 * grant UI. No module imports: core stays pure.
 */
import { makeWaitingReason, type WaitingReason } from '@buildd/core/waiting-reason';
import type { TaskAccessNeed } from '@buildd/core/token-delegation';

/** `label` is the display name the loader worked out ("Axiom read, ..."); absent, provider ids are used. */
export interface AccessGap { gaps: TaskAccessNeed[]; detail: string; label?: string }

/** One reason for the access needs nobody granted: a person approves it on the task page. Pure. */
export function accessReasons(taskId: string, gap: AccessGap | null | undefined): WaitingReason[] {
  if (!gap || gap.gaps.length === 0) return [];
  const label = gap.label ?? gap.gaps.map(g => `${g.provider} ${g.access}`).join(', ');
  return [makeWaitingReason('access_unmet', {
    because: `it was filed needing ${label} and nobody has approved it`,
    blocker: { type: 'provider', id: taskId, label, href: `/app/tasks/${encodeURIComponent(taskId)}#task-filed-access` },
    provenance: { source: 'probe', derivedFrom: 'checkAccessGate (claim loop)' },
  })];
}
