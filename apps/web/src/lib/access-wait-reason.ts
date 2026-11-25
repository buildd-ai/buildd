/**
 * Declared access nobody granted, as the one `WaitingReason` every surface
 * reads (queue wait, Start probe). The need is decided by the claim gate's own
 * check (`checkAccessGate`), so a page cannot disagree with the gate: this
 * file only words it and points at the grant UI.
 */
import { makeWaitingReason, type WaitingReason } from '@buildd/core/waiting-reason';
import { readAccessNeeds, type TaskAccessNeed } from '@buildd/core/token-delegation';
import { providerName } from '@/lib/capability-grants-view';
import { checkAccessGate, filedAccessHref } from '@/lib/capability-grants-filed';

export interface AccessGap { gaps: TaskAccessNeed[]; detail: string }

/** One reason for the access needs nobody granted: a person approves it on the task page. Pure. */
export function accessReasons(taskId: string, gap: AccessGap | null | undefined): WaitingReason[] {
  if (!gap || gap.gaps.length === 0) return [];
  const label = gap.gaps.map(g => `${providerName(g.provider)} ${g.access}`).join(', ');
  return [makeWaitingReason('access_unmet', {
    because: `it was filed needing ${label} and nobody has approved it`,
    blocker: { type: 'provider', id: taskId, label, href: filedAccessHref(taskId) },
    provenance: { source: 'probe', derivedFrom: 'checkAccessGate (claim loop)' },
  })];
}

/** The gate's verdict for one task, or null when it declares no access, is covered, or the read failed. */
export async function loadAccessGap(task: { id: string; workspaceId: string; roleSlug?: unknown; delegation?: unknown; context?: unknown }): Promise<AccessGap | null> {
  if (readAccessNeeds(task.context).length === 0) return null;
  return checkAccessGate({
    id: task.id, workspaceId: task.workspaceId, roleSlug: typeof task.roleSlug === 'string' ? task.roleSlug : null,
    delegation: task.delegation, context: task.context,
  }).catch(() => null);
}
