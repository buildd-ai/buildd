import type { OperatorActionDeps } from './recovery-action';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * The production side of an owner recovery action: the incident store, the
 * recovery families' own observation (source `click`), the platform-wide read
 * model for before/after, the automation CAS, the decision ledger and the
 * audit table. No writer of its own.
 */
export async function productionOperatorActionDeps(): Promise<OperatorActionDeps> {
  const [
    { db }, schema, { and, eq, inArray },
    store, recovery, events, repairs, automationMod, { pathOverlapRecoveryFamily }, { createInfrastructureRecoveryFamily },
    { loadRecoveryCause }, audit, { recordDecision }, actions,
  ] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
    import('@/lib/failure-incident-store'), import('@/lib/failure-incident-recovery'), import('@/lib/failure-incident-recovery-events'),
    import('@/lib/failure-incident-repairs'), import('@/lib/failure-incident-recovery-automation'),
    import('@/lib/failure-incident-recovery-path-overlap'), import('@/lib/failure-incident-recovery-infrastructure'),
    import('@/lib/admin/data'), import('@/lib/admin/audit'), import('@buildd/core/decision-ledger'), import('@/lib/failure-incident-recovery-actions'),
  ]);
  const port = await store.createDbIncidentPort();
  const families = [pathOverlapRecoveryFamily, createInfrastructureRecoveryFamily()];
  const reassess = async (id: string) => {
    const r = await recovery.assessIncident(recovery.productionRecoveryDeps(port, families), id, 'click');
    return r.incident ?? (await port.findById(id));
  };

  return {
    findIncident: id => port.findById(id),
    reassess,
    causeMembers: key => repairs.dbCauseMembers(key),
    async causeRow(causeKey) {
      const detail = await loadRecoveryCause({ workspaceIds: [], platformWide: true, window: '7d', causeKey });
      return detail?.cause ?? null;
    },
    automation: () => automationMod.readAutomationState(),
    repairFacts: (incident, peers) => repairs.loadRepairFacts(incident, peers).catch(() => null),
    async linkTask(params) {
      if ('taskId' in params) {
        const t = await db.query.tasks.findFirst({ where: sqlWhere(eq(schema.tasks.id, params.taskId)), columns: { id: true, workspaceId: true, status: true } });
        return t ?? null;
      }
      const [w] = await db.select({ taskId: schema.workers.taskId }).from(schema.workers)
        .where(and(eq(schema.workers.workspaceId, params.workspaceId), eq(schema.workers.prNumber, params.prNumber))).limit(1);
      if (!w?.taskId) return null;
      const t = await db.query.tasks.findFirst({ where: sqlWhere(eq(schema.tasks.id, w.taskId)), columns: { id: true, workspaceId: true, status: true } });
      return t ?? null;
    },
    async teams(workspaceIds) {
      if (workspaceIds.length === 0) return new Map();
      const rows = await db.select({ id: schema.workspaces.id, teamId: schema.workspaces.teamId }).from(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
      return new Map(rows.map(r => [r.id, r.teamId]));
    },
    auditIntent: event => audit.recordPlatformAdminAuditIntent(event),
    auditComplete: (id, after) => audit.completePlatformAdminAudit(id, after),
    service: {
      port,
      effects: recovery.productionRecoveryEffects(),
      events: events.dbRecoveryEvents(),
      reassess,
      writeAutomation: input => automationMod.compareAndSetAutomation(input),
      async recordPriority(input) {
        const humanOverride = { mode: input.mode, until: input.until, reason: input.reason, by: input.by };
        return recordDecision({
          teamId: input.teamId,
          capability: actions.PRIORITY_CAPABILITY,
          fingerprint: `${input.causeKey}:${input.mode}:${input.until}`,
          appliedAnswer: input.mode,
          applied: true,
          status: 'applied',
          reason: input.reason,
          subjectType: 'cause',
          subjectId: input.causeKey,
        }, {
          // §5.6: the override is a human's, recorded as such on the row.
          insert: async row => {
            const [inserted] = await db.insert(schema.decisionRecords)
              .values({ ...row, humanOverride, overriddenAt: new Date(), overriddenBy: input.accountId })
              .returning({ id: schema.decisionRecords.id });
            return inserted?.id ?? null;
          },
        });
      },
      now: () => new Date().toISOString(),
    },
    now: () => new Date().toISOString(),
  };
}
