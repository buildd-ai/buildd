/**
 * Capability requests and grants: the db half (rules: capability-grants.ts).
 *
 * No interactive transactions (neon-http): every state change is one
 * conditional UPDATE … WHERE status = <expected> RETURNING, and an insert of
 * an open row relies on the partial unique index on `dedupe_key`, so a double
 * click, a retried request or two concurrent workers' asks each resolve to
 * exactly one row.
 *
 * Nothing here reads or returns credential material; discovery's loader
 * selects health columns only.
 */
import { createHash } from 'crypto';
import { isOpenTaskStatus } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { capabilityGrants, capabilityPolicies, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { loadDiscoveryInput } from './connector-capabilities-store';
import { resolveCapability, type CapabilityCandidate } from './connector-capabilities';
import { recordCapabilityDecision } from './agent-capabilities/audit';
import type { AgentPrincipal } from './agent-capabilities/principal';
import {
  approvalRefusal,
  approvalTtl,
  checkGrantUse,
  effectivePolicy,
  resolveCapabilityRequest,
  toModelInferenceGrant,
  type CapabilityRequest,
  type CapabilityUse,
  type GrantRecord,
  type GrantTarget,
  type PolicyRule,
  type RequestPrincipal,
  type Resolution,
  type UseRefusal,
} from './capability-grants';
import { MODEL_INFERENCE_CAPABILITY, type ModelInferenceGrantSource } from './capability-model-inference';

type GrantRow = typeof capabilityGrants.$inferSelect;

export function toGrantRecord(r: GrantRow): GrantRecord {
  return {
    id: r.id, teamId: r.teamId, workspaceId: r.workspaceId, taskId: r.taskId, workerId: r.workerId,
    roleSlug: r.roleSlug, capability: r.capability, provider: r.provider, connectorId: r.connectorId,
    risk: r.risk, tool: r.tool, resource: r.resource, environment: r.environment, scope: r.scope,
    status: r.status, decidedBy: r.decidedBy, ttlSeconds: r.ttlSeconds, expiresAt: r.expiresAt,
    revokedAt: r.revokedAt, dedupeKey: r.dedupeKey,
  };
}

/** What a caller (agent, UI) may see of a grant: ids, scope, status. Never a credential. */
export function grantView(r: GrantRecord & Partial<Pick<GrantRow, 'reason' | 'decisionReason' | 'requestedAt' | 'decidedAt'>>) {
  return {
    id: r.id, status: r.status, capability: r.capability, provider: r.provider, connectorId: r.connectorId,
    risk: r.risk, tool: r.tool, resource: r.resource, environment: r.environment,
    workspaceId: r.workspaceId, taskId: r.taskId, workerId: r.workerId, roleSlug: r.roleSlug,
    decidedBy: r.decidedBy, ttlSeconds: r.ttlSeconds, expiresAt: r.expiresAt, revokedAt: r.revokedAt,
    ...(r.capability === MODEL_INFERENCE_CAPABILITY && r.scope ? { scope: r.scope } : {}),
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.decisionReason !== undefined ? { decisionReason: r.decisionReason } : {}),
    ...(r.requestedAt !== undefined ? { requestedAt: r.requestedAt } : {}),
    ...(r.decidedAt !== undefined ? { decidedAt: r.decidedAt } : {}),
  };
}

/**
 * One open row per (worker, target, exact ask). Worker-bound, so a retried
 * task's new worker never inherits a grant, and a request from another team
 * can never collide with this one.
 */
export function capabilityDedupeKey(p: Pick<RequestPrincipal, 'workerId'>, req: CapabilityRequest, t: GrantTarget): string {
  const parts = [p.workerId, req.capability, t.provider, t.connectorId ?? '', req.risk, req.tool ?? '', req.resource ?? '', req.environment ?? '',
    req.modelInference ? JSON.stringify(req.modelInference) : ''];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

export async function loadPolicyRules(teamId: string): Promise<PolicyRule[]> {
  const rows = await db.query.capabilityPolicies.findMany({ where: eq(capabilityPolicies.teamId, teamId) });
  return rows.map(r => ({
    id: r.id, provider: r.provider, risk: r.risk, workspaceId: r.workspaceId, roleSlug: r.roleSlug,
    environment: r.environment, resource: r.resource, effect: r.effect, maxTtlSeconds: r.maxTtlSeconds,
  }));
}

/** Granted rows past their expiry become `expired`, so the dedupe slot frees up. */
async function expireLapsed(where: ReturnType<typeof eq>, now: Date) {
  await db.update(capabilityGrants)
    .set({ status: 'expired' })
    .where(and(where, eq(capabilityGrants.status, 'granted'), lte(capabilityGrants.expiresAt, now)));
}

async function loadRunState(taskId: string, workerId: string) {
  const [task, worker] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { status: true, roleSlug: true } }),
    db.query.workers.findFirst({ where: eq(workers.id, workerId), columns: { status: true } }),
  ]);
  return { taskStatus: task?.status ?? 'missing', roleSlug: task?.roleSlug ?? null, workerStatus: worker?.status ?? 'missing' };
}

