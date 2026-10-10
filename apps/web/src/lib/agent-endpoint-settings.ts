/**
 * The team's agent model endpoint as Settings → Model providers manages it
 * (storage, precedence and resolution: @buildd/core/agent-endpoint; design:
 * docs/design/agent-model-endpoint.md §4, §6). The key never leaves the
 * server: callers get the base URL, the key's last four characters and health.
 *
 * Rows are team-wide or one workspace, never account- or person-scoped. The
 * team-wide row may narrow itself to some workspaces (`appliesTo` in its blob,
 * @buildd/core/agent-endpoint); `setAgentEndpointAppliesTo` edits that list
 * without the key and can fold matching per-workspace copies into it.
 */
import { db } from '@buildd/core/db';
import { modelTierRegistry, secrets, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { decrypt, encrypt, getSecretsProvider } from '@buildd/core/secrets';
import { maskKeyLast4 } from '@buildd/core/inference-keys';
import type { LookupAll } from '@buildd/core/net/public-address';
import { normalizeGatewayUrl, resolveLiteLLMGateway, type LiteLLMGateway } from '@buildd/core/litellm-gateway';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { TIERS, bundledTierEntry } from '@buildd/core/model-tier-defaults';
import {
  buildEndpointModelRows,
  deriveModelAliases,
  listAgentEndpointModels,
  selectProbeModel,
  usableListedModels,
  type EndpointModelRow,
} from '@buildd/core/agent-endpoint-models';
import {
  AGENT_ENDPOINT_PURPOSE,
  effectiveToolSearch,
  isOpenRouterReference,
  mapAgentModel,
  parseAgentEndpointBlob,
  parseAppliesTo,
  resolveEndpointFromBlob,
  resolveEndpointRefs,
  resolveStoredOpenRouterKey,
  serializeAgentEndpoint,
  validateAgentEndpointInput,
  verifyAgentEndpoint,
  type AgentEndpointAuthHeader,
  type AgentEndpointBlob,
  type AgentEndpointKind,
  type AgentEndpointRoute,
  type AgentModelMap,
  type CloudflareEndpointRef,
} from '@buildd/core/agent-endpoint';

export type EndpointHealth = 'healthy' | 'revoked' | 'unknown';

export interface EndpointWorkspaceRef { id: string; name: string }

export interface MaskedAgentEndpoint {
  id: string;
  scope: 'team' | 'workspace';
  workspaceId: string | null;
  workspaceName: string | null;
  /**
   * Team row: the workspaces it applies to, or null for all of them. Ids that
   * left the team or were deleted are dropped here. Workspace rows: null.
   */
  appliesTo: EndpointWorkspaceRef[] | null;
  /** Workspace row: routes exactly like the team row (same kind, URL, key, header and aliases). */
  matchesTeam: boolean;
  kind: AgentEndpointKind;
  /** Effective Anthropic-compatible root ('' when a gateway reference has no gateway). */
  baseUrl: string;
  authHeader: AgentEndpointAuthHeader;
  models: AgentModelMap;
  /** Every model buildd asks this endpoint for, its tiers, and the name sent (read-only view). */
  mapping: EndpointModelMapping[];
  /**
   * Claude deferred MCP/tool loading through this endpoint: the effective
   * value (`effectiveToolSearch`), and whether it was set explicitly rather
   * than taken from the kind's default (OpenRouter on, others off).
   */
  toolSearch: boolean;
  toolSearchExplicit: boolean;
  /** Last four characters of the key in use (the gateway's key for `kind: gateway`). */
  last4: string;
  /** `kind: gateway`: whether the referenced gateway currently resolves. `cloudflare`: whether the team's Cloudflare credential has an AI Gateway. */
  gatewayMissing: boolean;
  /**
   * `kind: openrouter`: where its key comes from. `stored` = a reference to the
   * team's (or this workspace's) OpenRouter key; `inline` = a key saved with
   * the endpoint itself (legacy). Null for other kinds.
   */
  keySource: 'stored' | 'inline' | null;
  /** `stored`: no OpenRouter key resolves for it right now. `cloudflare`: no key for its upstream resolves. */
  storedKeyMissing: boolean;
  /** `cloudflare`: the provider its AI Gateway forwards to. Null for other kinds. */
  upstream: 'anthropic' | 'openrouter' | null;
  /** `cloudflare`: an AI Gateway Run token is saved (its value never comes back). */
  gatewayTokenSet: boolean;
  /**
   * The consolidation backfill found this row's inline key differs from the
   * stored OpenRouter key at its scope: someone should pick one. Saving the
   * row again (blank key = the stored one) clears it.
   */
  legacyInlineKey: boolean;
  health: EndpointHealth;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  updatedAt: string;
}

export interface EndpointModelMapping {
  model: string;
  tiers: string[];
  /** The wire name (mapAgentModel): the alias, the OpenRouter id, or the model itself. */
  sent: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
/** Test seam: DNS for the verification call's public-address check. */
type VerifyDeps = { fetcher?: Fetcher; lookup?: LookupAll };

/**
 * The model Verify asks for: the budget tier (§4). selectProbeModel turns it
 * into the name actually sent, from the alias table and the endpoint's own
 * `/v1/models` list.
 */
export const VERIFY_MODEL = bundledTierEntry('budget').model;

/** Listed models a refusal message names, at most. */
const USABLE_SHOWN = 3;

/**
 * The models buildd's agents will ask an endpoint for, and the tier each
 * serves: every tier default plus the team's Anthropic agent (or shared)
 * registry rows. `hints`: for each of them, what the team routes the same tier
 * to elsewhere (another provider or the chat surface), which the mapping uses
 * as a prefill. A failed registry read leaves the defaults.
 */
async function agentTierModels(teamId: string): Promise<{ wanted: Array<{ model: string; tiers: string[] }>; hints: Record<string, string[]> }> {
  const wanted: Array<{ model: string; tiers: string[] }> = [];
  for (const t of TIERS) {
    const d = bundledTierEntry(t);
    if (d.provider === 'anthropic') wanted.push({ model: d.model, tiers: [t] });
  }
  let rows: Array<{ tier: string; provider: string; model: string; surface: string | null }> = [];
  try {
    rows = (await db.query.modelTierRegistry.findMany({
      where: eq(modelTierRegistry.teamId, teamId),
      columns: { tier: true, provider: true, model: true, surface: true, workspaceId: true },
    })) ?? [];
  } catch {
    rows = [];
  }
  const isAgentAnthropic = (r: { provider: string; surface: string | null }) => r.provider === 'anthropic' && (r.surface === null || r.surface === 'agent');
  for (const r of rows) if (isAgentAnthropic(r)) wanted.push({ model: r.model, tiers: [r.tier] });
  const hints: Record<string, string[]> = {};
  for (const w of wanted) {
    for (const r of rows) {
      if (!w.tiers.includes(r.tier) || (isAgentAnthropic(r) && r.model === w.model)) continue;
      const list = (hints[w.model] ??= []);
      if (!list.includes(r.model)) list.push(r.model);
    }
  }
  return { wanted, hints };
}

/** The read-only mapping: tier models plus saved aliases, each with its wire name. */
function mappingFor(blob: AgentEndpointBlob, wanted: Array<{ model: string; tiers: string[] }>): EndpointModelMapping[] {
  const rows = buildEndpointModelRows({ wanted, explicit: blob.models ?? {}, hints: {}, listed: null });
  const upstream = blob.kind === 'cloudflare' ? blob.upstream : undefined;
  return rows.map((r) => ({ model: r.model, tiers: r.tiers, sent: mapAgentModel({ kind: blob.kind, models: blob.models, upstream }, r.model) }));
}

/**
 * The endpoint's `/v1/models` ids (null: no list, or OpenRouter, whose names
 * follow a fixed rule instead of aliases).
 */
/** OpenRouter names models by a fixed rule, directly or behind a Cloudflare gateway. */
function namesByOpenRouterRule(route: Pick<AgentEndpointRoute, 'kind' | 'upstream'>): boolean {
  return route.kind === 'openrouter' || (route.kind === 'cloudflare' && route.upstream === 'openrouter');
}

function discoverModels(route: AgentEndpointRoute, deps: VerifyDeps): Promise<string[] | null> {
  if (namesByOpenRouterRule(route)) return Promise.resolve(null);
  return listAgentEndpointModels(route, { fetcher: deps.fetcher, lookup: deps.lookup });
}

/** The wire model Verify sends for this route and list. */
function probeModelFor(route: AgentEndpointRoute, listed: string[] | null): string {
  if (namesByOpenRouterRule(route)) return mapAgentModel(route, VERIFY_MODEL);
  return selectProbeModel({ verifyModel: VERIFY_MODEL, aliases: route.models, listed }).model;
}

/** Team-owned endpoint rows: never account- or person-scoped. */
const endpointRows = (teamId: string) =>
  teamCredentialWhere({ teamId, purpose: AGENT_ENDPOINT_PURPOSE }, isNull(secrets.accountId));

function gatewayFor(teamId: string, workspaceId: string | null): Promise<LiteLLMGateway | null> {
  // Same scope or broader: a team-wide reference never picks up a workspace gateway.
  return resolveLiteLLMGateway({ teamId, workspaceId }, { ignoreKeyPolicy: true });
}

/**
 * The stored OpenRouter key an `openrouter` reference at this scope routes
 * (same scope or broader). A lookup failure reads as none.
 */
async function storedOpenRouterKey(teamId: string, workspaceId: string | null): Promise<string | null> {
  try {
    return (await resolveStoredOpenRouterKey({ teamId, workspaceId }))?.key ?? null;
  } catch {
    return null;
  }
}

/** A blob as a route, with whatever it references looked up at the row's scope. */
async function routeOf(teamId: string, blob: AgentEndpointBlob | null, workspaceId: string | null): Promise<{
  route: AgentEndpointRoute | null; gateway: LiteLLMGateway | null; cloudflare?: CloudflareEndpointRef | null;
}> {
  if (!blob) return { route: null, gateway: null };
  if (blob.kind === 'cloudflare') {
    // The shared core lookup: the team's gateway ids (never its token) and the upstream key.
    const refs = await resolveEndpointRefs(blob, { teamId, workspaceId }).catch(() => null);
    const cloudflare = refs?.cloudflare ?? null;
    return { route: resolveEndpointFromBlob(blob, null, null, cloudflare), gateway: null, cloudflare };
  }
  const gateway = blob.kind === 'gateway' ? await gatewayFor(teamId, workspaceId) : null;
  const openRouterKey = isOpenRouterReference(blob) ? await storedOpenRouterKey(teamId, workspaceId) : null;
  return { route: resolveEndpointFromBlob(blob, gateway, openRouterKey), gateway };
}

/** Capabilities without the backfill's bookkeeping flag: saving a row is picking its key. */
function withoutLegacyFlag(caps: unknown): unknown {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return caps;
  const { legacyInlineKey: _flag, ...rest } = caps as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function blankKey(raw: Record<string, unknown>): boolean {
  return raw.apiKey === undefined || raw.apiKey === null || (typeof raw.apiKey === 'string' && raw.apiKey.trim() === '');
}

/**
 * An OpenRouter endpoint saved with no key becomes a reference to the stored
 * OpenRouter key when one resolves at this scope: the key lives once, under
 * Team keys, and every surface reads it there. Null when it is not that case
 * (another kind, a typed key, or nothing stored), so the caller falls back to
 * reusing the endpoint's own saved key as before.
 */
async function asOpenRouterReference(teamId: string, workspaceId: string | null, raw: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (raw.kind !== 'openrouter' || !blankKey(raw)) return null;
  if (!(await storedOpenRouterKey(teamId, workspaceId))) return null;
  const { apiKey: _blank, ...rest } = raw;
  return rest;
}

function readBlob(encryptedValue: string): AgentEndpointBlob | null {
  try {
    return parseAgentEndpointBlob(decrypt(encryptedValue));
  } catch {
    return null;
  }
}

/** This team's workspaces by id to name (the query is re-checked in code). */
async function teamWorkspaceNames(teamId: string): Promise<Map<string, string>> {
  const ws = await db.query.workspaces.findMany({
    where: eq(workspaces.teamId, teamId),
    columns: { id: true, name: true, teamId: true },
  });
  const names = new Map<string, string>();
  for (const w of ws ?? []) if (w.teamId === teamId) names.set(w.id, w.name);
  return names;
}

/** The listed ids that are still this team's workspaces, named, in list order. */
function namedRefs(ids: readonly string[], names: Map<string, string>): EndpointWorkspaceRef[] {
  return ids.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }));
}

