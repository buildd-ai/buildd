/**
 * Connectors module: a new workspace gets every connector its team preinstalls
 * from the catalog (policy 'preinstalled', lib/connector-catalog-store.ts).
 * Best effort per entry; workspace creation never fails for it (emit isolates
 * subscriber throws).
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { loadTeamCatalog } from '@/lib/connector-catalog-store';
import { applyPreinstalledToWorkspace } from '@/lib/connector-provision';

export const connectorCatalogSubscribers: readonly AnySubscriber[] = [
  subscriber('connectors', 'workspace.created', 'preinstall-catalog-connectors', async e => {
    const catalog = await loadTeamCatalog(e.teamId);
    await applyPreinstalledToWorkspace(e.teamId, e.workspaceId, e.origin, catalog);
  }),
];
