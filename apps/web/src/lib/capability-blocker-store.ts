/**
 * `structuredOutput.blockedByCapability`: the db half (rules: capability-blocker.ts).
 *
 * Reads what this worker asked (agent_capability_decisions rows written by
 * request_capability and resolve_capability, and its capability_grants rows),
 * and files the `[capability]` task when nothing can serve the need. No new
 * table and no new task status: the request rows already carry a person's
 * decision, and a need nothing serves becomes one open task per need and
 * workspace, appended to by every later run that hits it.
 */
import { db } from '@buildd/core/db';
// A namespace import, read at call time: route tests mock the schema module
// with only the tables they touch (see agent-capabilities/audit.ts).
import * as schema from '@buildd/core/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { OPEN_TASK_STATUSES, type BlockedByCapability, type CapabilityBlockerRecord } from '@buildd/shared';
import {
  capabilityTaskBody,
  capabilityTaskTitle,
  decideCapabilityBlocker,
  type BlockerDecision,
  type CapabilityCallRecord,
  type CapabilityRequestRow,
} from './capability-blocker';

export const CAPABILITY_BLOCKER_CONTEXT_TYPE = 'capability_blocker';


type DecisionRow = {
  capability: string;
  resource: string | null;
  reasonCode: string | null;
  sideEffect: Record<string, unknown> | null;
  occurredAt: Date;
};

/** An audit row as a call record. Older rows carry the ask only in `resource` (`<capability>@<provider>` or `grant:<id>`). */
export function toCallRecord(r: DecisionRow): CapabilityCallRecord | null {
  const call = r.capability === 'capability.request' ? 'request' : r.capability === 'capability.resolve' ? 'resolve' : null;
  if (!call || !r.reasonCode) return null;
  const se = r.sideEffect ?? {};
  const grantId = r.resource?.startsWith('grant:') ? r.resource.slice('grant:'.length) : null;
  const [resCap, resProvider] = r.resource && !grantId ? r.resource.split('@') : [null, null];
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    call,
    capability: str(se.capability) ?? resCap ?? null,
    provider: str(se.provider) ?? (resProvider && resProvider !== 'any' ? resProvider : null),
    // request: `<kind>:<reasonCode>`; resolve: `served` | `none`.
    outcome: r.reasonCode.split(':')[0],
    providers: Array.isArray(se.providers) ? se.providers.filter((p): p is string => typeof p === 'string') : undefined,
    grantId,
    at: r.occurredAt,
  };
}

export async function loadCapabilityAsks(workerId: string): Promise<{ calls: CapabilityCallRecord[]; requests: CapabilityRequestRow[] }> {
  const s = schema as unknown as Record<string, any>;
  const [decisionRows, grantRows] = await Promise.all([
    db.select({
      capability: s.agentCapabilityDecisions.capability,
      resource: s.agentCapabilityDecisions.resource,
      reasonCode: s.agentCapabilityDecisions.reasonCode,
      sideEffect: s.agentCapabilityDecisions.sideEffect,
      occurredAt: s.agentCapabilityDecisions.occurredAt,
    }).from(s.agentCapabilityDecisions).where(and(
      eq(s.agentCapabilityDecisions.workerId, workerId),
      inArray(s.agentCapabilityDecisions.capability, ['capability.request', 'capability.resolve']),
    )) as Promise<DecisionRow[]>,
    db.select({
      id: s.capabilityGrants.id,
      capability: s.capabilityGrants.capability,
      provider: s.capabilityGrants.provider,
      status: s.capabilityGrants.status,
      requestedAt: s.capabilityGrants.requestedAt,
    }).from(s.capabilityGrants).where(eq(s.capabilityGrants.workerId, workerId)) as Promise<CapabilityRequestRow[]>,
  ]);
  return {
    calls: decisionRows.map(toCallRecord).filter((c): c is CapabilityCallRecord => c !== null),
    requests: grantRows,
  };
}

/** One open `[capability]` task per need and workspace: append to it, or file it. */
export async function fileCapabilityTask(input: {
  workspaceId: string;
  claim: BlockedByCapability;
  outcome: string;
  sourceTaskId: string;
  sourceTaskTitle: string | null;
  workerId: string;
}): Promise<{ id: string; deduplicated: boolean }> {
  const { tasks } = schema;
  const body = capabilityTaskBody(input);
  const [existing] = await db.select({ id: tasks.id, description: tasks.description }).from(tasks).where(and(
    eq(tasks.workspaceId, input.workspaceId),
    sql`${tasks.context}->>'type' = ${CAPABILITY_BLOCKER_CONTEXT_TYPE}`,
    sql`${tasks.context}->>'capabilityNeed' = ${input.claim.need}`,
    inArray(tasks.status, [...OPEN_TASK_STATUSES]),
  )).limit(1);

  if (existing) {
    // A retried complete_task from the same worker appends nothing new.
    const marker = `Worker: ${input.workerId.slice(0, 8)}`;
    if (!existing.description?.includes(marker)) {
      const appendText = `\n\n---\n_Another run hit this._\n${body}`;
      await db.update(tasks)
        .set({ description: sql`coalesce(${tasks.description}, '') || ${appendText}`, updatedAt: new Date() })
        .where(eq(tasks.id, existing.id));
    }
    return { id: existing.id, deduplicated: true };
  }

  const [row] = await db.insert(tasks).values({
    workspaceId: input.workspaceId,
    title: capabilityTaskTitle(input.claim.need),
    description: body,
    status: 'pending',
    mode: 'execution',
    category: 'infra',
    priority: 3,
    outputRequirement: 'none',
    // Filed by server-side machinery reacting to an event (see experiment-cleanup-task.ts).
    creationSource: 'webhook',
    createdByWorkerId: input.workerId,
    context: {
      type: CAPABILITY_BLOCKER_CONTEXT_TYPE,
      capabilityNeed: input.claim.need,
      ...(input.claim.provider ? { provider: input.claim.provider } : {}),
      ...(input.claim.access ? { access: input.claim.access } : {}),
      outcome: input.outcome,
      sourceTaskId: input.sourceTaskId,
    },
  }).returning({ id: tasks.id });
  return { id: row.id, deduplicated: false };
}

export type CapabilityBlockerResult =
  | { ok: true; record: CapabilityBlockerRecord }
  | { ok: false; refusal: Extract<BlockerDecision, { accept: false }> };

/**
 * Gate and route one claim. On accept, the returned record replaces
 * `structuredOutput.blockedByCapability` so the task result says where it went.
 */
export async function settleCapabilityBlocker(input: {
  claim: BlockedByCapability;
  workerId: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string | null;
}, deps: {
  load?: typeof loadCapabilityAsks;
  file?: typeof fileCapabilityTask;
} = {}): Promise<CapabilityBlockerResult> {
  const { calls, requests } = await (deps.load ?? loadCapabilityAsks)(input.workerId);
  const decision = decideCapabilityBlocker(input.claim, calls, requests);
  if (!decision.accept) return { ok: false, refusal: decision };
  if (decision.routedTo === 'capability_request') {
    return { ok: true, record: { ...input.claim, requestId: decision.requestId, outcome: decision.outcome, routedTo: 'capability_request' } };
  }
  const filed = await (deps.file ?? fileCapabilityTask)({
    workspaceId: input.workspaceId, claim: input.claim, outcome: decision.outcome,
    sourceTaskId: input.taskId, sourceTaskTitle: input.taskTitle, workerId: input.workerId,
  });
  return { ok: true, record: { ...input.claim, outcome: decision.outcome, routedTo: 'capability_task', capabilityTaskId: filed.id } };
}