function sameModels(a: AgentModelMap, b: AgentModelMap): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Two rows route identically: same kind, Anthropic root, key, header,
 * aliases and effective tool search. Only then is a per-workspace copy redundant with the team row; any
 * difference (a key, a URL, an alias, a gateway that resolves elsewhere) keeps it.
 */
function sameRoute(a: AgentEndpointRoute | null, b: AgentEndpointRoute | null): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey &&
    a.authHeader === b.authHeader && sameModels(a.models, b.models) && a.toolSearch === b.toolSearch &&
    a.upstream === b.upstream && sameModels(a.headers ?? {}, b.headers ?? {});
}

/**
 * `appliesTo` from a settings call: undefined/null means all workspaces; else
 * every id must be one of this team's workspaces (400 otherwise).
 */
async function resolveAppliesTo(teamId: string, raw: unknown): Promise<{ ok: true; appliesTo: string[] | undefined; names: Map<string, string> } | Refusal> {
  const parsed = parseAppliesTo(raw);
  if (parsed.ok === false) return { ok: false, status: 400, error: parsed.error };
  const names = await teamWorkspaceNames(teamId);
  if (parsed.appliesTo?.some((id) => !names.has(id))) {
    return { ok: false, status: 400, error: 'appliesTo names a workspace that is not in this team.' };
  }
  return { ok: true, appliesTo: parsed.appliesTo, names };
}