/** The connector's discovery candidate right now, under the task's current role. */
async function liveCandidate(g: Pick<GrantRecord, 'workspaceId' | 'capability' | 'connectorId'>, roleSlug: string | null, now: Date): Promise<CapabilityCandidate | null> {
  if (!g.connectorId) return null;
  const input = await loadDiscoveryInput(g.workspaceId, roleSlug, now);
  if (!input) return null;
  const res = resolveCapability(input, g.capability);
  if ('error' in res) return null;
  return res.candidates.find(c => c.connector?.id === g.connectorId) ?? null;
}

// ── Agent: request ───────────────────────────────────────────────────────────

export type RequestOutcome =
  | { ok: true; resolution: Resolution; grant: ReturnType<typeof grantView> | null; deduped: boolean }
  | { ok: false; status: 409; code: 'task_not_live' | 'workspace_not_found'; error: string };

export async function requestCapability(principal: AgentPrincipal, req: CapabilityRequest, now: Date = new Date()): Promise<RequestOutcome> {
  const run = await loadRunState(principal.taskId, principal.workerId);
  if (!isOpenTaskStatus(run.taskStatus)) {
    return { ok: false, status: 409, code: 'task_not_live', error: 'This task has ended; capability requests are refused.' };
  }
  if (!principal.teamId) return { ok: false, status: 409, code: 'workspace_not_found', error: 'Workspace has no team.' };
  const rp: RequestPrincipal = { teamId: principal.teamId, workspaceId: principal.workspaceId, taskId: principal.taskId, workerId: principal.workerId, roleSlug: run.roleSlug };

  await expireLapsed(eq(capabilityGrants.workerId, principal.workerId), now);
  const [input, rules, rows] = await Promise.all([
    req.modelInference ? Promise.resolve(null) : loadDiscoveryInput(principal.workspaceId, run.roleSlug, now),
    loadPolicyRules(principal.teamId),
    db.query.capabilityGrants.findMany({ where: eq(capabilityGrants.workerId, principal.workerId) }),
  ]);
  if (!req.modelInference && !input) return { ok: false, status: 409, code: 'workspace_not_found', error: 'Workspace not found.' };
  const discovery = input ? resolveCapability(input, req.capability) : null;
  const grants = rows.map(toGrantRecord);

  const resolution = resolveCapabilityRequest({
    request: req,
    principal: rp,
    discovery: discovery && !('error' in discovery) ? discovery : null,
    rules,
    openGrants: grants.filter(g => g.status === 'pending' || g.status === 'granted'),
    deniedKeys: new Set(grants.filter(g => g.status === 'denied').map(g => g.dedupeKey)),
    dedupeKeyFor: t => capabilityDedupeKey(rp, req, t),
    now,
  });

  const audit = (decision: 'allowed' | 'refused', grantId: string | null, expiresAt: Date | null = null) => void recordCapabilityDecision({
    capability: 'capability.request', decision,
    workspaceId: rp.workspaceId, taskId: rp.taskId, workerId: rp.workerId, accountId: principal.accountId, principalVia: principal.via,
    resource: grantId ? `grant:${grantId}` : `${req.capability}@${resolution.target?.provider ?? req.provider ?? 'any'}`,
    reasonCode: `${resolution.kind}:${resolution.reasonCode}`, expiresAt,
    sideEffect: { risk: req.risk, tool: req.tool, resource: req.resource, environment: req.environment },
  });

  if (resolution.grantId) {
    const existing = grants.find(g => g.id === resolution.grantId)!;
    audit(resolution.kind === 'existing' ? 'allowed' : 'refused', existing.id, existing.expiresAt);
    return { ok: true, resolution, grant: grantView(existing), deduped: true };
  }
  if ((resolution.kind !== 'auto_granted' && resolution.kind !== 'pending_approval') || !resolution.target) {
    audit(resolution.kind === 'existing' ? 'allowed' : 'refused', null);
    return { ok: true, resolution, grant: null, deduped: false };
  }

  const target = resolution.target;
  const granted = resolution.kind === 'auto_granted';
  const dedupeKey = capabilityDedupeKey(rp, req, target);
  const inserted = await db.insert(capabilityGrants).values({
    teamId: rp.teamId, workspaceId: rp.workspaceId, taskId: rp.taskId, workerId: rp.workerId,
    requestedByAccountId: principal.accountId, roleSlug: rp.roleSlug,
    capability: req.capability, provider: target.provider, connectorId: target.connectorId,
    risk: req.risk, tool: req.tool, resource: req.resource, environment: req.environment,
    scope: req.modelInference ? { ...req.modelInference } : null,
    reason: req.reason,
    status: granted ? 'granted' : 'pending',
    decidedBy: granted ? 'policy' : null,
    decisionReason: granted ? resolution.reasonCode : null,
    decidedAt: granted ? now : null,
    expiresAt: granted ? new Date(now.getTime() + resolution.ttlSeconds * 1000) : null,
    ttlSeconds: resolution.ttlSeconds,
    dedupeKey,
  }).onConflictDoNothing().returning();

  // Lost a race to an identical ask: return the row that won.
  const row = inserted[0] ?? await db.query.capabilityGrants.findFirst({
    where: and(eq(capabilityGrants.dedupeKey, dedupeKey), inArray(capabilityGrants.status, ['pending', 'granted'])),
  });
  if (!row) {
    audit('refused', null);
    return { ok: true, resolution: { ...resolution, kind: 'unavailable', reasonCode: 'request_race_lost' }, grant: null, deduped: false };
  }
  const rec = toGrantRecord(row);
  const kind = rec.status === 'granted' ? (granted ? 'auto_granted' : 'existing') : 'pending_approval';
  audit(rec.status === 'granted' ? 'allowed' : 'refused', rec.id, rec.expiresAt);
  return { ok: true, resolution: { ...resolution, kind, grantId: rec.id }, grant: grantView(rec), deduped: !inserted[0] };
}

