/**
 * Approval cards for chat writes, ported from buildd's
 * `apps/web/src/lib/chat/approvals.ts`.
 *
 * The approval card is consent on top of authorization. It is checked on the
 * server when the answer arrives: the approval id, the hash of the tool input
 * as proposed, and the approving user must all match what was stored, and the
 * row must still be pending. The decision is the store's one atomic
 * compare-and-set (`ChatStore.decideApproval`), so exactly one request wins; a
 * replayed, concurrent or edited approval decides nothing and executes nothing.
 *
 * Pure apart from the injected `decide`. Hashing uses WebCrypto, so this runs
 * on Node, Bun and edge runtimes. `hashToolInput` is byte-identical to
 * buildd's (sha256 hex of `canonicalJson`), so hashes stored by one verify in
 * the other.
 */

import { isToolPart, parseApprovalPreview, toolNameOf, type ApprovalPreview, type ChatPart, type ChatToolPart } from '@builddai/ai-kit/chat/contract';

/** Deterministic JSON: object keys sorted at every depth, `undefined` fields dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 hex of `canonicalJson(input)`. */
export async function hashToolInput(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A pending approval request, as the store records it. */
export interface ApprovalRequestRow {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  inputHash: string;
}

/** Pending approval requests in an assistant message, as rows to record. */
export async function approvalRequestsIn(parts: readonly ChatPart[]): Promise<ApprovalRequestRow[]> {
  const pending = parts.filter(isToolPart).filter(p => p.state === 'approval-requested' && p.approval?.id);
  return Promise.all(pending.map(async p => ({
    approvalId: p.approval!.id,
    toolCallId: p.toolCallId,
    toolName: toolNameOf(p),
    inputHash: await hashToolInput(p.input),
  })));
}

/** The atomic decision. True only for the one request whose compare-and-set matched. */
export type DecideApprovalFn = (args: { approvalId: string; inputHash: string; approved: boolean }) => Promise<boolean>;

export interface ReconcileResult {
  /** The stored parts with every approval this request won set to `approval-responded`. */
  parts: ChatPart[];
  /** Tool calls this request may execute (approved and won). */
  authorizedToolCallIds: Set<string>;
  /** How many approvals this request decided (approved or denied). */
  decided: number;
  /** The server-built preview each authorized call was approved against. */
  approvedPreviews: Map<string, ApprovalPreview>;
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
  stored: readonly ChatPart[],
  incoming: readonly ChatPart[],
  decide: DecideApprovalFn,
): Promise<ReconcileResult> {
  const answers = new Map<string, ChatToolPart>();
  for (const p of incoming) {
    if (isToolPart(p) && p.state === 'approval-responded' && p.approval?.id && typeof p.approval.approved === 'boolean') {
      answers.set(p.approval.id, p);
    }
  }

  const authorizedToolCallIds = new Set<string>();
  const approvedPreviews = new Map<string, ApprovalPreview>();
  let decided = 0;
  const parts: ChatPart[] = [];
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
    const inputHash = await hashToolInput(part.input);
    if (answer.input !== undefined && await hashToolInput(answer.input) !== inputHash) {
      // Edited proposal: the person approved something other than what was proposed.
      parts.push(part);
      continue;
    }
    const approved = answer.approval!.approved === true;
    // The preview the server stored with the request (never the client's copy).
    const preview = parseApprovalPreview(part.approval.requestReason);
    if (approved && preview?.confirmText) {
      // Admin writes: the person typed the target's name. A missing or wrong
      // name decides nothing; the card stays open.
      if (String(answer.approval?.reason ?? '').trim() !== preview.confirmText.trim()) {
        parts.push(part);
        continue;
      }
    }
    const won = await decide({ approvalId: part.approval.id, inputHash, approved });
    if (!won) {
      parts.push(part);
      continue;
    }
    decided++;
    if (approved) {
      authorizedToolCallIds.add(part.toolCallId);
      if (preview) approvedPreviews.set(part.toolCallId, preview);
    }
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
  return { parts, authorizedToolCallIds, approvedPreviews, decided };
}

/**
 * Does the preview rebuilt at execution time describe the same write the
 * person approved? Same target, the same before-state fingerprint, and the
 * same rewritten fields (what runs is what the card showed).
 */
export function previewMatches(approved: ApprovalPreview, now: ApprovalPreview): boolean {
  return approved.target.kind === now.target.kind
    && approved.target.id === now.target.id
    && approved.fingerprint === now.fingerprint
    && JSON.stringify(approved.resolved ?? []) === JSON.stringify(now.resolved ?? []);
}
