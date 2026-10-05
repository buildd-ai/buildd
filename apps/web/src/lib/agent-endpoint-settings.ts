/**
 * The team's agent model endpoint as Settings → Model providers manages it
 * (storage, precedence and resolution: @buildd/core/agent-endpoint; design:
 * docs/design/agent-model-endpoint.md §4, §6). The key never leaves the
 * server: callers get the base URL, the key's last four characters and health.
 *
 * Rows are team-wide or one workspace, never account- or person-scoped.
 */
import { db } from '@buildd/core/db';
import { modelTierRegistry, secrets, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decrypt, getSecretsProvider } from '@buildd/core/secrets';
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
  mapAgentModel,
  parseAgentEndpointBlob,
  resolveEndpointFromBlob,
  serializeAgentEndpoint,
  validateAgentEndpointInput,
  verifyAgentEndpoint,
  type AgentEndpointAuthHeader,
  type AgentEndpointBlob,
  type AgentEndpointKind,
  type AgentEndpointRoute,
  type AgentModelMap,
} from '@buildd/core/agent-endpoint';

export type EndpointHealth = 'healthy' | 'revoked' | 'unknown';

export interface MaskedAgentEndpoint {
  id: string;
  scope: 'team' | 'workspace';
  workspaceId: string | null;
  workspaceName: string | null;
  kind: AgentEndpointKind;
  /** Effective Anthropic-compatible root ('' when a gateway reference has no gateway). */
  baseUrl: string;
  authHeader: AgentEndpointAuthHeader;
  models: AgentModelMap;
  /** Every model buildd asks this endpoint for, its tiers, and the name sent (read-only view). */
  mapping: EndpointModelMapping[];
  /** Last four characters of the key in use (the gateway's key for `kind: gateway`). */
  last4: string;
  /** `kind: gateway`: whether the referenced gateway currently resolves. */
  gatewayMissing: boolean;
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
  return rows.map((r) => ({ model: r.model, tiers: r.tiers, sent: mapAgentModel({ kind: blob.kind, models: blob.models }, r.model) }));
}

/**
 * The endpoint's `/v1/models` ids (null: no list, or OpenRouter, whose names
 * follow a fixed rule instead of aliases).
 */
function discoverModels(route: AgentEndpointRoute, deps: VerifyDeps): Promise<string[] | null> {
  if (route.kind === 'openrouter') return Promise.resolve(null);
  return listAgentEndpointModels(route, { fetcher: deps.fetcher, lookup: deps.lookup });
}

/** The wire model Verify sends for this route and list. */
function probeModelFor(route: AgentEndpointRoute, listed: string[] | null): string {
  if (route.kind === 'openrouter') return mapAgentModel(route, VERIFY_MODEL);
  return selectProbeModel({ verifyModel: VERIFY_MODEL, aliases: route.models, listed }).model;
}

/** Team-owned endpoint rows: never account- or person-scoped. */
const endpointRows = (teamId: string) =>
  teamCredentialWhere({ teamId, purpose: AGENT_ENDPOINT_PURPOSE }, isNull(secrets.accountId));

function gatewayFor(teamId: string, workspaceId: string | null): Promise<LiteLLMGateway | null> {
  // Same scope or broader: a team-wide reference never picks up a workspace gateway.
  return resolveLiteLLMGateway({ teamId, workspaceId }, { ignoreKeyPolicy: true });
}

function readBlob(encryptedValue: string): AgentEndpointBlob | null {
  try {
    return parseAgentEndpointBlob(decrypt(encryptedValue));
  } catch {
    return null;
  }
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
  const wsIds = [...new Set(mine.map((r) => r.workspaceId).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (wsIds.length > 0) {
    const ws = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, wsIds),
      columns: { id: true, name: true, teamId: true },
    });
    for (const w of ws) if (w.teamId === teamId) names.set(w.id, w.name);
  }

  const out: MaskedAgentEndpoint[] = [];
  const tierModels = mine.length > 0 ? await agentTierModels(teamId) : { wanted: [], hints: {} };
  for (const r of mine) {
    const blob = readBlob(r.encryptedValue);
    const gateway = blob?.kind === 'gateway' ? await gatewayFor(teamId, r.workspaceId) : null;
    const route = blob ? resolveEndpointFromBlob(blob, gateway) : null;
    out.push({
      id: r.id,
      scope: r.workspaceId ? 'workspace' : 'team',
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceId ? names.get(r.workspaceId) ?? null : null,
      kind: blob?.kind ?? 'anthropic-compatible',
      baseUrl: route?.baseUrl ?? '',
      authHeader: route?.authHeader ?? 'authorization',
      models: blob?.models ?? {},
      mapping: blob ? mappingFor(blob, tierModels.wanted) : [],
      last4: route ? maskKeyLast4(route.apiKey) : '',
      gatewayMissing: blob?.kind === 'gateway' && !gateway,
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
  const raw = withStoredKey(input.endpoint as Record<string, unknown>, stored);
  if (!raw) return { ok: false, status: 400, error: 'Enter the key to list this endpoint\'s models.' };
  const v = validateAgentEndpointInput(raw);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const gateway = v.blob.kind === 'gateway' ? await gatewayFor(input.teamId, scope.workspaceId) : null;
  if (v.blob.kind === 'gateway' && !gateway) {
    return { ok: false, status: 400, error: 'Connect a LiteLLM gateway first: this option uses its URL and key.' };
  }
  const route = resolveEndpointFromBlob(v.blob, gateway);
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
  if (endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint)) {
    const filled = withStoredKey(endpoint as Record<string, unknown>, await storedBlobAt(input.teamId, workspaceId));
    if (!filled) return { ok: false, status: 400, error: 'Enter the key for this endpoint.' };
    endpoint = filled;
  }
  const v = validateAgentEndpointInput(endpoint);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const gateway = v.blob.kind === 'gateway' ? await gatewayFor(input.teamId, workspaceId) : null;
  if (v.blob.kind === 'gateway' && !gateway) {
    return { ok: false, status: 400, error: 'Connect a LiteLLM gateway first: this option uses its URL and key.' };
  }
  const route = resolveEndpointFromBlob(v.blob, gateway);
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
  if (blob.kind !== 'openrouter' && listed) {
    const explicit = blob.models ?? {};
    const derived = deriveModelAliases({ models: tierModels.wanted.map((w) => w.model), explicit, listed });
    if (Object.keys(derived).length > 0) blob = { ...blob, models: { ...derived, ...explicit } };
  }

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
      kind: route.kind,
      baseUrl: route.baseUrl,
      authHeader: route.authHeader,
      models: blob.models ?? {},
      mapping: mappingFor(blob, tierModels.wanted),
      last4: maskKeyLast4(route.apiKey),
      gatewayMissing: false,
      health: check.health,
      lastVerifiedAt: now.toISOString(),
      lastVerificationError: check.error,
      updatedAt: now.toISOString(),
    },
  };
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
  const gateway = blob?.kind === 'gateway' ? await gatewayFor(row.teamId, row.workspaceId) : null;
  const route = blob ? resolveEndpointFromBlob(blob, gateway) : null;
  const check = route
    ? await verifyAgentEndpoint(route, probeModelFor(route, await discoverModels(route, deps)), { fetcher: deps.fetcher, lookup: deps.lookup, wire: true })
    : { health: 'unknown' as const, error: blob ? 'The team gateway this endpoint uses is not connected.' : 'Stored endpoint could not be read.' };
  await recordHealth(row.id, check);
  return { health: check.health, error: check.error };
}