// ── Person: approve / deny / revoke ──────────────────────────────────────────

export type Decision = 'approve' | 'deny' | 'revoke';

export type DecideOutcome =
  | { ok: true; grant: ReturnType<typeof grantView>; alreadyDecided: boolean }
  | { ok: false; status: 404 | 409; code: string; error: string; grant?: ReturnType<typeof grantView> };

export async function loadGrant(id: string): Promise<GrantRow | null> {
  return (await db.query.capabilityGrants.findFirst({ where: eq(capabilityGrants.id, id) })) ?? null;
}

/**
 * Apply a person's decision. Authority (session user holding manage_connectors
 * in the grant's team) is the route's job and is checked before this runs.
 * Idempotent: the same decision twice answers with the row as it stands.
 */
export async function decideCapabilityRequest(
  row: GrantRow,
  decision: Decision,
  actor: { userId: string },
  opts: { ttlSeconds?: number | null; reason?: string | null } = {},
  now: Date = new Date(),
): Promise<DecideOutcome> {
  const g = toGrantRecord(row);
  const reason = opts.reason?.trim().slice(0, 500) || null;
  const audit = (cap: 'capability.approve' | 'capability.deny' | 'capability.revoke', d: 'allowed' | 'refused', code: string, expiresAt: Date | null = null) => void recordCapabilityDecision({
    capability: cap, decision: d, workspaceId: g.workspaceId, taskId: g.taskId, workerId: g.workerId,
    resource: `grant:${g.id}`, reasonCode: code, expiresAt, sideEffect: { decidedByUserId: actor.userId },
  });
  const settled = async (expect: Decision) => {
    const cur = await loadGrant(g.id);
    if (!cur) return { ok: false as const, status: 404 as const, code: 'not_found', error: 'Request not found' };
    const want = expect === 'approve' ? 'granted' : expect === 'deny' ? 'denied' : 'revoked';
    if (cur.status === want) return { ok: true as const, grant: grantView(toGrantRecord(cur)), alreadyDecided: true };
    return { ok: false as const, status: 409 as const, code: `already_${cur.status}`, error: `This request is already ${cur.status}.`, grant: grantView(toGrantRecord(cur)) };
  };

  if (decision === 'deny') {
    const [r] = await db.update(capabilityGrants)
      .set({ status: 'denied', decidedBy: 'human', decidedByUserId: actor.userId, decidedAt: now, decisionReason: reason })
      .where(and(eq(capabilityGrants.id, g.id), eq(capabilityGrants.status, 'pending')))
      .returning();
    if (!r) return settled('deny');
    audit('capability.deny', 'refused', 'denied_by_human');
    return { ok: true, grant: grantView(toGrantRecord(r)), alreadyDecided: false };
  }

  if (decision === 'revoke') {
    const [r] = await db.update(capabilityGrants)
      .set({ status: 'revoked', revokedAt: now, decidedByUserId: actor.userId, decisionReason: reason ?? 'revoked' })
      .where(and(eq(capabilityGrants.id, g.id), inArray(capabilityGrants.status, ['pending', 'granted'])))
      .returning();
    if (!r) return settled('revoke');
    audit('capability.revoke', 'refused', 'revoked_by_human');
    return { ok: true, grant: grantView(toGrantRecord(r)), alreadyDecided: false };
  }

  // approve
  if (g.status !== 'pending') return settled('approve');
  const run = await loadRunState(g.taskId, g.workerId);
  const [rules, candidate] = await Promise.all([loadPolicyRules(g.teamId), liveCandidate(g, run.roleSlug, now)]);
  const refusal = approvalRefusal(g, { taskStatus: run.taskStatus, workerStatus: run.workerStatus, rules, candidate, currentRoleSlug: run.roleSlug });
  if (refusal) {
    // A request for an ended run or a changed role can never be approved: close it.
    if (refusal === 'task_terminal' || refusal === 'worker_not_live' || refusal === 'role_changed') {
      await db.update(capabilityGrants).set({ status: 'expired', decidedBy: 'system', decidedAt: now, decisionReason: refusal })
        .where(and(eq(capabilityGrants.id, g.id), eq(capabilityGrants.status, 'pending')));
    }
    audit('capability.approve', 'refused', refusal);
    return { ok: false, status: 409, code: refusal, error: APPROVAL_REFUSAL_TEXT[refusal] };
  }
  const policy = effectivePolicy(rules, {
    provider: g.provider, risk: g.risk, workspaceId: g.workspaceId, roleSlug: g.roleSlug, environment: g.environment, resource: g.resource,
  }, (candidate?.roles.withAccess.length ?? 0) > 0);
  const ttl = approvalTtl(g.ttlSeconds, opts.ttlSeconds, policy.maxTtlSeconds);
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const [r] = await db.update(capabilityGrants)
    .set({ status: 'granted', decidedBy: 'human', decidedByUserId: actor.userId, decidedAt: now, decisionReason: reason, ttlSeconds: ttl, expiresAt })
    .where(and(eq(capabilityGrants.id, g.id), eq(capabilityGrants.status, 'pending')))
    .returning();
  if (!r) return settled('approve');
  audit('capability.approve', 'allowed', 'approved_by_human', expiresAt);
  return { ok: true, grant: grantView(toGrantRecord(r)), alreadyDecided: false };
}