export async function listTeamAgentEndpoints(teamId: string): Promise<MaskedAgentEndpoint[]> {
  const rows = await db.query.secrets.findMany({
    where: endpointRows(teamId),
    columns: {
      id: true, workspaceId: true, accountId: true, userId: true, purpose: true, encryptedValue: true,
      healthStatus: true, lastVerifiedAt: true, lastVerificationError: true, updatedAt: true,
    },
  });
  const mine = rows.filter((r) => r.purpose === AGENT_ENDPOINT_PURPOSE && !r.accountId && !r.userId);
  const names = mine.length > 0 ? await teamWorkspaceNames(teamId) : new Map<string, string>();

  const out: MaskedAgentEndpoint[] = [];
  const tierModels = mine.length > 0 ? await agentTierModels(teamId) : { wanted: [], hints: {} };
  const read = await Promise.all(mine.map(async (r) => {
    const blob = readBlob(r.encryptedValue);
    return { r, blob, ...(await routeOf(teamId, blob, r.workspaceId)) };
  }));
  const teamRoute = read.find((x) => !x.r.workspaceId)?.route ?? null;
  for (const { r, blob, gateway, route, cloudflare } of read) {
    out.push({
      id: r.id,
      scope: r.workspaceId ? 'workspace' : 'team',
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceId ? names.get(r.workspaceId) ?? null : null,
      appliesTo: !r.workspaceId && blob?.appliesTo ? namedRefs(blob.appliesTo, names) : null,
      matchesTeam: !!r.workspaceId && sameRoute(route, teamRoute),
      kind: blob?.kind ?? 'anthropic-compatible',
      baseUrl: route?.baseUrl ?? '',
      authHeader: route?.authHeader ?? 'authorization',
      models: blob?.models ?? {},
      mapping: blob ? mappingFor(blob, tierModels.wanted) : [],
      toolSearch: blob ? effectiveToolSearch(blob.kind, blob.capabilities) : false,
      toolSearchExplicit: typeof blob?.capabilities?.toolSearch === 'boolean',
      last4: route ? maskKeyLast4(route.apiKey) : '',
      gatewayMissing: (blob?.kind === 'gateway' && !gateway) || (blob?.kind === 'cloudflare' && !cloudflare?.gatewayId),
      keySource: blob?.kind === 'openrouter' ? (isOpenRouterReference(blob) ? 'stored' : 'inline') : null,
      storedKeyMissing: !!blob && ((isOpenRouterReference(blob) && !route) || (blob.kind === 'cloudflare' && !!cloudflare?.gatewayId && !cloudflare.upstreamKey)),
      upstream: blob?.kind === 'cloudflare' ? blob.upstream : null,
      gatewayTokenSet: blob?.kind === 'cloudflare' && !!blob.gatewayToken,
      legacyInlineKey: blob?.kind === 'openrouter' && blob.capabilities?.legacyInlineKey === true,
      health: (r.healthStatus as EndpointHealth) ?? 'unknown',
      lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
      lastVerificationError: blob ? r.lastVerificationError ?? null : 'stored endpoint could not be read',
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  // Team row first, then workspaces by name.
  return out.sort((a, b) =>
    (a.scope === 'team' ? 0 : 1) - (b.scope === 'team' ? 0 : 1) ||
    (a.workspaceName ?? '').localeCompare(b.workspaceName ?? ''));
}

async function recordHealth(id: string, check: { health: EndpointHealth; error: string | null }): Promise<Date> {
  const now = new Date();
  await db.update(secrets).set({
    healthStatus: check.health,
    lastVerifiedAt: now,
    lastVerificationError: check.error,
    ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
    updatedAt: now,
  }).where(eq(secrets.id, id));
  return now;
}

type Refusal = { ok: false; status: number; error: string };

/** The scope a settings call names: null for team-wide, else one of this team's workspaces. */
async function resolveScope(teamId: string, raw: unknown): Promise<{ ok: true; workspaceId: string | null } | Refusal> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, workspaceId: null };
  if (typeof raw !== 'string') return { ok: false, status: 400, error: 'workspaceId must be a workspace id.' };
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, raw),
    columns: { id: true, teamId: true, name: true },
  });
  if (!ws || ws.teamId !== teamId) return { ok: false, status: 404, error: 'Workspace not found in this team.' };
  return { ok: true, workspaceId: ws.id };
}

