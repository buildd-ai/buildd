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
import { createPolicyPageLedger, POLICY_RAILS, policyDigestLine, type PolicyPageEvent, type PolicyRail } from '@buildd/core/policy-digest';

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

/** The gate's verdicts for a PR, or null when they cannot be read (which pages). Never throws. */
export async function loadEscalationVerdicts(subject: { workspaceId: string; prNumber: number }, deps: EscalationPageDeps = {}): Promise<EscalationVerdict[] | null> {
  try {
    return await (deps.loadVerdicts ?? defaultLoadVerdicts)(subject.workspaceId, subject.prNumber);
  } catch {
    return null;
  }
}

/** Never throws; any failure pages. */
export async function mayPageEscalation(subject: { workspaceId: string; prNumber: number }, deps: EscalationPageDeps = {}): Promise<boolean> {
  try {
    return verdictsAllowPage(await (deps.loadVerdicts ?? defaultLoadVerdicts)(subject.workspaceId, subject.prNumber));
  } catch {
    return true;
  }
}

export type EscalationPagePlan = { action: 'send' } | { action: 'skip' } | { action: 'digest'; count: number; kind: PolicyRail };

/** One ledger per instance: policy pages of a kind batch into a digest and a repeat sends once. */
export const policyPageLedger = createPolicyPageLedger();

const policyKind = (verdicts: readonly EscalationVerdict[]): PolicyRail | null => {
  for (const v of verdicts) {
    if (v.owner === 'person' && v.rail && (POLICY_RAILS as readonly string[]).includes(v.rail)) return v.rail as PolicyRail;
  }
  return null;
};

/**
 * How a page that already passed the gate reaches the owner. Only a person's
 * policy rail batches; every other page is sent as before. Never throws.
 */
export function planEscalationPage(
  e: { teamId: string; workspaceId: string; prNumber: number; verdicts: readonly EscalationVerdict[] },
  ledger: Pick<ReturnType<typeof createPolicyPageLedger>, 'plan'> = policyPageLedger,
): EscalationPagePlan {
  try {
    const kind = policyKind(e.verdicts);
    if (!kind) return { action: 'send' };
    const event: PolicyPageEvent = {
      teamId: e.teamId, kind, subjectKey: `pr:${e.workspaceId}:${e.prNumber}`,
      fingerprint: e.verdicts.map(v => `${v.owner}|${v.owner === 'person' ? v.rail ?? '' : ''}|${v.reason}`).join(';'),
    };
    const plan = ledger.plan(event);
    return plan.action === 'digest' ? { action: 'digest', count: plan.count, kind } : plan;
  } catch {
    return { action: 'send' };
  }
}

/** The page text for a digest. */
export const escalationDigestLine = policyDigestLine;
