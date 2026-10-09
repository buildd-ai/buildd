/**
 * Whether a PR escalation push may page the owner (lib/notify.ts
 * `notifyTeamOf`, event `needsAttention`, with a `prNumber`). The escalation
 * gate already decided who owns the PR's next move for the inbox; a push
 * follows the same verdict, so the owner is never paged for a PR the inbox
 * says Buildd is handling.
 *
 * The push is the state change, so this is where the look happens
 * (`decide: true`): Jev is asked here, after the event, never on a page load.
 *
 * Fails toward paging: no verdict (the PR is not an inbox candidate yet, the
 * read failed, the gate did not run) pages exactly as before.
 */
import type { EscalationVerdict } from '@buildd/core/escalation-gate';

/** Pages unless every verdict for the PR names Buildd. Pure. */
export function verdictsAllowPage(verdicts: readonly EscalationVerdict[]): boolean {
  if (verdicts.length === 0) return true;
  return verdicts.some(v => v.owner === 'person');
}

export interface EscalationPageDeps {
  /** The gate's verdicts for this PR's workers. */
  loadVerdicts?: (workspaceId: string, prNumber: number) => Promise<EscalationVerdict[]>;
}

async function defaultLoadVerdicts(workspaceId: string, prNumber: number): Promise<EscalationVerdict[]> {
  const { loadPrAttention } = await import('./pr-attention');
  const attention = await loadPrAttention([workspaceId], { prNumbers: [prNumber], gate: { decide: true, enqueue: undefined } });
  return attention.openPrWorkers.flatMap(w => {
    const v = attention.gateVerdicts.get(w.id);
    return v ? [v] : [];
  });
}

/** Never throws; any failure pages. */
export async function mayPageEscalation(subject: { workspaceId: string; prNumber: number }, deps: EscalationPageDeps = {}): Promise<boolean> {
  try {
    return verdictsAllowPage(await (deps.loadVerdicts ?? defaultLoadVerdicts)(subject.workspaceId, subject.prNumber));
  } catch {
    return true;
  }
}