/** The stored endpoint at exactly this scope, decrypted, or null. */
async function storedBlobAt(teamId: string, workspaceId: string | null): Promise<AgentEndpointBlob | null> {
  const rows = await db.query.secrets.findMany({
    where: endpointRows(teamId),
    columns: { id: true, workspaceId: true, accountId: true, userId: true, purpose: true, encryptedValue: true },
  });
  const row = (rows ?? []).find((r) => r.purpose === AGENT_ENDPOINT_PURPOSE && !r.accountId && !r.userId && (r.workspaceId ?? null) === workspaceId);
  return row ? readBlob(row.encryptedValue) : null;
}

/**
 * The editor's input with the saved key filled in when the key field was left
 * blank: only for the same kind and the same normalised URL at the same scope,
 * so a saved key is never sent anywhere it was not saved for. The saved auth
 * header comes along unless the input names one. Null: blank key and nothing
 * to reuse. Input with a key (or a kind that has none) passes through.
 */
function withStoredKey(input: Record<string, unknown>, stored: AgentEndpointBlob | null): Record<string, unknown> | null {
  const raw: Record<string, unknown> = { ...input };
  if (raw.kind === 'cloudflare') {
    // A blank gateway token keeps the saved one; null removes it.
    const blank = raw.gatewayToken === undefined || (typeof raw.gatewayToken === 'string' && raw.gatewayToken.trim() === '');
    if (blank) {
      delete raw.gatewayToken;
      if (stored?.kind === 'cloudflare' && stored.gatewayToken) raw.gatewayToken = stored.gatewayToken;
    } else if (raw.gatewayToken === null) {
      delete raw.gatewayToken;
    }
    return raw;
  }
  if (raw.kind !== 'anthropic-compatible' && raw.kind !== 'openrouter') return raw;
  if (typeof raw.apiKey === 'string' ? raw.apiKey.trim() !== '' : raw.apiKey !== undefined && raw.apiKey !== null) return raw;
  if (!stored || stored.kind !== raw.kind) return null;
  const url = raw.baseUrl;
  if (url !== undefined && url !== null && url !== '' && (typeof url !== 'string' || normalizeGatewayUrl(url) !== stored.baseUrl)) return null;
  raw.apiKey = stored.apiKey;
  raw.baseUrl = stored.baseUrl;
  if (raw.authHeader === undefined || raw.authHeader === null || raw.authHeader === '') raw.authHeader = stored.authHeader;
  return raw;
}

