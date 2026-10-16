import { createDbIncidentPort } from '@/lib/failure-incident-store';
import type { IncidentActionDeps } from './apply';

/**
 * The production side of the click-time re-check: the incident store, the
 * recovery families' own observation (`assessIncident`, source `click`), the
 * stored verdict and the escalation gate. No writer of its own.
 */
export async function productionIncidentActionDeps(teamId: string | null): Promise<IncidentActionDeps> {
  const port = await createDbIncidentPort();
  return {
    port,
    async reassess(incidentId) {
      const [{ assessIncident, productionRecoveryDeps }, { pathOverlapRecoveryFamily }] = await Promise.all([
        import('@/lib/failure-incident-recovery'), import('@/lib/failure-incident-recovery-path-overlap'),
      ]);
      const r = await assessIncident(productionRecoveryDeps(port, [pathOverlapRecoveryFamily]), incidentId, 'click');
      return r.incident ?? (await port.findById(incidentId));
    },
    async loadVerdict(incident) {
      if (!teamId) return null;
      const { loadIncidentVerdicts } = await import('@/lib/failure-incident-escalation');
      return (await loadIncidentVerdicts(teamId, [incident.id])).get(incident.id) ?? null;
    },
    async regate(incident) {
      const [{ regateAlert }, { createGatedIncidentSender, createDbIncidentGateDeps }] = await Promise.all([
        import('@/lib/failure-pattern-sweep'), import('@/lib/failure-incident-escalation'),
      ]);
      await createGatedIncidentSender(createDbIncidentGateDeps())(regateAlert(incident)).catch(err => {
        console.warn('[incidents/actions] re-gate failed (non-fatal):', (err as Error)?.message ?? err);
      });
    },
    now: () => new Date().toISOString(),
  };
}
