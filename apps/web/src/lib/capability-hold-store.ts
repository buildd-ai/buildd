/**
 * A pending access request holds the run: the db half (rules in
 * capability-hold.ts).
 *
 *  - `evaluateCompletionHold` reads this worker's request rows fresh, the
 *    team's wait window and whether a granted database.query can run at all,
 *    and returns the verdict the worker PATCH applies. On a pass it writes the
 *    side effects: overdue requests expire (`wait_window_elapsed`), requests
 *    the agent gave up on close (`agent_stopped_waiting`).
 *  - `withdrawCapabilityRequest`: the agent closes its own pending request.
 *  - `expireOverdueRequests`: the sweep (maintenance cron, and every team read)
 *    that expires requests nobody answered inside the window and tells the
 *    worker. The row says `expired` with that reason, never "task ended".
 *  - `notifyWorkerOfAccessDecision`: a decision (approve, refuse, expiry)
 *    reaches the live worker on the instruction queue every runner reads at
 *    its next check-in, with a Pusher wake so it does not wait for one.
 *
 * Spec: docs/specs/capability-requests.md → Holding the run.
 */
import { db } from '@buildd/core/db';
import { capabilityGrants, teams, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { recordCapabilityDecision } from './agent-capabilities/audit';
import type { AgentPrincipal } from './agent-capabilities/principal';
import { accessAsk } from './capability-grants-view';
import { DATABASE_QUERY_CAPABILITY } from './capability-database-query';
import {
  CLOSE_REASONS,
  accessDecisionNotice,
  accessNoticeMarker,
  completionHoldVerdict,
  waitWindowMs,
  type HeldRequestRow,
  type HoldVerdict,
} from './capability-hold';

type GrantRow = typeof capabilityGrants.$inferSelect;

function toHeld(r: GrantRow): HeldRequestRow {
  return {
    id: r.id, capability: r.capability, provider: r.provider, risk: r.risk, tool: r.tool, resource: r.resource,
    status: r.status, decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionReason: r.decisionReason,
    requestedAt: r.requestedAt, expiresAt: r.expiresAt,
  };
}

const askOf = (r: Pick<HeldRequestRow, 'capability' | 'provider' | 'risk' | 'tool' | 'resource'>) =>
  accessAsk({ capability: r.capability, provider: r.provider, risk: r.risk as 'read' | 'query' | 'write' | 'admin', tool: r.tool, resource: r.resource, environment: null });

/** Why a granted row cannot be spent on this deployment, or null. */
export function unusableGrantReason(r: Pick<HeldRequestRow, 'capability'>, env: NodeJS.ProcessEnv = process.env): string | null {
  if (r.capability === DATABASE_QUERY_CAPABILITY && !env.BUILDD_QUERY_DATABASE_URL) return 'query_role_unconfigured';
  return null;
}

/** The team's wait window for a workspace, in ms (the default when unset). */
export async function teamWaitWindowMs(workspaceId: string): Promise<number> {
  const rows = await db.select({ seconds: teams.accessWaitWindowSeconds })
    .from(workspaces)
    .leftJoin(teams, eq(teams.id, workspaces.teamId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return waitWindowMs(rows[0]?.seconds ?? null);
}

export interface CompletionHoldInput {
  workerId: string;
  taskId: string;
  workspaceId: string;
  structuredOutput: unknown;
  now?: Date;
}

/**
 * The verdict for this completion, side effects applied on a pass. Every row
 * of this worker is read, whatever its status: a request granted and spent
 * needs nothing, one never granted must be declared.
 */
export async function evaluateCompletionHold(input: CompletionHoldInput): Promise<HoldVerdict> {
  const now = input.now ?? new Date();
  const rows = await db.query.capabilityGrants.findMany({ where: sqlWhere(eq(capabilityGrants.workerId, input.workerId)) });
  if (rows.length === 0 && !declares(input.structuredOutput)) {
    return { kind: 'pass', expire: [], stopWaiting: [], blockedByCapability: null, proceededWithout: null, summaryLead: null };
  }
  const windowMs = await teamWaitWindowMs(input.workspaceId);
  const verdict = completionHoldVerdict({
    rows: rows.map(toHeld), structuredOutput: input.structuredOutput, now, windowMs,
    unusable: r => unusableGrantReason(r), ask: askOf,
  });
  if (verdict.kind !== 'pass') return verdict;
  const base = { workspaceId: input.workspaceId, taskId: input.taskId, workerId: input.workerId };
  if (verdict.expire.length > 0) {
    await db.update(capabilityGrants)
      .set({ status: 'expired', decidedBy: 'system', decidedAt: now, decisionReason: CLOSE_REASONS.waitWindowElapsed })
      .where(and(inArray(capabilityGrants.id, verdict.expire), eq(capabilityGrants.status, 'pending')));
    for (const id of verdict.expire) void recordCapabilityDecision({ ...base, capability: 'capability.expire', decision: 'refused', resource: `grant:${id}`, reasonCode: CLOSE_REASONS.waitWindowElapsed });
  }
  if (verdict.stopWaiting.length > 0) {
    await db.update(capabilityGrants)
      .set({ status: 'expired', decidedBy: 'agent', decidedAt: now, decisionReason: CLOSE_REASONS.agentStoppedWaiting })
      .where(and(inArray(capabilityGrants.id, verdict.stopWaiting), eq(capabilityGrants.status, 'pending')));
    for (const id of verdict.stopWaiting) void recordCapabilityDecision({ ...base, capability: 'capability.withdraw', decision: 'refused', resource: `grant:${id}`, reasonCode: CLOSE_REASONS.agentStoppedWaiting });
  }
  return verdict;
}

function declares(structuredOutput: unknown): boolean {
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) return false;
  const o = structuredOutput as Record<string, unknown>;
  return o.blockedByCapability != null || o.proceededWithout != null;
}

// ── Agent: withdraw ──────────────────────────────────────────────────────────

export type WithdrawOutcome =
  | { ok: true; requestId: string; alreadyClosed: boolean; status: GrantRow['status'] }
  | { ok: false; status: 404 | 409; code: 'not_found' | 'already_granted' | 'already_decided'; error: string; requestStatus?: GrantRow['status'] };

/**
 * The agent closes its own pending request: `expired`, decidedBy `agent`,
 * reason `withdrawn`. Only its own worker's row; another worker's answers 404.
 * A granted row is not withdrawn (409: the agent has it; it ends with the
 * run), and a decided one answers with the row as it stands.
 */
export async function withdrawCapabilityRequest(principal: Pick<AgentPrincipal, 'workerId' | 'taskId' | 'workspaceId' | 'accountId' | 'via'>, requestId: string, now: Date = new Date()): Promise<WithdrawOutcome> {
  const row = await db.query.capabilityGrants.findFirst({ where: sqlWhere(and(eq(capabilityGrants.id, requestId), eq(capabilityGrants.workerId, principal.workerId))) });
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'No capability request with that id for this worker.' };
  const audit = (decision: 'allowed' | 'refused', reasonCode: string) => void recordCapabilityDecision({
    capability: 'capability.withdraw', decision, workspaceId: principal.workspaceId, taskId: principal.taskId, workerId: principal.workerId,
    accountId: principal.accountId, principalVia: principal.via, resource: `grant:${row.id}`, reasonCode,
  });
  const [r] = await db.update(capabilityGrants)
    .set({ status: 'expired', decidedBy: 'agent', decidedAt: now, decisionReason: CLOSE_REASONS.withdrawn })
    .where(and(eq(capabilityGrants.id, row.id), eq(capabilityGrants.status, 'pending')))
    .returning();
  if (r) {
    audit('refused', CLOSE_REASONS.withdrawn);
    return { ok: true, requestId: row.id, alreadyClosed: false, status: 'expired' };
  }
  const cur = (await db.query.capabilityGrants.findFirst({ where: sqlWhere(eq(capabilityGrants.id, row.id)) })) ?? row;
  if (cur.status === 'granted') {
    audit('refused', 'already_granted');
    return { ok: false, status: 409, code: 'already_granted', error: 'This request is granted: you have the access. It ends with your run; use it or leave it.', requestStatus: cur.status };
  }
  if (cur.status === 'expired' && cur.decisionReason === CLOSE_REASONS.withdrawn) {
    return { ok: true, requestId: row.id, alreadyClosed: true, status: cur.status };
  }
  audit('refused', `already_${cur.status}`);
  return { ok: false, status: 409, code: 'already_decided', error: `This request is already ${cur.status}; nothing to withdraw.`, requestStatus: cur.status };
}

// ── Sweep: the wait window ───────────────────────────────────────────────────

export interface OverdueExpiry {
  requestId: string;
  workerId: string;
  taskId: string;
  workspaceId: string;
  ask: string;
}

/**
 * Expire every pending request older than its team's wait window and tell its
 * worker. Each write is conditional on the row still being pending, so a
 * decision made meanwhile wins. Scope to one team for a page's after-response
 * sweep; no team = every team (the maintenance cron). Never throws.
 */
export async function expireOverdueRequests(opts: { teamId?: string; now?: Date } = {}): Promise<OverdueExpiry[]> {
  const now = opts.now ?? new Date();
  const out: OverdueExpiry[] = [];
  try {
    const rows = await db.select({ grant: capabilityGrants, windowSeconds: teams.accessWaitWindowSeconds })
      .from(capabilityGrants)
      .leftJoin(teams, eq(teams.id, capabilityGrants.teamId))
      .where(and(
        eq(capabilityGrants.status, 'pending'),
        // The widest window any team may set bounds the scan; the exact window is applied per row below.
        lte(capabilityGrants.requestedAt, new Date(now.getTime() - waitWindowMs(300))),
        ...(opts.teamId ? [eq(capabilityGrants.teamId, opts.teamId)] : []),
      ));
    for (const { grant: g, windowSeconds } of rows) {
      const windowMs = waitWindowMs(windowSeconds);
      if (g.requestedAt.getTime() + windowMs > now.getTime()) continue;
      const [r] = await db.update(capabilityGrants)
        .set({ status: 'expired', decidedBy: 'system', decidedAt: now, decisionReason: CLOSE_REASONS.waitWindowElapsed })
        .where(and(eq(capabilityGrants.id, g.id), eq(capabilityGrants.status, 'pending')))
        .returning();
      if (!r) continue;
      const ask = askOf(toHeld(g));
      void recordCapabilityDecision({ capability: 'capability.expire', decision: 'refused', workspaceId: g.workspaceId, taskId: g.taskId, workerId: g.workerId, resource: `grant:${g.id}`, reasonCode: CLOSE_REASONS.waitWindowElapsed, sideEffect: { windowSeconds: Math.round(windowMs / 1000) } });
      await notifyWorkerOfAccessDecision({ id: g.id, capability: g.capability, workerId: g.workerId }, 'expired', { ask, windowMs });
      out.push({ requestId: g.id, workerId: g.workerId, taskId: g.taskId, workspaceId: g.workspaceId, ask });
    }
  } catch (err) {
    console.warn('[capability-hold] overdue sweep failed (non-fatal):', (err as Error)?.message ?? err);
  }
  return out;
}

// ── Telling the worker ───────────────────────────────────────────────────────

/** What spends a grant of this capability, for the approval notice. */
function spendWith(capability: string): string | null {
  if (capability === DATABASE_QUERY_CAPABILITY) return 'query_database { sql, params? }';
  if (capability === 'model.inference') return 'invoke_model_inference { model, state, questions }';
  if (capability === 'tasks:create') return 'create_task { workspaceId: <that workspace>, … }';
  if (capability === 'analytics:read') return 'the analytics read you were refused, with workspaceId set to that workspace';
  return null;
}

/**
 * Queue the decision on the worker's instruction queue (the channel every
 * runner reads at its next check-in and an interactive session reads with
 * receive_messages) and wake the runner. A terminal worker is skipped; a
 * repeat for the same request and decision is not stacked. Never throws.
 */
export async function notifyWorkerOfAccessDecision(
  r: { id: string; capability: string; workerId: string },
  decision: 'approved' | 'denied' | 'expired',
  opts: { ask?: string; reason?: string | null; windowMs?: number } = {},
): Promise<boolean> {
  try {
    const [{ queueSystemInstruction }, { pushInstructionDelivery }] = await Promise.all([
      import('./system-instruction-queue'), import('./worker-instruction-push'),
    ]);
    let ask: string = opts.ask ?? '';
    if (!ask) {
      const g = await db.query.capabilityGrants.findFirst({ where: sqlWhere(eq(capabilityGrants.id, r.id)) });
      ask = g ? askOf(toHeld(g)) : r.capability;
    }
    const sensitive = await db.query.workers.findFirst({ where: sqlWhere(eq(workers.id, r.workerId)), columns: { id: true }, with: { workspace: { columns: { dataClass: true } } } })
      .then(w => (w as { workspace?: { dataClass?: string | null } } | undefined)?.workspace?.dataClass === 'sensitive')
      .catch(() => false);
    const text = accessDecisionNotice(r, decision, { ask, reason: opts.reason, windowMs: opts.windowMs, spendWith: spendWith(r.capability) });
    const queued = await queueSystemInstruction(r.workerId, text, { marker: accessNoticeMarker(r.id, decision), sensitive });
    if (queued) await pushInstructionDelivery(r.workerId, { queueable: true, pusherText: null }).catch(() => undefined);
    return queued;
  } catch (err) {
    console.warn('[capability-hold] worker notice failed (non-fatal):', (err as Error)?.message ?? err);
    return false;
  }
}