export interface AgentEndpointModelPreview {
  ok: true;
  /** Whether the endpoint returned a model list. False: the editor falls back to typed aliases. */
  available: boolean;
  /** The endpoint's model ids (empty without a list). */
  listed: string[];
  /** One row per model buildd will ask for, prefilled (agent-endpoint-models buildEndpointModelRows). */
  rows: EndpointModelRow[];
}

/**
 * What the endpoint the editor describes serves, and a prefilled mapping for
 * every model buildd will ask it for. Nothing is stored. With no key in the
 * input, the stored endpoint at the same scope supplies it, but only for the
 * same kind and URL, so a key is never sent anywhere it was not saved for.
 * The reply carries model ids only, never the key or the endpoint's body.
 */
export async function previewAgentEndpointModels(
  input: { teamId: string; workspaceId?: unknown; endpoint: unknown },
  deps: VerifyDeps = {},
): Promise<AgentEndpointModelPreview | Refusal> {
  const scope = await resolveScope(input.teamId, input.workspaceId);
  if (!scope.ok) return scope;
  if (!input.endpoint || typeof input.endpoint !== 'object' || Array.isArray(input.endpoint)) {
    return { ok: false, status: 400, error: 'An endpoint needs a kind.' };
  }
  const stored = await storedBlobAt(input.teamId, scope.workspaceId);
  const endpointInput = input.endpoint as Record<string, unknown>;
  const raw = await asOpenRouterReference(input.teamId, scope.workspaceId, endpointInput) ?? withStoredKey(endpointInput, stored);
  if (!raw) return { ok: false, status: 400, error: 'Enter the key to list this endpoint\'s models.' };
  const v = validateAgentEndpointInput(raw);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const { route, gateway } = await routeOf(input.teamId, v.blob, scope.workspaceId);
  if (v.blob.kind === 'gateway' && !gateway) {
    return { ok: false, status: 400, error: 'Connect a LiteLLM gateway first: this option uses its URL and key.' };
  }
  if (!route) return { ok: false, status: 400, error: 'That endpoint routes nothing.' };

  const listed = await discoverModels(route, deps);
  // Aliases typed in the editor, else the ones saved at this scope.
  const explicit = v.blob.models ?? (stored && stored.kind === v.blob.kind ? stored.models : undefined) ?? {};
  const { wanted, hints } = await agentTierModels(input.teamId);
  return {
    ok: true,
    available: listed !== null,
    listed: listed ?? [],
    rows: v.blob.kind === 'openrouter' ? [] : buildEndpointModelRows({ wanted, explicit, hints, listed }),
  };
}

