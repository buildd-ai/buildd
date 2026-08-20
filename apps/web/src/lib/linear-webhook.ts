/**
 * Inbound Linear webhook (work-tracker spec §3, Linear half — Phase 3a).
 *
 * A Linear issue that carries the workspace's configured inbound label creates a
 * linked buildd task; closing (or deleting) that issue cancels the linked task if
 * it is still open. Everything here is pure or dependency-injected so the route
 * stays a thin adapter and the logic is unit-testable without module mocking
 * (which bun leaks globally across test files).
 *
 * Scope note: this is the webhook only. The paginated Linear graph *import*
 * (reconcile into initiatives/missions/tasks, cursor, backoff, echo-suppression)
 * is Phase 3b — see docs/plans/linear-phase-3.md.
 */

import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { db as realDb } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import {
  findLinkByExternal as realFindLink,
  linkExternal as realLinkExternal,
} from '@buildd/core/external-links';

type Db = typeof realDb;

/** Terminal task states — a close event must never re-cancel one of these. */
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

/** Linear issue state `type` values that mean the issue is closed. */
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled']);

/** How far a delivery's `webhookTimestamp` may drift from now before we reject it (replay guard). */
export const WEBHOOK_MAX_SKEW_MS = 60_000;

/** Hex-encode an ArrayBuffer (matches lib/github.ts). */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time comparison of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify Linear's HMAC-SHA256 signature over the RAW request body.
 * Linear sends the hex digest in the `linear-signature` header. Returns false on
 * any missing input so a mis-configured delivery fails closed.
 */
export async function verifyLinearSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return timingSafeEqualHex(signature.trim().toLowerCase(), toHex(sig).toLowerCase());
}

/** A parsed, normalized Linear issue event. `ignore` carries no payload. */
export type LinearIssueEvent =
  | { kind: 'label'; issueId: string; issueUrl: string | null; title: string }
  | { kind: 'close'; issueId: string; issueUrl: string | null; title: string }
  | { kind: 'ignore' };

/** Collect label names off a Linear issue `data` object, defensively across payload shapes. */
function collectLabelNames(data: Record<string, any>): string[] {
  const names: string[] = [];
  const labels = data.labels;
  if (Array.isArray(labels)) {
    for (const l of labels) {
      if (typeof l === 'string') names.push(l);
      else if (l && typeof l.name === 'string') names.push(l.name);
    }
  }
  // Some payloads nest the collection under labels.nodes; others send a single label.
  if (labels && Array.isArray(labels.nodes)) {
    for (const l of labels.nodes) if (l && typeof l.name === 'string') names.push(l.name);
  }
  if (data.label && typeof data.label.name === 'string') names.push(data.label.name);
  return names;
}

/**
 * Normalize a raw Linear webhook payload into an actionable issue event.
 *
 * - Non-Issue payloads (Project, Comment, …) and payloads without a data id → `ignore`.
 * - A `remove` action or a state whose `type` is completed/canceled → `close`
 *   (takes precedence: a done issue that also carries the label is not new work).
 * - A `create`/`update` whose current labels include `inboundLabel` → `label`.
 * - Otherwise → `ignore`. Idempotency downstream makes re-fired `label` events safe.
 */
export function parseLinearIssueEvent(
  payload: Record<string, any>,
  inboundLabel: string,
): LinearIssueEvent {
  if (!payload || payload.type !== 'Issue') return { kind: 'ignore' };
  const data = payload.data;
  if (!data || typeof data.id !== 'string') return { kind: 'ignore' };

  const issueId = data.id;
  const issueUrl = typeof data.url === 'string' ? data.url : null;
  const title =
    (typeof data.title === 'string' && data.title) ||
    (typeof data.identifier === 'string' && data.identifier) ||
    'Untitled Linear issue';

  const action = payload.action;
  const stateType = data.state?.type;
  const isClose = action === 'remove' || (typeof stateType === 'string' && CLOSED_STATE_TYPES.has(stateType));
  if (isClose) return { kind: 'close', issueId, issueUrl, title };

  if (action === 'create' || action === 'update') {
    const wanted = inboundLabel.toLowerCase();
    if (collectLabelNames(data).some((n) => n.toLowerCase() === wanted)) {
      return { kind: 'label', issueId, issueUrl, title };
    }
  }
  return { kind: 'ignore' };
}

export interface HandleResult {
  action: 'created' | 'exists' | 'cancelled' | 'noop' | 'ignored';
  taskId?: string;
}

/**
 * Apply a normalized issue event to buildd state. DI'd (`findLink`/`linkExternal`)
 * so tests inject fakes instead of mocking shared modules.
 *
 * - `label`: create one linked task, idempotent on the Linear issue UUID. The
 *   `(provider, externalId)` upsert is the race guard — if it resolves to a
 *   pre-existing link (a concurrent double-delivery won), we delete the loser task.
 * - `close`: cancel the linked task with an ATOMIC guarded UPDATE (never
 *   read-then-write); an already-terminal task is left untouched (0 rows).
 */
export async function handleLinearIssueEvent(
  db: Db,
  ctx: { workspaceId: string; teamId: string },
  event: LinearIssueEvent,
  deps: {
    findLink?: typeof realFindLink;
    linkExternal?: typeof realLinkExternal;
  } = {},
): Promise<HandleResult> {
  const findLink = deps.findLink ?? realFindLink;
  const linkExternal = deps.linkExternal ?? realLinkExternal;

  if (event.kind === 'ignore') return { action: 'ignored' };

  if (event.kind === 'close') {
    const link = await findLink(db, 'linear', event.issueId);
    if (!link || link.builddEntityType !== 'task') return { action: 'ignored' };
    const updated = await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: sql`NOW()` })
      .where(and(eq(tasks.id, link.builddEntityId), notInArray(tasks.status, TERMINAL_TASK_STATUSES)))
      .returning({ id: tasks.id });
    return { action: updated.length ? 'cancelled' : 'noop', taskId: link.builddEntityId };
  }

  // event.kind === 'label'
  const existing = await findLink(db, 'linear', event.issueId);
  if (existing && existing.builddEntityType === 'task') {
    return { action: 'exists', taskId: existing.builddEntityId };
  }

  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: ctx.workspaceId,
      title: event.title,
      description: event.issueUrl ? `Imported from Linear: ${event.issueUrl}` : null,
      externalIssueId: event.issueId,
      externalIssueUrl: event.issueUrl,
      creationSource: 'webhook',
      taskClass: 'work',
    })
    .returning();

  const link = await linkExternal(db, {
    teamId: ctx.teamId,
    provider: 'linear',
    builddEntityType: 'task',
    builddEntityId: task.id,
    externalId: event.issueId,
    externalUrl: event.issueUrl,
  });

  // Concurrent double-delivery: the upsert resolved to a pre-existing link for an
  // earlier task → we lost the race, so drop the task we just created.
  if (link.builddEntityId !== task.id) {
    await db.delete(tasks).where(eq(tasks.id, task.id));
    return { action: 'exists', taskId: link.builddEntityId };
  }

  return { action: 'created', taskId: task.id };
}
