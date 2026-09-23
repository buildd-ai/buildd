/**
 * Server loader for the /app/health Experiments section. Same visibility rule
 * as /api/experiments: below admin, admins-only experiments are dropped here,
 * before anything reaches the client.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { runExperimentReadout } from '@buildd/core/experiment-readout-source';
import { parseModelRoutingConfig } from '@buildd/core/model-routing-experiment';
import { canViewExperiment, isExperimentAdmin, toExperimentDTO, type TeamRole } from './experiments';
import { listTeamExperiments } from './experiments-store';
import type { HealthExperiments } from './health-experiments-shared';

/** At most this many are shown; the ordering below keeps live ones in. */
const MAX_ITEMS = 10;

export async function loadHealthExperiments(teamId: string, userId: string): Promise<HealthExperiments | null> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    columns: { role: true },
  });
  const role = (membership?.role as TeamRole | undefined) ?? null;
  if (!role) return null;

  const rows = (await listTeamExperiments(teamId)).filter(r => canViewExperiment(r.visibility, role));
  // Live experiments first, then drafts, then the most recent conclusions.
  const rank = (s: string) => (s === 'running' ? 0 : s === 'paused' ? 1 : s === 'draft' ? 2 : 3);
  rows.sort((a, b) => rank(a.status) - rank(b.status));

  const items = await Promise.all(rows.slice(0, MAX_ITEMS).map(async row => {
    const experiment = toExperimentDTO(row);
    if (row.status === 'draft') return { experiment, readout: null };
    const { minSamplePerArm } = parseModelRoutingConfig(row.config);
    const readout = await runExperimentReadout({ id: row.id, policyVersion: row.policyVersion }, { minSamplePerArm })
      .catch(() => null);
    return { experiment, readout };
  }));

  return { canManage: isExperimentAdmin(role), items };
}