const APPROVAL_REFUSAL_TEXT: Record<string, string> = {
  task_terminal: 'The task has ended; the request was closed.',
  worker_not_live: 'The agent run has stopped; the request was closed.',
  role_changed: "The task's role changed since the request; the request was closed.",
  policy_forbidden: 'Team capability policy forbids this access. Change the policy first.',
  catalog_blocked: 'This provider is blocked for the team. Unblock it first.',
  disabled_in_workspace: 'This connector is disabled in the workspace. Enable it first.',
  connector_gone: 'The connector is no longer available to this workspace.',
};

// ── Use: re-checked on every call ────────────────────────────────────────────

export type UseOutcome =
  | { allowed: true; grantId: string; expiresAt: Date }
  | { allowed: false; reasonCode: UseRefusal | 'no_grant' };

/**
 * May this agent run make this call now? Reads the worker's granted rows and
 * every live fact fresh, so revocation, a terminal task, a role change, a
 * tightened policy, a catalog block or a dead credential stops the very next
 * call. The runtime (capability gateway / MCP injection) calls this; it is
 * the only path from a grant to a use.
 */
export async function authorizeCapabilityUse(principal: AgentPrincipal, use: CapabilityUse, now: Date = new Date()): Promise<UseOutcome> {
  const rows = await db.query.capabilityGrants.findMany({
    where: and(eq(capabilityGrants.workerId, principal.workerId), eq(capabilityGrants.status, 'granted'), eq(capabilityGrants.capability, use.capability)),
  });
  const outcome = await checkUse(principal, rows.map(toGrantRecord), use, now);
  void recordCapabilityDecision({
    capability: 'capability.use', decision: outcome.allowed ? 'allowed' : 'refused',
    workspaceId: principal.workspaceId, taskId: principal.taskId, workerId: principal.workerId, accountId: principal.accountId, principalVia: principal.via,
    resource: outcome.allowed ? `grant:${outcome.grantId}` : `${use.capability}@${use.provider}`,
    reasonCode: outcome.allowed ? null : outcome.reasonCode, expiresAt: outcome.allowed ? outcome.expiresAt : null,
    sideEffect: { tool: use.tool, resource: use.resource, environment: use.environment },
  });
  return outcome;
}

