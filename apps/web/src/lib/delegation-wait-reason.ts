/**
 * Cross-workspace reach (a delegation) nobody granted, as the one
 * `WaitingReason` every surface reads (queue wait, Start probe). The need is
 * decided by the claim gate's own rules (`checkDelegationGate` →
 * `preflightTaskDelegation`), read here without the claiming account
 * (`personDelegationGaps`): what is left is what only a person can fix, so the
 * page cannot say queued while the gate holds it, or held once it is granted.
 *
 * A gap only one runner account has (`out_of_token_reach`) is not a person's:
 * it stays the ledger's "no runner can take it" (lib/queue-wait-load.ts).
 */
import { makeWaitingReason, type WaitingReason } from '@buildd/core/waiting-reason';
import { readFilingTargets, readScheduleDelegation, type DelegationGap } from '@buildd/core/token-delegation';
export { ledgerDelegationIsPersons } from '@buildd/core/token-delegation';

export interface DelegationGapView {
  gaps: DelegationGap[];
  /** What to grant, worded for a person ("filing tasks in web"). */
  label: string;
  /** Where the person acts: the task page, whose waiting line says how. */
  href: string;
}

const CAPABILITY_WORDS: Record<string, string> = { 'tasks:create': 'filing tasks in', 'analytics:read': 'reading analytics of' };

/** "filing tasks in web, reading analytics of api". Pure. */
export function delegationGapLabel(gaps: readonly DelegationGap[], names: ReadonlyMap<string, string> = new Map()): string {
  const words = gaps.map(g => {
    const ws = names.get(g.workspaceId) ?? 'another workspace';
    const what = `${CAPABILITY_WORDS[g.capability] ?? `${g.capability} on`} ${ws}`;
    return g.reason === 'cross_team' ? `${what} (outside its team: remove it from the delegation)` : what;
  });
  return [...new Set(words)].join(', ');
}

/** One reason for the delegation nobody granted: a person grants it. Pure. */
export function delegationReasons(taskId: string, gap: DelegationGapView | null | undefined): WaitingReason[] {
  if (!gap || gap.gaps.length === 0) return [];
  return [makeWaitingReason('delegation_unmet', {
    because: `it needs ${gap.label} and no delegation grants it; a person who reaches that workspace grants it with update_task { delegation }`,
    blocker: { type: 'config', id: taskId, label: gap.label, href: gap.href },
    provenance: { source: 'probe', derivedFrom: 'checkDelegationGate (claim loop), without the claiming account' },
  })];
}

/** The gate's person-side verdict for one task, or null when it needs no reach, is covered, or the read failed. */
export async function loadDelegationGap(task: { id: string; workspaceId: string; scheduleId?: string | null; delegation?: unknown; context?: unknown }): Promise<DelegationGapView | null> {
  const declares = readFilingTargets(task.context).some(t => t !== task.workspaceId) || readScheduleDelegation(task.delegation).length > 0;
  if (!declares && !task.scheduleId) return null;
  try {
    const { personDelegationGaps } = await import('@/lib/task-delegation-checks');
    const gaps = await personDelegationGaps({ id: task.id, workspaceId: task.workspaceId, scheduleId: task.scheduleId ?? null, delegation: task.delegation, context: task.context });
    if (gaps.length === 0) return null;
    const { db } = await import('@buildd/core/db');
    const { sqlWhereFn } = await import('@buildd/core/db/relational-sql');
    const ids = [...new Set(gaps.map(g => g.workspaceId))];
    const rows = await db.query.workspaces.findMany({
      where: { RAW: sqlWhereFn((w, { inArray }) => inArray(w.id, ids)) },
      columns: { id: true, name: true },
    }).catch(() => [] as Array<{ id: string; name: string | null }>);
    const names = new Map(rows.filter(r => r.name).map(r => [r.id, r.name as string]));
    return { gaps, label: delegationGapLabel(gaps, names), href: `/app/tasks/${encodeURIComponent(task.id)}` };
  } catch {
    return null;
  }
}