/**
 * Check with one real call, then store. An endpoint that rejects the key is
 * never saved; an outage (`unknown`) is saved and shown as unchecked.
 */
export async function setTeamAgentEndpoint(
  input: { teamId: string; workspaceId?: unknown; endpoint: unknown },
  deps: VerifyDeps = {},
): Promise<{ ok: true; endpoint: MaskedAgentEndpoint } | { ok: false; status: number; error: string }> {
  const scope = await resolveScope(input.teamId, input.workspaceId);
  if (!scope.ok) return scope;
  const workspaceId = scope.workspaceId;

  // A blank key keeps the saved one, for the same endpoint only.
  let endpoint = input.endpoint;
  // Which workspaces a team row applies to: the call's list when it names one
  // (null = all), else the saved row's, so re-saving never silently widens it.
  let appliesTo: string[] | undefined;
  let names: Map<string, string> | null = null;
  if (endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint)) {
    const { appliesTo: rawAppliesTo, ...rest } = endpoint as Record<string, unknown>;
    const stored = await storedBlobAt(input.teamId, workspaceId);
    if (workspaceId) {
      if (rawAppliesTo !== undefined && rawAppliesTo !== null) {
        return { ok: false, status: 400, error: 'A workspace endpoint applies to its own workspace only.' };
      }
    } else if (rawAppliesTo !== undefined) {
      const a = await resolveAppliesTo(input.teamId, rawAppliesTo);
      if (!a.ok) return a;
      appliesTo = a.appliesTo;
      names = a.names;
    } else {
      appliesTo = stored?.appliesTo;
    }
    // OpenRouter with a blank key: the stored OpenRouter key when there is
    // one, else the endpoint's own saved key as before.
    const filled = await asOpenRouterReference(input.teamId, workspaceId, rest) ?? withStoredKey(rest, stored);
    if (!filled) return { ok: false, status: 400, error: 'Enter the key for this endpoint.' };
    // Capabilities: the call's when it names them (null = the kind's
    // defaults), else the saved row's for the same kind, so re-saving never
    // silently flips deferred tool loading.
    if (filled.capabilities === undefined && stored?.capabilities && stored.kind === filled.kind) {
      filled.capabilities = stored.capabilities;
    }
    // Saving is picking the key, so the backfill's "two different keys" flag goes.
    filled.capabilities = withoutLegacyFlag(filled.capabilities);
    endpoint = filled;
  }
  const v = validateAgentEndpointInput(endpoint);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const { route, gateway, cloudflare } = await routeOf(input.teamId, v.blob, workspaceId);
  if (v.blob.kind === 'gateway' && !gateway) {
    return { ok: false, status: 400, error: 'Connect a LiteLLM gateway first: this option uses its URL and key.' };
  }
  if (v.blob.kind === 'cloudflare') {
    if (!cloudflare?.gatewayId) {
      return { ok: false, status: 400, error: 'Add the team\'s Cloudflare credential with an AI Gateway ID first: this option sends agents through that gateway.' };
    }
    if (!cloudflare.upstreamKey) {
      const which = v.blob.upstream === 'openrouter' ? 'an OpenRouter key' : 'an Anthropic API key';
      return { ok: false, status: 400, error: `Add ${which} for the team first: the gateway forwards to it with that key.` };
    }
  }
  if (!route) return { ok: false, status: 400, error: 'That endpoint routes nothing.' };

  // The endpoint's own list, when it has one: Verify probes a name this key
  // may use, and tier models it lists only under another name get a
  // same-model alias. No list: exactly what Verify did before lists existed.
  const listed = await discoverModels(route, deps);
  const check = await verifyAgentEndpoint(route, probeModelFor(route, listed), { fetcher: deps.fetcher, lookup: deps.lookup, wire: true });
  if (check.health === 'revoked') {
    return { ok: false, status: 400, error: `The endpoint rejected this key. ${check.error ?? ''}`.trim() };
  }
  if (check.refusedModel) {
    // The key works but may not reach this model: not saved, since agents would
    // be refused the same way. The fix is an alias, which the message names.
    const usable = listed ? usableListedModels(listed.filter((m) => m !== check.refusedModel), USABLE_SHOWN) : [];
    const hint = usable.length > 0 ? ` This key lists ${usable.map((m) => `"${m}"`).join(', ')}.` : '';
    return { ok: false, status: 400, error: `The endpoint refused the model "${check.refusedModel}" for this key.${hint} Add a model alias that points it at a model this key is allowed to use, then save again.` };
  }
  if (check.blocked) {
    return { ok: false, status: 400, error: `This endpoint URL can't be used: ${check.error}.` };
  }

  // One alias store: same-model aliases buildd found go into `models`, under
  // the person's own (which always win).
  let blob = v.blob;
  const tierModels = await agentTierModels(input.teamId);
  if (!namesByOpenRouterRule(route) && listed) {
    const explicit = blob.models ?? {};
    const derived = deriveModelAliases({ models: tierModels.wanted.map((w) => w.model), explicit, listed });
    if (Object.keys(derived).length > 0) blob = { ...blob, models: { ...derived, ...explicit } };
  }
  if (appliesTo) blob = { ...blob, appliesTo };

  const id = await getSecretsProvider().replaceScoped(serializeAgentEndpoint(blob), {
    teamId: input.teamId,
    ...(workspaceId ? { workspaceId } : {}),
    purpose: AGENT_ENDPOINT_PURPOSE,
    userId: null,
  });
  const now = await recordHealth(id, check);

  return {
    ok: true,
    endpoint: {
      id,
      scope: workspaceId ? 'workspace' : 'team',
      workspaceId,
      workspaceName: null,
      appliesTo: appliesTo ? namedRefs(appliesTo, names ?? await teamWorkspaceNames(input.teamId)) : null,
      matchesTeam: false,
      kind: route.kind,
      baseUrl: route.baseUrl,
      authHeader: route.authHeader,
      models: blob.models ?? {},
      mapping: mappingFor(blob, tierModels.wanted),
      toolSearch: route.toolSearch,
      toolSearchExplicit: typeof blob.capabilities?.toolSearch === 'boolean',
      last4: maskKeyLast4(route.apiKey),
      gatewayMissing: false,
      keySource: blob.kind === 'openrouter' ? (isOpenRouterReference(blob) ? 'stored' : 'inline') : null,
      storedKeyMissing: false,
      upstream: blob.kind === 'cloudflare' ? blob.upstream : null,
      gatewayTokenSet: blob.kind === 'cloudflare' && !!blob.gatewayToken,
      legacyInlineKey: false,
      health: check.health,
      lastVerifiedAt: now.toISOString(),
      lastVerificationError: check.error,
      updatedAt: now.toISOString(),
    },
  };
}

