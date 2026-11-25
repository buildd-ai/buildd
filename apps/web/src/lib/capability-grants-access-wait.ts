/**
 * Loader half of access-wait-reason.ts: the claim gate's verdict for one task,
 * with provider display names. Connectors module; core reaches it through
 * `ACCESS_WAIT` in modules.ts.
 */
import { readAccessNeeds } from '@buildd/core/token-delegation';
import { providerName } from '@/lib/capability-grants-view';
import { checkAccessGate } from '@/lib/capability-grants-filed';
import type { AccessGap } from '@/lib/access-wait-reason';

/** The gate's verdict for one task, or null when it declares no access, is covered, or the read failed. */
export async function loadAccessGap(task: { id: string; workspaceId: string; roleSlug?: unknown; delegation?: unknown; context?: unknown }): Promise<AccessGap | null> {
  if (readAccessNeeds(task.context).length === 0) return null;
  const gap = await checkAccessGate({
    id: task.id, workspaceId: task.workspaceId, roleSlug: typeof task.roleSlug === 'string' ? task.roleSlug : null,
    delegation: task.delegation, context: task.context,
  }).catch(() => null);
  if (!gap) return null;
  return { ...gap, label: gap.gaps.map(g => `${providerName(g.provider)} ${g.access}`).join(', ') };
}
