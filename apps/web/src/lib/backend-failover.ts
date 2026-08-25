/**
 * Cross-provider failover: where does a job go when its backend hits a wall?
 *
 * The decision rules are pure and live in @buildd/core/backend-policy
 * (pickFailoverBackend). This module is the DB half: it records provider pauses,
 * reads the ones still in force, checks which providers are configured for a
 * team, and hands the pure function a complete picture.
 *
 * It is deliberately provider-agnostic. Adding OpenRouter (or any future
 * backend) means adding a registry entry and, if it needs a credential, one
 * branch in `isBackendConfigured` — every call site here and in the routes
 * keeps working unchanged.
 */

import { db } from '@buildd/core/db';
import { accounts, backendPauses, tenantBudgets } from '@buildd/core/db/schema';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import {
  BACKEND_REGISTRY,
  DISPATCHABLE_BACKENDS,
  pickFailoverBackend,
  type AgentBackend,
  type BackendAvailability,
  type BackendId,
  type FailoverDecision,
} from '@buildd/core/backend-policy';
import { hasCodexCredential } from './codex-credential';

export type PauseReason = 'budget' | 'auth';

export interface BackendScope {
  teamId?: string | null;
  accountId?: string | null;
  workspaceId?: string | null;
  /** Dispatch multi-tenant mode: budget is tracked per tenant, not per account. */
  tenantId?: string | null;
}

/** How long an expired pause row is kept before the next write prunes it. */
const PAUSE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Record that `backend` is walled for this team until `resetsAt`.
 *
 * Append-only — the active pause is the newest unexpired row. Never throws: a
 * lost pause only costs one wasted dispatch, and must not break the caller's
 * re-queue path.
 */
export async function recordBackendPause(opts: {
  backend: string | null | undefined;
  scope: BackendScope;
  resetsAt: Date;
  reason?: PauseReason;
  sourceWorkerId?: string | null;
}): Promise<void> {
  const backend = (opts.backend || 'claude') as AgentBackend;
  if (!opts.scope.teamId || !BACKEND_REGISTRY[backend as BackendId]?.dispatchable) return;
  try {
    await db.insert(backendPauses).values({
      teamId: opts.scope.teamId,
      workspaceId: opts.scope.workspaceId ?? null,
      backend,
      reason: opts.reason ?? 'budget',
      resetsAt: opts.resetsAt,
      sourceWorkerId: opts.sourceWorkerId ?? null,
    });
  } catch (err) {
    console.warn(`[backend-failover] Failed to record ${backend} pause for team ${opts.scope.teamId}:`, err);
    return;
  }

  // Lazy prune, kept out of the write's try so a failed cleanup never reads as
  // a failed pause record.
  try {
    await db
      .delete(backendPauses)
      .where(and(
        eq(backendPauses.teamId, opts.scope.teamId),
        lt(backendPauses.resetsAt, new Date(Date.now() - PAUSE_RETENTION_MS)),
      ));
  } catch {
    // Expired rows are inert — they are filtered out on read.
  }
}

export interface ActivePause {
  backend: AgentBackend;
  resetsAt: Date;
  reason: string;
}

/**
 * Every provider pause still in force for this scope, newest first per backend.
 *
 * Reads the pause log plus the two pre-existing Claude-only signals — the
 * account's own OAuth session flag and the per-tenant budget row — so callers
 * see one uniform answer instead of re-deriving "is Claude walled?" themselves.
 */
export async function getActiveBackendPauses(scope: BackendScope): Promise<Map<AgentBackend, ActivePause>> {
  const out = new Map<AgentBackend, ActivePause>();
  const now = new Date();

  if (scope.teamId) {
    try {
      const rows = await db.query.backendPauses.findMany({
        where: and(eq(backendPauses.teamId, scope.teamId), gt(backendPauses.resetsAt, now)),
        orderBy: [desc(backendPauses.resetsAt)],
        columns: { backend: true, resetsAt: true, reason: true },
      });
      for (const row of rows) {
        const backend = row.backend as AgentBackend;
        if (!out.has(backend)) out.set(backend, { backend, resetsAt: row.resetsAt, reason: row.reason });
      }
    } catch (err) {
      console.warn('[backend-failover] Pause lookup failed:', err);
    }
  }

  // Claude's session/budget wall predates the pause log and is still written by
  // the claim + worker-report routes, so fold both legacy records in.
  const claudeLegacyReset = await legacyClaudePauseResetsAt(scope, now);
  if (claudeLegacyReset) {
    const existing = out.get('claude');
    if (!existing || claudeLegacyReset > existing.resetsAt) {
      out.set('claude', { backend: 'claude', resetsAt: claudeLegacyReset, reason: 'budget' });
    }
  }

  return out;
}

