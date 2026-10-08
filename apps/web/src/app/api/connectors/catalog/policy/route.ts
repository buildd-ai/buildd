import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectorCatalogTeamPolicies, connectors } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { CATALOG_POLICIES, normalizeConnectorUrl, type CatalogPolicy } from '@/lib/connector-catalog';
import { loadTeamCatalog } from '@/lib/connector-catalog-store';
import { preinstallForTeam, registrationRefusalBody } from '@/lib/connector-provision';
import { resolveConnectorTeam, forbidden } from '@/lib/connector-team-auth';

/**
 * PUT { slug, policy } — a team admin decides how one catalog entry behaves
 * for their team: 'blocked' (hidden), 'available' (default) or 'preinstalled'
 * (created now and enabled in every workspace, including future ones).
 * Blocking or un-preinstalling never deletes a connector already installed;
 * removing one stays an explicit act on Settings → MCP connectors. Blocking
 * does revoke agent access to it, at every boundary that hands a connector to
 * an agent (lib/connector-access-policy.ts); the response lists the installed
 * connectors that were kept so the admin sees nothing was silently removed.
 */
export async function PUT(req: NextRequest) {
  const caller = await resolveConnectorTeam(req);
  if (caller instanceof NextResponse) return caller;
  if (!caller.canManage) return forbidden();

  let body: { slug?: unknown; policy?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const slug = typeof body.slug === 'string' ? body.slug : '';
  const policy = body.policy as CatalogPolicy;
  if (!CATALOG_POLICIES.includes(policy)) {
    return NextResponse.json({ error: 'invalid_policy', message: `policy must be one of ${CATALOG_POLICIES.join(', ')}.` }, { status: 400 });
  }

  const catalog = await loadTeamCatalog(caller.teamId);
  const entry = catalog.find(e => e.slug === slug);
  if (!entry) return NextResponse.json({ error: 'Catalog entry not found' }, { status: 404 });

  // Provision BEFORE recording 'preinstalled', so a server that fails
  // discovery leaves the policy unchanged rather than claiming an install.
  let connectorId: string | null = null;
  if (policy === 'preinstalled') {
    try {
      connectorId = (await preinstallForTeam(caller.teamId, { ...entry, policy }, req.nextUrl.origin)).id;
    } catch (err) {
      const refusal = registrationRefusalBody(err, entry.url);
      if (refusal) return NextResponse.json(refusal, { status: 422 });
      return NextResponse.json(
        { error: 'preinstall_failed', message: `Could not set up ${entry.name}: ${(err as Error).message}` },
        { status: 422 },
      );
    }
  }

  await db.insert(connectorCatalogTeamPolicies)
    .values({ teamId: caller.teamId, slug, policy, updatedByAccountId: caller.accountId })
    .onConflictDoUpdate({
      target: [connectorCatalogTeamPolicies.teamId, connectorCatalogTeamPolicies.slug],
      set: { policy, updatedByAccountId: caller.accountId, updatedAt: new Date() },
    });

  if (policy === 'blocked') {
    const target = normalizeConnectorUrl(entry.url);
    const owned = await db.query.connectors.findMany({ where: eq(connectors.teamId, caller.teamId), columns: { id: true, url: true } });
    const retainedConnectorIds = owned.filter(c => normalizeConnectorUrl(c.url) === target).map(c => c.id);
    return NextResponse.json({ slug, policy, connectorId, retainedConnectorIds });
  }

  return NextResponse.json({ slug, policy, connectorId });
}
