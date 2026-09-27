/**
 * The MCP next-call inbox (docs/design/subscriptions-and-notifications.md →
 * MCP sessions, layer 1). An interactive MCP session cannot receive a push,
 * so every `buildd` tool result for an owner with fired watches gets a short
 * notices block appended: at most INBOX_SHOWN, newest first, with a count of
 * the rest. Each shown row is closed with `markDelivered(route: 'mcp')` on
 * the same call, and only rows this call won are shown, so a row appears in
 * exactly one tool result.
 *
 * Same shape as the worker-message queue on `update_progress`
 * (packages/core/mcp-tools.ts, `pendingMessages`): render into the result the
 * agent is about to read, then ack. It reads the ledger instead of
 * `tasks.context`, so it is not capped by a JSON blob.
 *
 * The owner is the account behind the token (`{ accountId }`, the
 * foundation's MCP-session owner). Never throws: any error leaves the result
 * as it was and the rows pending.
 */

import type { ToolResult } from '@buildd/core/mcp-tools';
import { listUndelivered, markDelivered, type SubscriptionOwner, type UndeliveredRow } from './subscriptions';
import { watchNotice } from './watch-notice';

export const INBOX_SHOWN = 3;

export interface InboxDeps {
  listUndelivered: typeof listUndelivered;
  markDelivered: typeof markDelivered;
}

const DEFAULT_DEPS: InboxDeps = { listUndelivered, markDelivered };

function line(r: UndeliveredRow): string {
  const n = watchNotice(r);
  const link = n.watch.href ? ` ${n.watch.href.startsWith('/') ? `(buildd ${n.watch.href})` : n.watch.href}` : '';
  return `- ${n.text}${n.watch.detail ? ` ${n.watch.detail}.` : ''}${link}`;
}

export async function withNotificationInbox<T extends ToolResult>(
  result: T,
  owner: SubscriptionOwner | null | undefined,
  deps: InboxDeps = DEFAULT_DEPS,
): Promise<T> {
  if (!owner || !result || !Array.isArray(result.content)) return result;
  try {
    const pending = await deps.listUndelivered(owner, { limit: 50 });
    if (pending.length === 0) return result;
    // A one-shot watch fires once: its oldest pending row stands for it, and
    // the claim in markDelivered coalesces the rest.
    const seen = new Set<string>();
    const candidates = pending.filter(r => {
      if (r.lifetime !== 'one_shot') return true;
      if (seen.has(r.subscriptionId)) return false;
      seen.add(r.subscriptionId);
      return true;
    });
    const newestFirst = [...candidates].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const shown: UndeliveredRow[] = [];
    for (const r of newestFirst.slice(0, INBOX_SHOWN)) {
      const m = await deps.markDelivered(owner, r.id, { route: 'mcp' });
      if (m.marked) shown.push(r);
    }
    if (shown.length === 0) return result;
    const rest = newestFirst.length - Math.min(newestFirst.length, INBOX_SHOWN);
    const text = [
      `**Notifications** (things you asked to be told about):`,
      ...shown.map(line),
      ...(rest > 0 ? [`(${rest} more waiting; they arrive with your next buildd call.)`] : []),
    ].join('\n');
    return { ...result, content: [...result.content, { type: 'text' as const, text }] };
  } catch (e) {
    console.warn('[mcp] notification inbox skipped:', e);
    return result;
  }
}
