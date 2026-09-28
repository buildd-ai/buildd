/**
 * GET /api/prs/escalation-inbox
 *
 * Returns PRs requiring human action for the escalation inbox (BT-15).
 * Includes:
 * - PRs where the reviewer escalated (reviewer_escalated mission_note exists)
 * - PRs where the agent approved under approve-only gate (reviewer_approved note)
 * - PRs where workspace merge policy tier = 'human'
 *
 * Excludes:
 * - PRs currently held under an active agent-review lease (agent_reviewing)
 *
 * Auth: session user.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserWorkspaceIds } from '@/lib/team-access';
import { resolvePolicy } from '@/lib/merge-policy';
import { DEFAULT_MAX_CONFLICT_ITERATIONS } from '@/lib/conflict-retry';
import { loadPrAttention } from '@/lib/pr-attention';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const wsIds = await getUserWorkspaceIds(user.id);
  if (wsIds.length === 0) {
    return NextResponse.json({ items: [], count: 0 });
  }

  const {
    openPrWorkers, isInInbox, escalationMap, approvalMap, wsMap, conflictRetryMap, deadZoneExhaustedMap,
  } = await loadPrAttention(wsIds);
  if (openPrWorkers.length === 0) {
    return NextResponse.json({ items: [], count: 0 });
  }

  const items = openPrWorkers
    .filter(isInInbox)
    .map(w => {
      const ws = wsMap.get(w.workspaceId);
      const escalation = w.taskId ? escalationMap.get(w.taskId) : undefined;
      const approval = w.taskId ? approvalMap.get(w.taskId) : undefined;
      const policy = ws ? resolvePolicy(ws) : { tier: 'auto-threshold' as const };
      const waitingMinutes = w.completedAt
        ? Math.round((Date.now() - new Date(w.completedAt).getTime()) / 60000)
        : null;

      const conflictRetry = w.prNumber != null ? conflictRetryMap.get(`${w.workspaceId}:${w.prNumber}`) : undefined;
      const deadZoneInfo = deadZoneExhaustedMap.get(w.id);

      const leaseState: 'agent_approved' | 'agent_flagged' | 'pending_human' =
        approval ? 'agent_approved'
        : escalation ? 'agent_flagged'
        : 'pending_human';

      return {
        workerId: w.id,
        taskId: w.taskId,
        taskTitle: (w.task as any)?.title ?? '',
        missionId: (w.task as any)?.missionId ?? null,
        workspaceId: w.workspaceId,
        workspaceName: ws?.name ?? '',
        prNumber: w.prNumber,
        prUrl: w.prUrl,
        policyTier: policy.tier,
        leaseState,
        escalationReason: deadZoneInfo
          ? `Agents failed ${DEFAULT_MAX_CONFLICT_ITERATIONS} conflict-resolution attempts. Resolve the conflict yourself.`
          : (escalation?.reason ?? (policy.tier === 'human' ? 'Human Gate policy: merge this PR yourself.' : null)),
        verdictSummary: approval?.summary ?? null,
        waitingMinutes,
        // Conflict retry fields — present when an agent is actively resolving conflicts
        conflictRetryTaskId: conflictRetry?.taskId ?? null,
        conflictRetryIteration: conflictRetry?.iteration ?? null,
        // Dead zone fields — present when retries are exhausted (BLOCKED card)
        deadZoneExhausted: !!deadZoneInfo,
        deadZoneLastRetryTaskId: deadZoneInfo?.lastRetryTaskId ?? null,
      };
    });

  return NextResponse.json({ items, count: items.length });
}
