/**
 * The persistence adapter a chat app implements. The kit never touches a
 * database: every read and write of messages, approvals and hand-off links
 * goes through this interface. `schema.sql` (shipped with the package) is a
 * reference layout; each app migrates its own DB with its own tool.
 *
 * `memoryChatStore()` implements it in memory, for tests and prototypes.
 */

import type { ChatMessage, ChatPart, ChatUsage } from '@builddai/ai-kit/chat/contract';
import type { ApprovalRequestRow } from './approvals';

/** A message as the store keeps it: the wire message plus turn bookkeeping. */
export interface StoredMessage extends ChatMessage {
  parts: ChatPart[];
  /** ISO 8601. Set by the store when omitted. */
  createdAt?: string;
  /** Who sent a user message. */
  authorUserId?: string | null;
  /** Assistant turns: the tier and model id the turn ran on. */
  tier?: string | null;
  model?: string | null;
  /** Assistant turns: tokens, cost and latency (summed across approval continuations). */
  usage?: ChatUsage | null;
}

export interface ChatStore {
  /**
   * The conversation's messages, oldest first: the newest `limit` of them.
   * Returning exactly `limit` rows tells the kit older ones may exist (the
   * Allow taint rule then assumes tool output is in the conversation).
   */
  loadMessages(conversationId: string, opts: { limit: number }): Promise<StoredMessage[]>;
  /** Insert the message, or replace the stored one with the same id (upsert). */
  saveMessage(conversationId: string, message: StoredMessage): Promise<void>;
  /**
   * Record approval requests shown in a saved assistant message, as `pending`,
   * for `userId` (the only person who may answer them). Idempotent on
   * `approvalId`.
   */
  recordApprovals(args: { conversationId: string; messageId: string; userId: string; rows: ApprovalRequestRow[] }): Promise<void>;
  /**
   * The atomic decision: set the row to approved/denied only if it is still
   * `pending` and its conversation, user and input hash match. True only for
   * the one caller whose compare-and-set matched (`UPDATE … WHERE status =
   * 'pending' … RETURNING`).
   */
  decideApproval(args: { conversationId: string; userId: string; approvalId: string; inputHash: string; approved: boolean }): Promise<boolean>;
  /** Optional: keep an approved write's result next to its approval row. */
  storeApprovalResult?(args: { conversationId: string; toolCallId: string; result: unknown }): Promise<void>;
  /**
   * Optional: a tool filed a long-running task from this conversation. Store
   * the link so the app's completion webhook can append the result here
   * (`handoffEventMessage`).
   */
  linkHandoff?(args: { conversationId: string; messageId: string | null; toolCallId: string; taskId: string; url: string }): Promise<void>;
}

/** An in-memory `ChatStore`, for tests and prototypes. Not for production: nothing survives a restart. */
export function memoryChatStore(): ChatStore & {
  readonly messages: Map<string, StoredMessage[]>;
  readonly approvals: Array<ApprovalRequestRow & { conversationId: string; messageId: string; userId: string; status: 'pending' | 'approved' | 'denied'; result?: unknown }>;
  readonly handoffs: Array<{ conversationId: string; messageId: string | null; toolCallId: string; taskId: string; url: string }>;
} {
  const messages = new Map<string, StoredMessage[]>();
  const approvals: Array<ApprovalRequestRow & { conversationId: string; messageId: string; userId: string; status: 'pending' | 'approved' | 'denied'; result?: unknown }> = [];
  const handoffs: Array<{ conversationId: string; messageId: string | null; toolCallId: string; taskId: string; url: string }> = [];
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    messages,
    approvals,
    handoffs,
    async loadMessages(conversationId, { limit }) {
      return clone((messages.get(conversationId) ?? []).slice(-limit));
    },
    async saveMessage(conversationId, message) {
      const list = messages.get(conversationId) ?? [];
      const row = clone({ createdAt: new Date().toISOString(), ...message });
      const i = list.findIndex(m => m.id === message.id);
      if (i >= 0) list[i] = { ...row, createdAt: list[i].createdAt };
      else list.push(row);
      messages.set(conversationId, list);
    },
    async recordApprovals({ conversationId, messageId, userId, rows }) {
      for (const r of rows) {
        if (!approvals.some(a => a.approvalId === r.approvalId)) approvals.push({ ...r, conversationId, messageId, userId, status: 'pending' });
      }
    },
    async decideApproval({ conversationId, userId, approvalId, inputHash, approved }) {
      const a = approvals.find(x => x.approvalId === approvalId);
      if (!a || a.status !== 'pending' || a.conversationId !== conversationId || a.userId !== userId || a.inputHash !== inputHash) return false;
      a.status = approved ? 'approved' : 'denied';
      return true;
    },
    async storeApprovalResult({ conversationId, toolCallId, result }) {
      const a = approvals.find(x => x.toolCallId === toolCallId && x.conversationId === conversationId && x.status === 'approved');
      if (a) a.result = result;
    },
    async linkHandoff(link) {
      handoffs.push({ ...link });
    },
  };
}