async function checkUse(principal: AgentPrincipal, grants: GrantRecord[], use: CapabilityUse, now: Date): Promise<UseOutcome> {
  if (grants.length === 0 || !principal.teamId) return { allowed: false, reasonCode: 'no_grant' };
  const run = await loadRunState(principal.taskId, principal.workerId);
  const rules = await loadPolicyRules(principal.teamId);
  const rp: RequestPrincipal = { teamId: principal.teamId, workspaceId: principal.workspaceId, taskId: principal.taskId, workerId: principal.workerId, roleSlug: run.roleSlug };
  let last: UseRefusal | 'no_grant' = 'no_grant';
  for (const g of grants) {
    const candidate = await liveCandidate(g, run.roleSlug, now);
    const refusal = checkGrantUse(g, use, { principal: rp, taskStatus: run.taskStatus, workerStatus: run.workerStatus, rules, candidate, now });
    if (!refusal) return { allowed: true, grantId: g.id, expiresAt: g.expiresAt! };
    last = refusal;
  }
  return { allowed: false, reasonCode: last };
}

/**
 * The model.inference grant source the inference route was waiting on. Same
 * live checks as any use (task, worker, role, policy), then hands the adapter
 * its grant shape; the adapter re-checks every field again.
 */
export const capabilityGrantSource: ModelInferenceGrantSource = {
  async findLiveGrant({ principal }) {
    const now = new Date();
    const rows = await db.query.capabilityGrants.findMany({
      where: and(eq(capabilityGrants.workerId, principal.workerId), eq(capabilityGrants.status, 'granted'), eq(capabilityGrants.capability, MODEL_INFERENCE_CAPABILITY)),
      orderBy: [desc(capabilityGrants.decidedAt)],
    });
    if (rows.length === 0 || !principal.teamId) return null;
    const run = await loadRunState(principal.taskId, principal.workerId);
    const rules = await loadPolicyRules(principal.teamId);
    const rp: RequestPrincipal = { teamId: principal.teamId, workspaceId: principal.workspaceId, taskId: principal.taskId, workerId: principal.workerId, roleSlug: run.roleSlug };
    for (const row of rows) {
      const g = toGrantRecord(row);
      const use: CapabilityUse = { capability: MODEL_INFERENCE_CAPABILITY, provider: g.provider, connectorId: null, tool: null, resource: null, environment: null };
      if (checkGrantUse(g, use, { principal: rp, taskStatus: run.taskStatus, workerStatus: run.workerStatus, rules, candidate: null, now })) continue;
      const mapped = toModelInferenceGrant(g);
      if (mapped) return mapped;
    }
    return null;
  },
};

// ── Listing (people) ─────────────────────────────────────────────────────────

export async function listTeamRequests(teamId: string, opts: { status?: string[]; workspaceId?: string | null; limit?: number } = {}) {
  const now = new Date();
  await expireLapsed(eq(capabilityGrants.teamId, teamId), now);
  const conds = [eq(capabilityGrants.teamId, teamId)];
  if (opts.status?.length) conds.push(inArray(capabilityGrants.status, opts.status as GrantRow['status'][]));
  if (opts.workspaceId) conds.push(eq(capabilityGrants.workspaceId, opts.workspaceId));
  const rows = await db.query.capabilityGrants.findMany({
    where: and(...conds),
    orderBy: [desc(capabilityGrants.requestedAt)],
    limit: Math.min(Math.max(opts.limit ?? 50, 1), 200),
  });
  return rows.map(r => grantView({ ...toGrantRecord(r), reason: r.reason, decisionReason: r.decisionReason, requestedAt: r.requestedAt, decidedAt: r.decidedAt }));
}
