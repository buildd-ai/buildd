/**
 * Declared access nobody granted, as the one `WaitingReason` every surface
 * reads (queue wait, Start probe). The need is decided by the claim gate's own
 * check (`checkAccessGate`), so a page cannot disagree with the gate: this
 * file only words it and points at the grant UI.
 *
 * The connectors module is reached through its composition-root slot
 * (`FILED_ACCESS` in modules.ts), never imported: core never imports a module
 * (scripts/module-boundaries.test.ts).
 */
import { makeWaitingReason, type WaitingReason } from '@buildd/core/waiting-reason';
import { readAccessNeeds, type TaskAccessNeed } from '@buildd/core/token-delegation';

export interface AccessGap {
  gaps: TaskAccessNeed[];
  detail: string;
  /** What to approve, worded for a person ("Axiom read"). */
  label: string;
  /** The task page's grant UI. */
  href: string;
}

/** One reason for the access needs nobody granted: a person approves it on the task page. Pure. */
export function accessReasons(taskId: string, gap: AccessGap | null | undefined): WaitingReason[] {
  if (!gap || gap.gaps.length === 0) return [];
  return [makeWaitingReason('access_unmet', {
    because: `it was filed needing ${gap.label} and nobody has approved it`,
    blocker: { type: 'provider', id: taskId, label: gap.label, href: gap.href },
    provenance: { source: 'probe', derivedFrom: 'checkAccessGate (claim loop)' },
  })];
}

/** The gate's verdict for one task, or null when it declares no access, is covered, or the read failed. */
export async function loadAccessGap(task: { id: string; workspaceId: string; roleSlug?: unknown; delegation?: unknown; context?: unknown }): Promise<AccessGap | null> {
  if (readAccessNeeds(task.context).length === 0) return null;
  try {
    const { FILED_ACCESS } = await import('@/modules');
    const verdict = await FILED_ACCESS.checkGate({
      id: task.id, workspaceId: task.workspaceId, roleSlug: typeof task.roleSlug === 'string' ? task.roleSlug : null,
      delegation: task.delegation, context: task.context,
    });
    if (!verdict) return null;
    const names = await Promise.all(verdict.gaps.map(async g => `${await FILED_ACCESS.providerName(g.provider)} ${g.access}`));
    return { ...verdict, label: names.join(', '), href: await FILED_ACCESS.href(task.id) };
  } catch {
    return null;
  }
}
