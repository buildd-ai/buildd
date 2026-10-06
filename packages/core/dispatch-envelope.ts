/**
 * Outbox row → Dispatch envelope. The envelope is a pure function of the row
 * (plus the route Buildd's policy chose for it), so "re-publish everything
 * not yet acked" is always a safe repair: Dispatch is idempotent on `id`.
 *
 * Mapping (knowledge-base buildd/design/cloudflare-dispatch-transport.md,
 * "Envelope"): id → id, intent → kind, workspace → source.scope, task →
 * source.subject, primaryCause(causes) → labels, a future not_before →
 * notBefore, `${subject}:${dedupe_key}` → dedupeKey, attempt_count → attempt.
 * Delivery status columns are not sent; they are projected back from receipts.
 *
 * Nothing here names a Buildd table in the wire format: Dispatch never reads
 * `subject`, never branches on `labels`, and resolves `payloadRef` only by
 * calling Buildd back.
 */
import type { DispatchEnvelope, RouteStep } from '@buildd/dispatch-contract';
import { primaryCause, type DispatchCause, type DispatchIntent } from './dispatch-outbox';

export const DISPATCH_SOURCE_SYSTEM = 'buildd';

/** The outbox columns the envelope is built from. */
export interface EnvelopeSourceRow {
  id: string;
  intent: DispatchIntent;
  workspaceId: string;
  taskId: string;
  cause: DispatchCause;
  causes: DispatchCause[];
  notBefore: Date;
  dedupeKey: string;
  attemptCount: number;
  metadata: Record<string, unknown> | null;
}

/** What Buildd's route policy decided for one row (apps/web/src/lib/dispatch-transport.ts `routeFor`). */
export interface EnvelopeRoute {
  steps: RouteStep[];
  /** Small, non-secret inline payload for the runner wake. */
  payload?: Record<string, unknown>;
}

// ── Target ids ────────────────────────────────────────────────────────────

export const DISPATCH_TARGET_TYPES = ['webhook', 'runner-wake'] as const;
export type DispatchTargetType = (typeof DISPATCH_TARGET_TYPES)[number];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TARGET_RE = new RegExp(`^buildd:ws:(${UUID}):(${DISPATCH_TARGET_TYPES.join('|')})$`, 'i');

/** Registered target id within a workspace scope: `buildd:ws:<uuid>:<type>`. */
export function targetId(workspaceId: string, type: DispatchTargetType): string {
  return `buildd:ws:${workspaceId}:${type}`;
}

export function parseTargetId(target: unknown): { workspaceId: string; type: DispatchTargetType } | null {
  if (typeof target !== 'string') return null;
  const m = TARGET_RE.exec(target);
  return m ? { workspaceId: m[1].toLowerCase(), type: m[2] as DispatchTargetType } : null;
}

export const workspaceScope = (workspaceId: string) => `workspace:${workspaceId}`;
export const taskSubject = (taskId: string) => `task:${taskId}`;
export const payloadRefFor = (id: string) => `buildd:dispatch/${id}`;

// ── Mapping ───────────────────────────────────────────────────────────────

function causesOf(v: unknown): DispatchCause[] {
  if (Array.isArray(v)) return v as DispatchCause[];
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

export function toEnvelope(row: EnvelopeSourceRow, route: EnvelopeRoute, opts: { now?: number } = {}): DispatchEnvelope {
  const now = opts.now ?? Date.now();
  const causes = causesOf(row.causes);
  const subject = taskSubject(row.taskId);
  const notBefore = row.notBefore instanceof Date ? row.notBefore : new Date(row.notBefore);
  return {
    id: row.id,
    kind: row.intent ?? 'work_execution',
    source: { system: DISPATCH_SOURCE_SYSTEM, scope: workspaceScope(row.workspaceId), subject },
    target: { steps: route.steps },
    ...(notBefore.getTime() > now ? { notBefore: notBefore.toISOString() } : {}),
    dedupeKey: `${subject}:${row.dedupeKey}`,
    payloadRef: payloadRefFor(row.id),
    ...(route.payload && Object.keys(route.payload).length > 0 ? { payload: route.payload } : {}),
    labels: { cause: primaryCause(causes, row.cause), causes },
    attempt: Math.max(0, Number(row.attemptCount) || 0),
  };
}
