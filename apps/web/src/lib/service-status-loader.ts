/**
 * The service-status loader (docs/specs/team-service-status.md section 9): one
 * read of the team's active root causes, runner accounts, members and affected
 * tasks per Home, Health or task render, handed to the pure view
 * (`service-status-view.ts`). Reads only; no model call; nothing here retries,
 * resumes or changes a provider. `loadServiceStatus` never throws: a failed
 * read is logged and the page renders without statuses.
 */
import { EMPTY_SERVICE_STATUS, serviceStatusView, type ServiceStatusFacts, type ServiceStatusView } from './service-status-view';

export * from './service-status-view';

// ── Reads ────────────────────────────────────────────────────────────────────

export interface ServiceStatusReadPort {
  facts(teamId: string): Promise<ServiceStatusFacts>;
}

/** A runner that claimed work within this window counts as in use. */
const ACTIVE_WINDOW_MS = 24 * 3_600_000;

/**
 * The team's service-status reads as one plan: the first round's statements
 * (for the caller to send in one batch, alone or beside its own) and `facts`,
 * which turns their results into facts and runs the second round (the
 * affected tasks) only when a cause names some.
 */
export async function serviceStatusReads(teamId: string, now: number = Date.now()) {
  const { db } = await import('@buildd/core/db');
  const { accounts, rootCauses, secrets, tasks, teamMembers, workers, workspaces } = await import('@buildd/core/db/schema');
  const { and, eq, exists, gte, inArray, isNull, ne, sql } = await import('drizzle-orm');
  const { teamCredentialWhere } = await import('@buildd/core/secrets/team-scope');
  const { toRootCauseRecord } = await import('./root-cause-record');
  const { AGENT_CREDENTIAL_PURPOSES } = await import('./getting-started');
  const { LIVE_WORKER_STATUSES } = await import('./task-presentation');

  const since = new Date(now - ACTIVE_WINDOW_MS);
  const queries = [
    db.select().from(rootCauses).where(and(eq(rootCauses.teamId, teamId), isNull(rootCauses.verifiedRestoredAt))).limit(50),
    db.select({
      id: accounts.id, name: accounts.name, authType: accounts.authType, managedRunner: accounts.managedRunner,
      hostRunner: accounts.hostRunner, createdByUserId: accounts.createdByUserId,
    }).from(accounts).where(eq(accounts.teamId, teamId)),
    // Runners in use: accounts that claimed the team's work in the window.
    db.selectDistinct({ accountId: workers.accountId }).from(workers).innerJoin(workspaces, eq(workspaces.id, workers.workspaceId))
      .where(and(eq(workspaces.teamId, teamId), gte(workers.createdAt, since))),
    db.select({ userId: teamMembers.userId, role: teamMembers.role }).from(teamMembers).where(eq(teamMembers.teamId, teamId)),
    db.select({ id: secrets.id }).from(secrets)
      .where(teamCredentialWhere({ teamId, purpose: AGENT_CREDENTIAL_PURPOSES.filter(p => p.endsWith('_api_key')) }, ne(secrets.healthStatus, 'revoked'))).limit(1),
    db.select({ id: secrets.id }).from(secrets)
      .where(teamCredentialWhere({ teamId, purpose: ['oauth_token', 'claude_credential', 'codex_credential'] })).limit(1),
    db.select({ n: sql<number>`count(*)::int` }).from(tasks).innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(and(eq(workspaces.teamId, teamId), gte(tasks.createdAt, since))),
  ] as const;

  type Q = typeof queries;
  /** `results`: the first round's results, in `queries` order. */
  async function facts(results: readonly unknown[]): Promise<ServiceStatusFacts> {
    const [recordRows, runnerRows, claimRows, memberRows, keyRows, savedRows, recentRows] = results as [
      Awaited<Q[0]>, Awaited<Q[1]>, Awaited<Q[2]>, Awaited<Q[3]>, Awaited<Q[4]>, Awaited<Q[5]>, Awaited<Q[6]>,
    ];
    const recent = recentRows[0];
    const records = recordRows.map(toRootCauseRecord);
    const taskIds = [...new Set(records.flatMap(r => r.affectedTaskIds))];
    // One statement: the affected tasks and whether each has a live run (an
    // EXISTS on its workers), so a team with an active cause still costs a
    // page one round trip here, not two (Fast at any size R-6).
    const taskRows = taskIds.length === 0 ? [] : await db.select({
      id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId, status: tasks.status, createdByUserId: tasks.createdByUserId,
      hasLiveRun: sql<boolean>`${exists(db.select({ one: sql`1` }).from(workers)
        .where(and(eq(workers.taskId, tasks.id), inArray(workers.status, [...LIVE_WORKER_STATUSES]))))}`,
    }).from(tasks).where(inArray(tasks.id, taskIds));
    const claimed = new Set(claimRows.map(w => w.accountId));
    return {
      teamId,
      records,
      runners: runnerRows.map(r => ({
        id: r.id, name: r.name, authType: r.authType, managedRunner: r.managedRunner, hostRunner: r.hostRunner,
        createdByUserId: r.createdByUserId, recentlyActive: claimed.has(r.id),
      })),
      members: memberRows,
      tasks: taskRows.map(t => ({ ...t, hasLiveRun: t.hasLiveRun === true })),
      teamHasProviderKey: keyRows.length > 0,
      teamHasSavedSignIn: savedRows.length > 0,
      recentTaskCount: recent?.n ?? 0,
    };
  }
  return { queries, facts };
}

export const dbServiceStatusPort: ServiceStatusReadPort = {
  async facts(teamId) {
    const { db } = await import('@buildd/core/db');
    const plan = await serviceStatusReads(teamId);
    // One round trip for the first round (a batch is one statement list).
    return plan.facts(await db.batch(plan.queries as never) as unknown[]);
  },
};

/**
 * The viewer's service status for a team, once per render. Never throws: a
 * failed read logs and returns no statuses, and the page renders every other
 * item as before (team-service-status AC-11).
 */
export async function loadServiceStatus(
  input: { userId: string | null | undefined; teamId: string | null | undefined },
  port: ServiceStatusReadPort = dbServiceStatusPort,
): Promise<ServiceStatusView> {
  if (!input.userId || !input.teamId) return EMPTY_SERVICE_STATUS;
  try {
    return serviceStatusView(await port.facts(input.teamId), input.userId);
  } catch (err) {
    console.error('[service-status] load failed (non-fatal):', err);
    return EMPTY_SERVICE_STATUS;
  }
}
