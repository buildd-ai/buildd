/**
 * A `GET /api/providers` body built from the real registry, for the dev
 * fixture page and the Providers page tests. Listings come from the registry
 * and the pure write rules (`@buildd/core/providers/manage`), the same way
 * the route builds them, so a registry change reaches the fixture too.
 *
 * Fixture values only: made-up ids and last4s.
 */
import { PROVIDER_REGISTRY, SURFACES, type ProviderId } from '@buildd/core/providers';
import { PROVIDER_API_SCOPES, scopeRefusal, servedSurfaces, storageServes, writeStorage } from '@buildd/core/providers/manage';
import type {
  ListProvidersResponse,
  ProviderApiScope,
  ProviderCredentialSummary,
  ProviderListing,
  ProviderPolicySummary,
  ProviderShapeId,
} from '@buildd/shared';

export interface FixtureRow {
  provider: ProviderId;
  scope: ProviderApiScope;
  shape?: ProviderShapeId;
  last4?: string | null;
  health?: string;
  lastVerifiedAt?: string | null;
  lastVerificationError?: string | null;
  workspaceId?: string | null;
}

export function fixtureRow(r: FixtureRow): ProviderCredentialSummary {
  const p = PROVIDER_REGISTRY.find((d) => d.id === r.provider)!;
  const shape = p.shapes.find((s) => s.id === (r.shape ?? p.shapes.find((x) => x.id !== 'oauth_managed')?.id ?? p.shapes[0].id))!;
  const storage = writeStorage(p.id, shape, r.scope);
  return {
    id: `${r.provider}-${r.scope}-${shape.id}`,
    provider: r.provider,
    shape: shape.id,
    scope: r.scope,
    workspaceId: r.scope === 'workspace' ? (r.workspaceId ?? 'ws-a') : null,
    accountScoped: false,
    purpose: storage.purpose,
    label: storage.label ?? null,
    legacy: storage !== shape.storage,
    last4: r.last4 === undefined ? (shape.refreshes ? null : 'a1b2') : r.last4,
    health: r.health ?? 'healthy',
    lastVerifiedAt: r.lastVerifiedAt ?? null,
    lastVerificationError: r.lastVerificationError ?? null,
    updatedAt: '2026-10-01T10:00:00Z',
    servesToday: r.scope === 'mine' || storage.purpose === 'agent_endpoint'
      ? servedSurfaces(p).filter((s) => storage.purpose !== 'agent_endpoint' || s !== 'chat')
      : storageServes(p, storage),
  };
}

export function fixtureListings(rows: readonly FixtureRow[], o: { workspace: boolean; mine: boolean }): ProviderListing[] {
  const summaries = rows.map(fixtureRow);
  return [...PROVIDER_REGISTRY]
    .sort((a, b) => a.settingsCard.order - b.settingsCard.order)
    .map((p) => {
      const scopes = {} as ProviderListing['scopes'];
      for (const scope of PROVIDER_API_SCOPES) {
        const reason = scopeRefusal(p.id, scope);
        scopes[scope] = reason ? { ok: false, reason } : { ok: true };
      }
      const surfaces = {} as ProviderListing['surfaces'];
      for (const s of SURFACES) surfaces[s] = p.surfaces[s];
      const mine = summaries.filter((s) => s.provider === p.id);
      return {
        id: p.id,
        label: p.label,
        order: p.settingsCard.order,
        connectFlow: p.settingsCard.connectFlow,
        surfaces,
        scopes,
        shapes: p.shapes.map((shape) => {
          const writesTo = {} as ProviderListing['shapes'][number]['writesTo'];
          for (const scope of PROVIDER_API_SCOPES) {
            if (scopeRefusal(p.id, scope)) { writesTo[scope] = null; continue; }
            const st = writeStorage(p.id, shape, scope);
            writesTo[scope] = { purpose: st.purpose, label: st.label ?? null };
          }
          return { id: shape.id, refreshes: shape.refreshes, connectInBrowser: shape.id === 'oauth_managed', writesTo };
        }),
        set: {
          team: mine.filter((s) => s.scope === 'team'),
          workspace: o.workspace ? mine.filter((s) => s.scope === 'workspace') : null,
          mine: o.mine ? mine.filter((s) => s.scope === 'mine') : null,
        },
      };
    });
}

export const ADMIN_CAN: ListProvidersResponse['caller']['can'] = {
  manage_team_model_keys: true,
  manage_team_credentials: true,
  manage_inference_providers: true,
  manage_team_settings: true,
};
export const MEMBER_CAN: ListProvidersResponse['caller']['can'] = {
  manage_team_model_keys: false,
  manage_team_credentials: false,
  manage_inference_providers: false,
  manage_team_settings: false,
};

export function fixturePolicy(credentialPolicy: ProviderPolicySummary['credentialPolicy']): ProviderPolicySummary {
  const p = credentialPolicy ?? 'team';
  return {
    credentialPolicy,
    chat: { policy: p, source: credentialPolicy ? 'credential_policy' : 'default' },
    agent: { policy: p, enforced: credentialPolicy !== null, source: credentialPolicy ? 'credential_policy' : 'default' },
  };
}

export function fixtureResponse(o: {
  rows?: readonly FixtureRow[];
  workspaceId?: string | null;
  admin?: boolean;
  canSetMine?: boolean;
  credentialPolicy?: ProviderPolicySummary['credentialPolicy'];
  teamId?: string;
}): ListProvidersResponse {
  const workspaceId = o.workspaceId ?? null;
  const canSetMine = o.canSetMine ?? true;
  const rows = (o.rows ?? []).filter((r) => r.scope !== 'workspace' || !workspaceId || (r.workspaceId ?? 'ws-a') === workspaceId);
  return {
    teamId: o.teamId ?? 't',
    workspaceId,
    caller: { principal: 'person', can: o.admin === false ? MEMBER_CAN : ADMIN_CAN, canSetMine },
    policy: fixturePolicy(o.credentialPolicy ?? null),
    providers: fixtureListings(rows, { workspace: !!workspaceId, mine: canSetMine }),
  };
}
