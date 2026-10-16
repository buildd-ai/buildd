import { db } from '@buildd/core/db';
import { connectorCatalogEntries, connectorCatalogTeamPolicies } from '@buildd/core/db/schema';
import { eq, isNull } from 'drizzle-orm';
import type { CatalogPolicy, ResolvedCatalogEntry } from '@/lib/connector-catalog';
import { mergeCatalog, type CatalogRow } from '@/lib/connector-catalog-merge';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/** The merged catalog (built-in + platform + team rows) with this team's policies. */
export async function loadTeamCatalog(teamId: string): Promise<ResolvedCatalogEntry[]> {
  const [platformRows, teamRows, policyRows] = await Promise.all([
    db.query.connectorCatalogEntries.findMany({ where: sqlWhere(isNull(connectorCatalogEntries.teamId)) }),
    db.query.connectorCatalogEntries.findMany({ where: sqlWhere(eq(connectorCatalogEntries.teamId, teamId)) }),
    db.query.connectorCatalogTeamPolicies.findMany({ where: sqlWhere(eq(connectorCatalogTeamPolicies.teamId, teamId)) }),
  ]);
  return mergeCatalog({
    platformRows: platformRows as CatalogRow[],
    teamRows: teamRows as CatalogRow[],
    policies: new Map(policyRows.map(p => [p.slug, p.policy as CatalogPolicy])),
  });
}
