/**
 * Where a provider credential is written, who may write it, and what to say
 * when a request cannot be met. The one write path's rules, shared by
 * `/api/providers`, the old credential routes it backs, MCP `manage_providers`
 * and (next) the Providers page.
 *
 * Pure: no DB, client-safe. Everything is derived from the registry
 * (`./registry`); nothing here lists a purpose by hand except the permission
 * split, which mirrors the routes that already wrote each storage.
 *
 * ## Scopes
 *
 * The API speaks `team | workspace | mine`; the registry's `personal` is
 * `mine` (the caller's own). `mine` needs a signed-in person.
 *
 * ## Which storage a write goes to (`writeStorage`)
 *
 * - `mine`: the shape's canonical storage. Personal credentials are read only
 *   by the resolver, which reads canonical and legacy storage alike, and the
 *   legacy agent purposes cannot hold a personal row at all.
 * - `team` / `workspace`: of the shape's canonical and legacy storages, the one
 *   that the most of the provider's surfaces read today (`readBy`), canonical
 *   on a tie. Agent runs read an Anthropic or OpenAI key's canonical storage
 *   (`inference_key` + provider label) as well as its legacy alias, so team and
 *   workspace keys for both are written to canonical storage and serve chat
 *   and agent runs alike. A storage only some surfaces read would win only if
 *   it served more of them than canonical.
 *
 * ## Permissions (`writePermission`)
 *
 * Team and workspace writes need the permission of the route that has always
 * written that storage, so moving a form onto this API changes nobody's
 * access:
 *
 * | storage                                        | permission                   |
 * |------------------------------------------------|------------------------------|
 * | `inference_key`, `decision_key` (API keys)     | `manage_team_model_keys`     |
 * | `anthropic_api_key`, `openai_api_key`, `oauth_token` | `manage_team_credentials` |
 * | `inference_key` that agent runs read (Anthropic, OpenAI) | both of the above |
 *
 * The last row is `writePermissions`: an Anthropic or OpenAI key in canonical
 * storage is a chat key and an agent credential at once, so setting it needs
 * what each of the two routes that wrote those needed.
 * | LiteLLM gateway, custom endpoint               | `manage_inference_providers` |
 * | credential policy                              | `manage_team_settings`       |
 *
 * `mine` needs no permission beyond membership; the team's credential policy
 * decides whether a personal key is accepted.
 */
import {
  PROVIDER_REGISTRY,
  SURFACES,
  isProviderId,
  providerDescriptor,
  type CredentialShape,
  type CredentialStorage,
  type ProviderDescriptor,
  type ProviderId,
  type Surface,
} from './registry';

export const PROVIDER_API_SCOPES = ['team', 'workspace', 'mine'] as const;
export type ProviderApiScope = (typeof PROVIDER_API_SCOPES)[number];

export type ShapeId = CredentialShape['id'];
export const SHAPE_IDS: readonly ShapeId[] = ['api_key', 'setup_token', 'oauth_managed', 'gateway', 'endpoint'];

/** The error code for a provider that cannot serve the surface asked for (HTTP 422). */
export const PROVIDER_SURFACE_UNSUPPORTED = 'provider_surface_unsupported' as const;
/** The error code for a scope the provider cannot be stored at (HTTP 422). */
export const PROVIDER_SCOPE_UNSUPPORTED = 'provider_scope_unsupported' as const;
/** A refresh-family seat is connected in the browser, never pasted (HTTP 422). */
export const CONNECT_IN_BROWSER = 'connect_in_browser' as const;

/** Where a person connects a subscription seat today. */
export const PROVIDERS_SETTINGS_PATH = '/app/settings?section=agent-backends';

export type WritePermission =
  | 'manage_team_model_keys'
  | 'manage_team_credentials'
  | 'manage_inference_providers';
export const POLICY_PERMISSION = 'manage_team_settings' as const;

export function isProviderApiScope(value: unknown): value is ProviderApiScope {
  return typeof value === 'string' && (PROVIDER_API_SCOPES as readonly string[]).includes(value);
}

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value);
}

