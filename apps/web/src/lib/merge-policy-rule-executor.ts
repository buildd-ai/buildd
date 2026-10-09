/**
 * The escalation gate's rule verdicts that need a hand (task a90fc99b).
 *
 * Most Buildd-owned rule verdicts name a step the kernel or landing already
 * takes on its own sweep (CI fix, conflict repair, renumber, the treadmill
 * restart). One does not: `policy_merge`, a policy-only escalation whose gates
 * all hold. This runs it, rule-only (Jev never merges), and only where the
 * workspace merge policy lets the platform land: a `human` tier, or an
 * agent-review policy set to approve-only, keeps the person's merge.
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import type { EscalationAction } from '@buildd/core/escalation-gate';
import type { MergePolicy } from '@buildd/shared';
import type { GatedSubject } from './escalation-gate-check';
import { parseMergePolicyRead } from './merge-policy';

export interface RuleExecutorDeps {
  loadPolicy?: (workspaceId: string) => Promise<Pick<MergePolicy, 'tier' | 'agentReview'> | null>;
  policyMerge?: (p: { workspaceId: string; prNumber: number; headSha: string; reason: string }) => Promise<unknown>;
}

/** May the platform land a PR in this workspace once it is approved? */
export function policyAllowsRuleMerge(policy: Pick<MergePolicy, 'tier' | 'agentReview'> | null): boolean {
  if (!policy || policy.tier === 'human') return false;
  return !(policy.tier === 'agent-review' && policy.agentReview?.gateCondition === 'approve-only');
}

async function defaultLoadPolicy(workspaceId: string): Promise<Pick<MergePolicy, 'tier' | 'agentReview'> | null> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { gitConfig: true } });
  if (!ws) return null;
  return parseMergePolicyRead((ws.gitConfig as { mergePolicy?: unknown } | null)?.mergePolicy);
}

export function escalationRuleExecutor(deps: RuleExecutorDeps = {}) {
  return async (s: GatedSubject, action: EscalationAction): Promise<void> => {
    if (action !== 'policy_merge' || s.prNumber == null || !s.headSha) return;
    const policy = await (deps.loadPolicy ?? defaultLoadPolicy)(s.workspaceId);
    if (!policyAllowsRuleMerge(policy)) return;
    const merge = deps.policyMerge ?? (await import('./workflow/seam')).policyMergeThroughKernel;
    await merge({
      workspaceId: s.workspaceId, prNumber: s.prNumber, headSha: s.headSha,
      reason: 'policy-only escalation; CI green on the reviewed head, not a draft, not XL, risk classes that landed cleanly',
    });
  };
}