export interface EndpointCopy {
  workspaceId: string;
  workspaceName: string | null;
  /** Routes exactly like the team row (sameRoute). */
  matches: boolean;
  /** Deleted by this call (only ever a matching copy, only with consolidate). */
  removed: boolean;
}

/**
 * Change which workspaces the team-wide endpoint applies to, without the key:
 * the saved blob is rewritten with the new `appliesTo` (null = all
 * workspaces) and nothing else; no verify call, health untouched.
 *
 * `copies`: every selected workspace (every team workspace for null) that has
 * its own endpoint row, and whether it routes exactly like the team row. With
 * `consolidate: true` those matching copies are deleted, so the workspace now
 * uses the team row. A copy with a different key, URL, header, aliases or
 * gateway is never deleted, and copies outside the selection are not touched.
 */
export async function setAgentEndpointAppliesTo(input: {
  teamId: string;
  appliesTo: unknown;
  consolidate?: unknown;
}): Promise<{ ok: true; endpoint: MaskedAgentEndpoint; copies: EndpointCopy[] } | Refusal> {
  if (input.appliesTo === undefined) {
    return { ok: false, status: 400, error: 'appliesTo is required: a list of workspace ids, or null for all workspaces.' };
  }
  if (input.consolidate !== undefined && typeof input.consolidate !== 'boolean') {
    return { ok: false, status: 400, error: 'consolidate must be true or false.' };
  }
  const a = await resolveAppliesTo(input.teamId, input.appliesTo);
  if (!a.ok) return a;

  const rows = ((await db.query.secrets.findMany({
    where: endpointRows(input.teamId),
    columns: { id: true, workspaceId: true, accountId: true, userId: true, purpose: true, encryptedValue: true },
  })) ?? []).filter((r) => r.purpose === AGENT_ENDPOINT_PURPOSE && !r.accountId && !r.userId);
  const teamRow = rows.find((r) => !r.workspaceId);
  if (!teamRow) return { ok: false, status: 404, error: 'Save a team-wide endpoint first.' };
  const blob = readBlob(teamRow.encryptedValue);
  if (!blob) return { ok: false, status: 409, error: 'The saved endpoint could not be read. Save it again.' };

  const { appliesTo: _previous, ...rest } = blob;
  const next = validateAgentEndpointInput(a.appliesTo ? { ...rest, appliesTo: a.appliesTo } : rest);
  if (!next.ok) return { ok: false, status: 409, error: 'The saved endpoint could not be read. Save it again.' };
  await db.update(secrets)
    .set({ encryptedValue: encrypt(serializeAgentEndpoint(next.blob)), updatedAt: new Date() })
    .where(and(endpointRows(input.teamId), eq(secrets.id, teamRow.id)));

  const selected = new Set(a.appliesTo ?? [...a.names.keys()]);
  const { route: teamRoute } = await routeOf(input.teamId, next.blob, null);
  const copies: EndpointCopy[] = [];
  for (const r of rows) {
    if (!r.workspaceId || !selected.has(r.workspaceId)) continue;
    const { route: wsRoute } = await routeOf(input.teamId, readBlob(r.encryptedValue), r.workspaceId);
    const matches = sameRoute(wsRoute, teamRoute);
    let removed = false;
    if (matches && input.consolidate === true) {
      await getSecretsProvider().delete(r.id);
      removed = true;
    }
    copies.push({ workspaceId: r.workspaceId, workspaceName: a.names.get(r.workspaceId) ?? null, matches, removed });
  }
  copies.sort((x, y) => (x.workspaceName ?? '').localeCompare(y.workspaceName ?? ''));

  const endpoint = (await listTeamAgentEndpoints(input.teamId)).find((e) => e.id === teamRow.id);
  if (!endpoint) return { ok: false, status: 409, error: 'The endpoint changed while saving. Reload and try again.' };
  return { ok: true, endpoint, copies };
}