export function isShapeId(value: unknown): value is ShapeId {
  return typeof value === 'string' && (SHAPE_IDS as readonly string[]).includes(value);
}

export { isProviderId };

/** Surfaces the provider can serve, in registry order. */
export function servedSurfaces(p: ProviderDescriptor): Surface[] {
  return SURFACES.filter(s => p.surfaces[s].ok);
}

/** Surfaces that read this storage today and that the provider can serve. */
export function storageServes(p: ProviderDescriptor, storage: CredentialStorage): Surface[] {
  const served = servedSurfaces(p);
  return SURFACES.filter(s => served.includes(s) && storage.readBy.includes(s));
}

/**
 * The shape a set/delete addresses: the one asked for, else the provider's
 * pasteable shape (a setup token for a Claude seat, never the browser flow),
 * else its only shape.
 */
export function providerShape(provider: ProviderId, shape?: ShapeId): CredentialShape | null {
  const p = providerDescriptor(provider);
  if (shape) return p.shapes.find(s => s.id === shape) ?? null;
  return p.shapes.find(s => s.id !== 'oauth_managed') ?? p.shapes[0] ?? null;
}

/** See the module comment. */
export function writeStorage(provider: ProviderId, shape: CredentialShape, scope: ProviderApiScope): CredentialStorage {
  if (scope === 'mine') return shape.storage;
  const p = providerDescriptor(provider);
  let best = shape.storage;
  let bestCount = storageServes(p, best).length;
  for (const legacy of shape.legacy) {
    const n = storageServes(p, legacy).length;
    if (n > bestCount) {
      best = legacy;
      bestCount = n;
    }
  }
  return best;
}

/** Why the provider cannot hold a credential at this scope, or null. */
export function scopeRefusal(provider: ProviderId, scope: ProviderApiScope): string | null {
  const p = providerDescriptor(provider);
  if (scope !== 'mine') return null;
  if (!p.scopes.includes('personal')) {
    return `${p.label} is a team's shared configuration, so it is set at team or workspace scope, never as a personal credential.`;
  }
  if ((p.pendingScopes ?? []).includes('personal')) {
    return `A personal ${p.label} is not delivered to runs yet. Set it at team or workspace scope, or use your own API key.`;
  }
  return null;
}

/** The registry's reason the provider cannot serve the surface, or null when it can. */
export function surfaceRefusal(provider: ProviderId, surface: Surface): { reason: string; instead?: readonly ProviderId[] } | null {
  const support = providerDescriptor(provider).surfaces[surface];
  return support.ok ? null : { reason: support.reason, ...(support.instead ? { instead: support.instead } : {}) };
}

/** See the module comment. */
export function writePermission(shape: CredentialShape, storage: CredentialStorage): WritePermission {
  if (shape.id === 'gateway' || shape.id === 'endpoint') return 'manage_inference_providers';
  return storage.purpose === 'inference_key' || storage.purpose === 'decision_key'
    ? 'manage_team_model_keys'
    : 'manage_team_credentials';
}

const AGENT_SURFACES: readonly Surface[] = ['agent-claude', 'agent-codex', 'cloud-egress'];

/** See the module comment: one permission per storage, two for a model key agent runs read. */
export function writePermissions(shape: CredentialShape, storage: CredentialStorage): WritePermission[] {
  const own = writePermission(shape, storage);
  return own === 'manage_team_model_keys' && storage.readBy.some(s => AGENT_SURFACES.includes(s))
    ? [own, 'manage_team_credentials']
    : [own];
}

/** Every `secrets.purpose` some provider stores a model credential under. */
export function modelCredentialPurposes(): string[] {
  const out = new Set<string>();
  for (const p of PROVIDER_REGISTRY) {
    for (const s of p.shapes) for (const st of [s.storage, ...s.legacy]) out.add(st.purpose);
  }
  return [...out];
}

