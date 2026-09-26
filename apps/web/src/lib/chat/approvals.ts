/**
 * Approval cards for chat writes (docs/design/agent-chat.md → Tools and permissions).
 *
 * The approval card is consent on top of authorization. It's checked on the
 * server when the answer arrives: the approval id, the hash of the tool input
 * as proposed, and the approving user must all match what was stored, and the
 * row must still be pending. The decision is one atomic
 * `UPDATE … WHERE status = 'pending' RETURNING` (no db.transaction on
 * neon-http), so exactly one request wins; a replayed, concurrent or edited
 * approval decides nothing and executes nothing.
 */

import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { conversationApprovals } from '@buildd/core/db/schema';
import type { ChatMessagePart } from '@buildd/shared';

/** Deterministic JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

type ToolPart = ChatMessagePart & {
  toolCallId: string;
  state: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean; reason?: string };
};

export function isToolPart(part: ChatMessagePart): part is ToolPart {
  return typeof part.type === 'string' && part.type.startsWith('tool-') && typeof (part as ToolPart).toolCallId === 'string';
}

export function toolNameOf(part: { type: string }): string {
  return part.type.slice('tool-'.length);
}

/** Pending approval requests in an assistant message, as rows to record. */
export function approvalRequestsIn(parts: ChatMessagePart[]): Array<{
  approvalId: string; toolCallId: string; toolName: string; inputHash: string;
}> {
  return parts
    .filter(isToolPart)
    .filter(p => p.state === 'approval-requested' && p.approval?.id)
    .map(p => ({
      approvalId: p.approval!.id,
      toolCallId: p.toolCallId,
      toolName: toolNameOf(p),
      inputHash: hashToolInput(p.input),
    }));
}

export type DecideFn = (args: {
  approvalId: string;
  inputHash: string;
  approved: boolean;
}) => Promise<boolean>;

export interface ReconcileResult {
  /** The stored parts with every approval this request won set to `approval-responded`. */
  parts: ChatMessagePart[];
  /** Tool calls this request is allowed to execute (approved and won). */
  authorizedToolCallIds: Set<string>;
  /** How many approvals this request decided (approved or denied). */
  decided: number;
}

/**
 * Apply the client's approval answers to the STORED assistant message.
 *
 * The stored parts are the truth: the client's copy only contributes the
 * answer (approved or not) for an approval id. Its input is hashed only to
 * reject an edited proposal. A part that isn't pending in storage, or an
 * approval this request didn't win, is left exactly as stored.
 */
export async function reconcileApprovals(
  stored: ChatMessagePart[],
  incoming: ChatMessagePart[],
  decide: DecideFn,
): Promise<ReconcileResult> {
  const answers = new Map<string, ToolPart>();
  for (const p of incoming) {
    if (isToolPart(p) && p.state === 'approval-responded' && p.approval?.id && typeof p.approval.approved === 'boolean') {
      answers.set(p.approval.id, p);
    }
  }

  const authorizedToolCallIds = new Set<string>();
  let decided = 0;
  const parts: ChatMessagePart[] = [];
  for (const part of stored) {
    if (!isToolPart(part) || part.state !== 'approval-requested' || !part.approval?.id) {
      parts.push(part);
      continue;
    }
    const answer = answers.get(part.approval.id);
    if (!answer || answer.toolCallId !== part.toolCallId) {
      parts.push(part);
      continue;
    }
    const inputHash = hashToolInput(part.input);
    if (answer.input !== undefined && hashToolInput(answer.input) !== inputHash) {
      // Edited proposal: the user approved something other than what was proposed.
      parts.push(part);
      continue;
    }
    const approved = answer.approval!.approved === true;
    const won = await decide({ approvalId: part.approval.id, inputHash, approved });
    if (!won) {
      parts.push(part);
      continue;
    }
    decided++;
    if (approved) authorizedToolCallIds.add(part.toolCallId);
    parts.push({
      ...part,
      state: 'approval-responded',
      approval: {
        ...part.approval,
        approved,
        ...(answer.approval?.reason ? { reason: String(answer.approval.reason).slice(0, 500) } : {}),
      },
    });
  }
  return { parts, authorizedToolCallIds, decided };
}

// ── DB ────────────────────────────────────────────────────────────────────────

export async function recordApprovalRequests(args: {
  conversationId: string;
  messageId: string;
  userId: string;
  parts: ChatMessagePart[];
}): Promise<void> {
  const rows = approvalRequestsIn(args.parts);
  if (rows.length === 0) return;
  await db.insert(conversationApprovals)
    .values(rows.map(r => ({
      ...r,
      conversationId: args.conversationId,
      messageId: args.messageId,
      proposedForUserId: args.userId,
    })))
    .onConflictDoNothing({ target: conversationApprovals.approvalId });
}

/** The atomic decision. True only for the one request whose UPDATE matched. */
export function dbDecide(conversationId: string, userId: string): DecideFn {
  return async ({ approvalId, inputHash, approved }) => {
    const rows = await db.update(conversationApprovals)
      .set({ status: approved ? 'approved' : 'denied', decidedAt: new Date() })
      .where(and(
        eq(conversationApprovals.approvalId, approvalId),
        eq(conversationApprovals.conversationId, conversationId),
        eq(conversationApprovals.proposedForUserId, userId),
        eq(conversationApprovals.inputHash, inputHash),
        eq(conversationApprovals.status, 'pending'),
      ))
      .returning({ id: conversationApprovals.id });
    return rows.length > 0;
  };
}

export async function storeApprovalResult(toolCallId: string, conversationId: string, result: unknown): Promise<void> {
  await db.update(conversationApprovals)
    .set({ result: result as never })
    .where(and(
      eq(conversationApprovals.toolCallId, toolCallId),
      eq(conversationApprovals.conversationId, conversationId),
      eq(conversationApprovals.status, 'approved'),
    ));
}