async function legacyClaudePauseResetsAt(scope: BackendScope, now: Date): Promise<Date | null> {
  try {
    if (scope.tenantId && scope.teamId) {
      const row = await db.query.tenantBudgets.findFirst({
        where: and(eq(tenantBudgets.tenantId, scope.tenantId), eq(tenantBudgets.teamId, scope.teamId)),
        columns: { budgetResetsAt: true },
      });
      if (row?.budgetResetsAt && new Date(row.budgetResetsAt) > now) return new Date(row.budgetResetsAt);
      return null;
    }
    if (scope.accountId) {
      const row = await db.query.accounts.findFirst({
        where: eq(accounts.id, scope.accountId),
        columns: { budgetExhaustedAt: true, budgetResetsAt: true },
      });
      if (row?.budgetExhaustedAt && row.budgetResetsAt && new Date(row.budgetResetsAt) > now) {
        return new Date(row.budgetResetsAt);
      }
    }
  } catch (err) {
    console.warn('[backend-failover] Legacy Claude budget lookup failed:', err);
  }
  return null;
}

/** True when this backend has what it needs to run for the given scope. */
export async function isBackendConfigured(backend: BackendId, scope: BackendScope): Promise<boolean> {
  const descriptor = BACKEND_REGISTRY[backend];
  if (!descriptor?.dispatchable) return false;
  // Claude runs on the account's own auth when no team credential is stored, so
  // it needs no explicit check — the claim route attaches whatever is available.
  if (descriptor.implicitlyConfigured) return true;
  if (backend === 'codex') {
    if (!scope.teamId) return false;
    try {
      return await hasCodexCredential({
        teamId: scope.teamId,
        accountId: scope.accountId ?? null,
        workspaceId: scope.workspaceId ?? null,
      });
    } catch (err) {
      console.warn('[backend-failover] Codex credential check failed:', err);
      return false;
    }
  }
  return false;
}

/**
 * Observed availability for every dispatchable backend — what the UI renders
 * and what the failover decision is made from.
 *
 * @param busy Backends whose provider-level concurrency is already taken (the
 *             claim route knows this; the worker-report route does not).
 */
export async function getBackendAvailability(
  scope: BackendScope,
  busy?: Partial<Record<AgentBackend, boolean>>,
): Promise<BackendAvailability[]> {
  const pauses = await getActiveBackendPauses(scope);
  return Promise.all(
    DISPATCHABLE_BACKENDS.map(async (backend) => ({
      backend,
      configured: await isBackendConfigured(backend, scope),
      pausedUntil: pauses.get(backend)?.resetsAt ?? null,
      busy: busy?.[backend] ?? false,
    })),
  );
}

/**
 * Pick the backend a stuck task should move to, or null when every alternative
 * is disabled, unconfigured, walled or busy. `blocked` carries the reason per
 * candidate so callers can log it and the UI can explain the dead end.
 */
export async function resolveFailoverBackend(opts: {
  from: string | null | undefined;
  scope: BackendScope;
  enabledBackends?: AgentBackend[] | null;
  busy?: Partial<Record<AgentBackend, boolean>>;
  now?: Date;
}): Promise<FailoverDecision> {
  const availability = await getBackendAvailability(opts.scope, opts.busy);
  return pickFailoverBackend({
    from: (opts.from || 'claude') as BackendId,
    enabledBackends: opts.enabledBackends ?? null,
    availability,
    now: opts.now,
  });
}

/** The team's enabled-provider mask, or null when the team allows everything. */
export async function teamEnabledBackends(teamId?: string | null): Promise<AgentBackend[] | null> {
  if (!teamId) return null;
  try {
    const team = await db.query.teams.findFirst({
      where: (t, { eq: teq }) => teq(t.id, teamId),
      columns: { enabledBackends: true },
    });
    const enabled = (team as { enabledBackends?: AgentBackend[] | null } | undefined)?.enabledBackends;
    return enabled && enabled.length > 0 ? enabled : null;
  } catch (err) {
    console.warn(`[backend-failover] Team backend mask lookup failed for ${teamId}:`, err);
    return null;
  }
}