/** The provider and shape a stored row belongs to, or null (not a model credential). */
export function rowProvider(row: { purpose: string; label: string | null }): { provider: ProviderId; shape: ShapeId; legacy: boolean } | null {
  const label = (row.label ?? '').toLowerCase();
  for (const p of PROVIDER_REGISTRY) {
    for (const s of p.shapes) {
      const all = [s.storage, ...s.legacy];
      for (const [i, st] of all.entries()) {
        if (st.purpose !== row.purpose) continue;
        if (st.label !== undefined && st.label !== label) continue;
        return { provider: p.id, shape: s.id, legacy: i > 0 };
      }
    }
  }
  return null;
}

// ── A stored row's own rule (routes that write a purpose + label directly) ──

/** The registry storage a stored row sits in, with its shape, or null. */
function storageOf(row: { purpose: string; label?: string | null }): { provider: ProviderId; shape: CredentialShape; storage: CredentialStorage } | null {
  const owner = rowProvider({ purpose: row.purpose, label: row.label ?? null });
  if (!owner) return null;
  const shape = providerDescriptor(owner.provider).shapes.find(s => s.id === owner.shape);
  if (!shape) return null;
  const label = (row.label ?? '').toLowerCase();
  const storage = [shape.storage, ...shape.legacy].find(st => st.purpose === row.purpose && (st.label === undefined || st.label === label));
  return storage ? { provider: owner.provider, shape, storage } : null;
}

/**
 * What writing (or removing) a shared row of this purpose + label needs, by
 * the same rule as `/api/providers` (`writePermissions`): a key agent runs
 * read that is also a chat key needs both `manage_team_model_keys` and
 * `manage_team_credentials`. For a route that is handed a raw purpose
 * (`/api/secrets`, `/api/inference-keys`). Null when the row is not an API key
 * or seat token in the registry (a gateway, an endpoint, a non-model secret):
 * the route keeps its own rule for those.
 */
export function storedWritePermissions(row: { purpose: string; label?: string | null }): WritePermission[] | null {
  const found = storageOf(row);
  if (!found || found.shape.id === 'gateway' || found.shape.id === 'endpoint') return null;
  return writePermissions(found.shape, found.storage);
}

/** Prefixes the legacy agent purposes have always required. */
const LEGACY_PREFIX: Record<string, string> = {
  oauth_token: 'sk-ant-oat',
  anthropic_api_key: 'sk-ant-api',
  // Loose on purpose: OpenAI keys come in several live shapes (sk-, sk-proj-, sk-svcacct-).
  openai_api_key: 'sk-',
};

/**
 * The prefix a shared (team or workspace) row of this purpose + label must
 * have, or undefined. A legacy agent purpose keeps its own. A canonical key
 * that agent runs read keeps the prefix of its legacy alias, so a pasted
 * subscription token (`sk-ant-oat…`) is refused as an Anthropic API key
 * wherever it is written.
 */
export function requiredKeyPrefix(row: { purpose: string; label?: string | null }): string | undefined {
  const own = LEGACY_PREFIX[row.purpose];
  if (own) return own;
  const found = storageOf(row);
  if (!found) return undefined;
  if (!storageServes(providerDescriptor(found.provider), found.storage).some(s => AGENT_SURFACES.includes(s))) return undefined;
  for (const legacy of found.shape.legacy) {
    const prefix = LEGACY_PREFIX[legacy.purpose];
    if (prefix) return prefix;
  }
  return undefined;
}

/**
 * Where a write of this shape lands at each scope, and what it needs: the
 * `writesTo` of `GET /api/providers`, so the Providers page shows the
 * server's own rule instead of restating it. Null for a scope closed to the
 * provider; `mine` needs no permission (membership and the team policy decide).
 */
export function shapeWritesTo(provider: ProviderId, shape: CredentialShape): Record<ProviderApiScope, { purpose: string; label: string | null; permissions: WritePermission[] } | null> {
  const out = {} as Record<ProviderApiScope, { purpose: string; label: string | null; permissions: WritePermission[] } | null>;
  for (const scope of PROVIDER_API_SCOPES) {
    if (scopeRefusal(provider, scope)) { out[scope] = null; continue; }
    const st = writeStorage(provider, shape, scope);
    out[scope] = { purpose: st.purpose, label: st.label ?? null, permissions: scope === 'mine' ? [] : writePermissions(shape, st) };
  }
  return out;
}
