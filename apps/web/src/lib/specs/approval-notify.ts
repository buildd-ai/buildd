import type { SpecGateResult } from '@buildd/core/db/schema';

/**
 * The notification that brings a spec approval to the person: sent once per
 * request made over MCP or chat, to the team's own channel (Pushover or
 * webhook, and so Home's push). It opens the confirm page; it approves nothing.
 */
export interface ApprovalRequestedNotice {
  workspaceId: string;
  title: string;
  revision: number;
  confirmUrl: string;
  gate: SpecGateResult;
}

export async function notifyApprovalRequested(n: ApprovalRequestedNotice): Promise<void> {
  const { notifyTeamOf } = await import('@/lib/notify');
  const warn = n.gate.warnings.length;
  await notifyTeamOf({ workspaceId: n.workspaceId }, 'needsAttention', {
    title: `Approve "${n.title}"?`,
    message: `Revision ${n.revision} is waiting for your approval.${warn ? ` ${warn} ${warn === 1 ? 'thing' : 'things'} to look at.` : ''}`,
    url: n.confirmUrl,
    urlTitle: 'Review and approve',
    priority: 0,
  });
}
