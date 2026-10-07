/**
 * The reviews module's answer to the workflow kernel's approved-merge slot
 * (`ApprovedMergeRule` in lib/workflow/delivery-view.ts), wired by the
 * composition root (`apps/web/src/modules.ts` `APPROVED_MERGE_RULE`).
 *
 * Pure: does an APPROVED delivery wait on a person rather than the landing
 * path? The rule Home uses, from the effective merge policy for that PR: the
 * tier is `human` (a task or mission that requires review, or the mission PR
 * gate), or `agent-review` with gateCondition `approve-only`, or a landing
 * handoff (the escalate path) is open at the current head. `auto-threshold`
 * (including a task PR into its mission integration branch) and
 * approve-and-merge land without a person.
 */
import { resolvePolicy } from '@/lib/merge-policy';
import { landingModeOf, resolveLandingOwnership } from '@/lib/pr-landing-ownership';
import type { ApprovedMergeRule } from '@/lib/workflow/delivery-view';

type J = Record<string, unknown>;

export const approvedNeedsPerson: ApprovedMergeRule = (row: J): boolean => {
  const d = row.delivery as J | null;
  if (!d) return false;
  const ws = (row.workspace as J | null) ?? {};
  const ot = (row.owner_task as J | null) ?? {};
  const m = ot.mission as J | null | undefined;
  const policy = resolvePolicy(
    { gitConfig: (ws.git_config as never) ?? null },
    m ? {
      mergePolicy: (m.merge_policy as never) ?? null,
      requiresReview: m.requires_review === true,
      workingBranch: m.working_branch == null ? null : String(m.working_branch),
      integrationBranchEnabled: m.integration_branch_enabled === true,
    } : null,
    { requiresReview: ot.requires_review === true },
    { baseRef: d.base_ref == null ? null : String(d.base_ref) },
  );
  if (policy.tier === 'human') return true;
  if (policy.tier === 'agent-review' && policy.agentReview?.gateCondition === 'approve-only') return true;
  if (d.pr_number == null) return false;
  return resolveLandingOwnership({
    policy,
    landingMode: landingModeOf(ws.git_config as never),
    landing: ot.landing ?? null,
    handoff: ot.landing_handoff ?? null,
    prNumber: Number(d.pr_number),
    prHeadSha: d.current_head_sha == null ? null : String(d.current_head_sha),
  }).owner === 'human';
};
