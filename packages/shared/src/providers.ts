/**
 * `/api/providers`: every model provider, what it serves, and the credentials
 * set for it per scope. Never a credential value: a stored row is described
 * by its last four characters and health only.
 *
 * Provider, surface and shape ids are the provider registry's
 * (`@buildd/core/providers`), restated as strings here because shared does not
 * depend on core.
 */

export type ProviderApiScope = 'team' | 'workspace' | 'mine';
/** A permission a provider credential write can need (`@buildd/core/providers/manage` `writePermissions`). */
export type ProviderWritePermission = 'manage_team_model_keys' | 'manage_team_credentials' | 'manage_inference_providers';
export type ProviderSurfaceId = 'chat' | 'agent-claude' | 'agent-codex' | 'cloud-egress';
export type ProviderShapeId = 'api_key' | 'setup_token' | 'oauth_managed' | 'gateway' | 'endpoint';
export type CredentialPolicyValue = 'team' | 'personal_first' | 'personal_only';
export type ProviderPrincipal = 'person' | 'key' | 'task_token';

export type ProviderSurfaceSupport =
  | { ok: true; via: string }
  | { ok: false; reason: string; instead?: readonly string[] };

/** One stored credential row, described without its value. */
export interface ProviderCredentialSummary {
  id: string;
  provider: string;
  shape: ProviderShapeId;
  scope: ProviderApiScope;
  workspaceId: string | null;
  /** Scoped to one API account (an older Runners write); read only for that account's claims. */
  accountScoped: boolean;
  /** `secrets.purpose` / `label` the row is stored under. */
  purpose: string;
  label: string | null;
  /** Stored under a legacy alias, not the provider's canonical storage. */
  legacy: boolean;
  /** `agent_endpoint` rows: what the endpoint routes to. */
  endpointKind?: string;
  /** Last four characters of the key; null for a seat's refresh family, '' when unreadable. */
  last4: string | null;
  health: 'healthy' | 'revoked' | 'unknown' | string;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  updatedAt: string | null;
  /** Surfaces whose readers use this row today. */
  servesToday: ProviderSurfaceId[];
}

export interface ProviderShapeListing {
  id: ProviderShapeId;
  refreshes: boolean;
  /** Connected in the browser, never pasted (subscription seats). */
  connectInBrowser: boolean;
  /**
   * Where a write at each scope is stored, and every permission it needs (all
   * of them; empty for `mine`); null when the scope is closed to this provider.
   */
  writesTo: Record<ProviderApiScope, { purpose: string; label: string | null; permissions: ProviderWritePermission[] } | null>;
}

export interface ProviderListing {
  id: string;
  label: string;
  order: number;
  connectFlow: 'paste' | 'oauth' | 'form';
  /** Per surface: served (and how), or the registry's reason it cannot be. */
  surfaces: Record<ProviderSurfaceId, ProviderSurfaceSupport>;
  /** Per scope: open, or why not. */
  scopes: Record<ProviderApiScope, { ok: true } | { ok: false; reason: string }>;
  shapes: ProviderShapeListing[];
  /** Rows set at each scope. `workspace` is null without a workspaceId; `mine` is null with no person. */
  set: {
    team: ProviderCredentialSummary[];
    workspace: ProviderCredentialSummary[] | null;
    mine: ProviderCredentialSummary[] | null;
  };
}

export interface ProviderPolicySummary {
  /** `teams.credential_policy` as set; null = never set (agent runs then use team credentials only). */
  credentialPolicy: CredentialPolicyValue | null;
  chat: { policy: CredentialPolicyValue; source: string };
  agent: { policy: CredentialPolicyValue; enforced: boolean; source: string };
}

/** `GET /api/providers?teamId=&workspaceId=` */
export interface ListProvidersResponse {
  teamId: string;
  workspaceId: string | null;
  caller: {
    principal: ProviderPrincipal;
    /** Permissions held for team/workspace writes and the policy. */
    can: {
      manage_team_model_keys: boolean;
      manage_team_credentials: boolean;
      manage_inference_providers: boolean;
      manage_team_settings: boolean;
    };
    /** Can set `mine`: a signed-in person. */
    canSetMine: boolean;
  };
  policy: ProviderPolicySummary;
  providers: ProviderListing[];
}

/** `PUT /api/providers` */
export interface SetProviderCredentialRequest {
  teamId?: string;
  provider: string;
  shape?: ProviderShapeId;
  scope: ProviderApiScope;
  workspaceId?: string | null;
  /** The key or token (api_key, setup_token; the gateway/endpoint key). */
  value?: string;
  /** gateway: { baseUrl }; endpoint: { baseUrl, authHeader?, models?, appliesTo?, capabilities?, kind? }. */
  config?: Record<string, unknown>;
  /** Refuse (422) when the provider cannot serve this surface. */
  surface?: ProviderSurfaceId;
}

/** `PUT /api/providers` and `DELETE /api/providers` success. */
export interface ProviderCredentialWriteResponse {
  provider: string;
  scope: ProviderApiScope;
  workspaceId: string | null;
  /** Rows now set for the provider at that scope. */
  credentials: ProviderCredentialSummary[];
  /** DELETE: rows removed. */
  deleted?: number;
  /** PUT of an agent credential: auth-failed tasks put back in the queue. */
  requeued?: number;
}

/** `GET /api/providers/explain?surface=&provider=&workspaceId=&as=` */
export interface ExplainProviderResponse {
  surface: ProviderSurfaceId;
  /** Whose work the answer is for: the caller (`self`) or team work with no requester (`team`). */
  as: 'self' | 'team';
  workspaceId: string | null;
  result:
    | { resolved: true; provider: string; shape: ProviderShapeId; scope: string; source: { scope: string; secretId: string | null; purpose: string | null; label: string | null; legacy: boolean; envVar?: string } }
    | { resolved: false; reason: string };
  /** Ordered trail: what was considered and why it lost. No values. */
  why: string[];
}

/** 422 body for an impossible provider × surface or provider × scope pair. */
export interface ProviderRefusal {
  error: 'provider_surface_unsupported' | 'provider_scope_unsupported' | 'connect_in_browser';
  provider: string;
  surface?: ProviderSurfaceId;
  scope?: ProviderApiScope;
  /** The registry's string, verbatim. */
  reason: string;
  instead?: readonly string[];
  url?: string;
}