export async function deleteTeamAgentEndpoint(teamId: string, workspaceId: string | null): Promise<boolean> {
  const deleted = await db.delete(secrets)
    .where(and(endpointRows(teamId), workspaceId ? eq(secrets.workspaceId, workspaceId) : isNull(secrets.workspaceId)))
    .returning({ id: secrets.id });
  return deleted.length > 0;
}

/**
 * POST /api/secrets/[id]/verify for an `agent_endpoint` row: one Messages call
 * through the endpoint, recorded on the row's health columns.
 */
export async function verifyAgentEndpointSecret(
  secretId: string,
  deps: VerifyDeps = {},
): Promise<{ health: EndpointHealth; error: string | null }> {
  const row = await db.query.secrets.findFirst({
    where: eq(secrets.id, secretId),
    columns: { id: true, teamId: true, workspaceId: true, purpose: true, encryptedValue: true },
  });
  if (!row || row.purpose !== AGENT_ENDPOINT_PURPOSE) return { health: 'unknown', error: 'Not an agent endpoint.' };
  const blob = readBlob(row.encryptedValue);
  const { route } = await routeOf(row.teamId, blob, row.workspaceId);
  const missing = blob?.kind === 'gateway'
    ? 'The team gateway this endpoint uses is not connected.'
    : 'No OpenRouter key is stored for this endpoint.';
  const check = route
    ? await verifyAgentEndpoint(route, probeModelFor(route, await discoverModels(route, deps)), { fetcher: deps.fetcher, lookup: deps.lookup, wire: true })
    : { health: 'unknown' as const, error: blob ? missing : 'Stored endpoint could not be read.' };
  await recordHealth(row.id, check);
  return { health: check.health, error: check.error };
}
