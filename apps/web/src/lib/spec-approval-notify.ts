/**
 * The approval-request push (Living Spec b7fc9316 R-10): when an approval is
 * asked for over MCP or chat, the confirm link goes to the people who may
 * approve that spec, and nobody else.
 *
 * Who: lib/specs/approval-inbox.ts specApproverIds, the same rule the confirm
 * step applies (an owner or admin of the workspace's team, or a delegated
 * approver). Where: each one's own Pushover key (lib/personal-pushover.ts),
 * never the team channel, which usually reaches the whole team. A person
 * with no key of their own gets no push; the request still waits for them in
 * the inbox and on Home's Needs you.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { specApproverIds } from '@/lib/specs/approval-inbox';
import { loadPersonalPushoverKey, personalSenderToken, sendPushoverMessage, type PushoverMessage } from '@/lib/personal-pushover';

export interface SpecApprovalPush {
  workspaceId: string;
  title: string;
  revision: number;
  confirmUrl: string;
  warnings: number;
}

export interface SpecApprovalNotifyDeps {
  approvers: (workspaceId: string) => Promise<string[]>;
  teamOf: (workspaceId: string) => Promise<string | null>;
  keyOf: (userId: string, teamId: string) => Promise<string | null>;
  send: (m: PushoverMessage) => Promise<unknown>;
  senderToken: () => string | null;
}

const defaultDeps: SpecApprovalNotifyDeps = {
  approvers: specApproverIds,
  teamOf: async (workspaceId) => {
    const r = await db.execute(sql`SELECT team_id FROM workspaces WHERE id = ${workspaceId}::uuid`) as unknown as { rows?: Array<{ team_id: string }> };
    return r.rows?.[0]?.team_id ?? null;
  },
  keyOf: loadPersonalPushoverKey,
  send: m => sendPushoverMessage(m),
  senderToken: () => personalSenderToken(),
};

/** Push the request to each approver's own key; returns the user ids it was sent to. */
export async function notifySpecApprovers(e: SpecApprovalPush, deps: SpecApprovalNotifyDeps = defaultDeps): Promise<string[]> {
  const token = deps.senderToken();
  if (!token) return [];
  const [teamId, approvers] = await Promise.all([deps.teamOf(e.workspaceId), deps.approvers(e.workspaceId)]);
  if (!teamId || !approvers.length) return [];
  const message = {
    title: `Approve "${e.title}"?`,
    message: `Revision ${e.revision} is waiting for your approval.${e.warnings ? ` ${e.warnings} ${e.warnings === 1 ? 'thing' : 'things'} to look at.` : ''}`,
    url: e.confirmUrl,
    urlTitle: 'Review and approve',
    priority: 0 as const,
  };
  const sent: string[] = [];
  await Promise.all(approvers.map(async (userId) => {
    const user = await deps.keyOf(userId, teamId).catch(() => null);
    if (!user) return;
    await deps.send({ token, user, ...message });
    sent.push(userId);
  }));
  return sent;
}
