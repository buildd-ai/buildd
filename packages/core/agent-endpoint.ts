/**
 * A team's agent model endpoint: the one proxy (a LiteLLM gateway, OpenRouter,
 * or any Anthropic-compatible URL) that runner-spawned agents send model
 * traffic to. Design: docs/design/agent-model-endpoint.md.
 *
 * ## Storage
 *
 * One `secrets` row, purpose `agent_endpoint` (no per-integration table,
 * docs/credentials-architecture.md). Team-wide or narrowed to one workspace;
 * never account- or person-scoped. One row per scope (`replaceScoped`). The
 * encrypted value is a JSON blob:
 *
 *   { "kind": "gateway", "agentBaseUrl"?: "…", "models"?: {…} }
 *       Reference to the team's LiteLLM gateway row (`inference_key`/`litellm`,
 *       same scope or broader): its key, its root minus a trailing `/v1`.
 *   { "kind": "openrouter" | "anthropic-compatible", "baseUrl", "apiKey",
 *     "authHeader"?: "authorization" | "x-api-key", "models"?: {…} }
 *       Self-contained. `baseUrl` is the Anthropic-compatible root;
 *       `/v1/messages` is appended by the client.
 *
 * ## Precedence
 *
 * The endpoint is a model credential ranked against `anthropic_api_key`,
 * `oauth_token` and `claude_credential` in ONE ranking: the most specific scope
 * wins (workspace > account > team), and a tie goes to the endpoint. Only the
 * winner reaches the agent. `resolveAgentModelRoute` applies it; the claim
 * route and `/api/runner/model-endpoint` both call it.
 *
 * The inference key policy does not bind it (§1 "Key policy").
 *
 * ## Module loading
 *
 * Pure helpers at the top; the DB and decryption are imported lazily in the
 * resolvers, so the parse/validate helpers load in a plain bun process (and in
 * the runner).
 */
import { gatewayUrlProblem, normalizeGatewayUrl, resolveLiteLLMGateway, type LiteLLMGateway } from './litellm-gateway';
import { openRouterModelId } from './openrouter-id';

export const AGENT_ENDPOINT_PURPOSE = 'agent_endpoint' as const;
export const OPENROUTER_AGENT_BASE_URL = 'https://openrouter.ai/api';

export const AGENT_ENDPOINT_KINDS = ['gateway', 'openrouter', 'anthropic-compatible'] as const;
export type AgentEndpointKind = typeof AGENT_ENDPOINT_KINDS[number];
export type AgentEndpointAuthHeader = 'authorization' | 'x-api-key';

/** Alias map: native model id → the name the proxy serves it under. */
export type AgentModelMap = Record<string, string>;

export type AgentEndpointBlob =
  | { kind: 'gateway'; agentBaseUrl?: string; models?: AgentModelMap }
  | {
      kind: 'openrouter' | 'anthropic-compatible';
      baseUrl: string;
      apiKey: string;
      authHeader: AgentEndpointAuthHeader;
      models?: AgentModelMap;
    };

/** What a run authenticates with once a blob is resolved. */
export interface AgentEndpointRoute {
  kind: AgentEndpointKind;
  /** Anthropic-compatible root, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  authHeader: AgentEndpointAuthHeader;
  models: AgentModelMap;
}

export type AgentEndpointScope = 'workspace' | 'team';

export interface ResolvedAgentEndpoint extends AgentEndpointRoute {
  secretId: string;
  scope: AgentEndpointScope;
}

// ── Parse / validate ──────────────────────────────────────────────────────────

type Validated = { ok: true; blob: AgentEndpointBlob } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseModels(raw: unknown): { ok: true; models?: AgentModelMap } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isRecord(raw)) return { ok: false, error: 'models must be an object of model id to alias.' };
  const out: AgentModelMap = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (typeof v !== 'string' || !key || !v.trim() || /\s/.test(v.trim())) {
      return { ok: false, error: `The alias for ${key || 'a model'} must be a model name.` };
    }
    out[key] = v.trim();
  }
  return { ok: true, models: Object.keys(out).length > 0 ? out : undefined };
}

function parseAuthHeader(raw: unknown): AgentEndpointAuthHeader | null {
  if (raw === undefined || raw === null || raw === '') return 'authorization';
  if (raw === 'authorization' || raw === 'x-api-key') return raw;
  return null;
}

/**
 * Validate input from the settings API (or a stored blob) into the canonical
 * blob. Key and URL are trimmed; the URL loses trailing slashes.
 */
export function validateAgentEndpointInput(input: unknown): Validated {
  if (!isRecord(input)) return { ok: false, error: 'An endpoint needs a kind.' };
  const kind = input.kind;
  if (typeof kind !== 'string' || !(AGENT_ENDPOINT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of ${AGENT_ENDPOINT_KINDS.join(', ')}.` };
  }
  const models = parseModels(input.models);
  if (models.ok === false) return { ok: false, error: models.error };

  if (kind === 'gateway') {
    if (input.apiKey !== undefined || input.baseUrl !== undefined) {
      return { ok: false, error: 'The gateway option uses the team gateway\'s own URL and key.' };
    }
    const blob: AgentEndpointBlob = { kind: 'gateway' };
    if (input.agentBaseUrl !== undefined && input.agentBaseUrl !== null && input.agentBaseUrl !== '') {
      if (typeof input.agentBaseUrl !== 'string') return { ok: false, error: 'agentBaseUrl must be a URL.' };
      const problem = gatewayUrlProblem(input.agentBaseUrl);
      if (problem) return { ok: false, error: problem };
      blob.agentBaseUrl = normalizeGatewayUrl(input.agentBaseUrl);
    }
    if (models.models) blob.models = models.models;
    return { ok: true, blob };
  }

  const rawUrl = input.baseUrl === undefined || input.baseUrl === '' || input.baseUrl === null
    ? (kind === 'openrouter' ? OPENROUTER_AGENT_BASE_URL : undefined)
    : input.baseUrl;
  if (typeof rawUrl !== 'string') return { ok: false, error: 'baseUrl is required.' };
  const problem = gatewayUrlProblem(rawUrl);
  if (problem) return { ok: false, error: problem };
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey || /\s/.test(apiKey)) return { ok: false, error: 'That doesn\'t look like a key.' };
  const authHeader = parseAuthHeader(input.authHeader);
  if (!authHeader) return { ok: false, error: 'authHeader must be authorization or x-api-key.' };
  const blob: AgentEndpointBlob = { kind: kind as 'openrouter' | 'anthropic-compatible', baseUrl: normalizeGatewayUrl(rawUrl), apiKey, authHeader };
  if (models.models) blob.models = models.models;
  return { ok: true, blob };
}

export function serializeAgentEndpoint(blob: AgentEndpointBlob): string {
  return JSON.stringify(blob);
}

/** The decrypted secret value, or null when it is not a well-formed endpoint. */
export function parseAgentEndpointBlob(value: string | null | undefined): AgentEndpointBlob | null {
  if (!value) return null;
  try {
    const v = validateAgentEndpointInput(JSON.parse(value));
    return v.ok ? v.blob : null;
  } catch {
    return null;
  }
}

/** The gateway's OpenAI root (`…/v1`) as an Anthropic-compatible root. */
export function agentBaseUrlFromGateway(openAiRoot: string): string {
  return normalizeGatewayUrl(openAiRoot).replace(/\/v1$/, '');
}

/** A blob plus (for `kind: gateway`) the gateway it points at, as a route. Null when it routes nothing. */
export function resolveEndpointFromBlob(blob: AgentEndpointBlob, gateway: LiteLLMGateway | null): AgentEndpointRoute | null {
  if (blob.kind === 'gateway') {
    if (!gateway) return null;
    return {
      kind: 'gateway',
      baseUrl: blob.agentBaseUrl ?? agentBaseUrlFromGateway(gateway.baseURL),
      apiKey: gateway.apiKey,
      authHeader: 'authorization',
      models: blob.models ?? {},
    };
  }
  return { kind: blob.kind, baseUrl: blob.baseUrl, apiKey: blob.apiKey, authHeader: blob.authHeader, models: blob.models ?? {} };
}

// ── Model naming (§5) ─────────────────────────────────────────────────────────

/**
 * The wire name for a native model id through this endpoint. OpenRouter gets
 * the chat rule (dotted, undated, `anthropic/` prefix); a gateway or custom
 * URL gets its alias map, else the id unchanged (no `provider/` prefix: Claude
 * Code sends the string verbatim and the alias is what the proxy names).
 */
export function mapAgentModel(endpoint: { kind: AgentEndpointKind; models?: AgentModelMap }, modelId: string): string {
  if (endpoint.kind === 'openrouter') return openRouterModelId('anthropic', modelId);
  return endpoint.models?.[modelId] ?? modelId;
}

// ── Ranking (§2) ──────────────────────────────────────────────────────────────

/** Scope of a competing Anthropic credential row. `account` = account-wide in the team. */
export type ModelCredentialScope = 'workspace' | 'account' | 'team';

const RANK: Record<ModelCredentialScope, number> = { workspace: 2, account: 1, team: 0 };

/**
 * Whether the endpoint wins against the other model credentials that resolve
 * for this task. Most specific scope wins; a tie goes to the endpoint, since
 * setting one is an explicit opt-in to route agents.
 */
export function endpointWinsRanking(endpointScope: AgentEndpointScope, competitors: readonly ModelCredentialScope[]): boolean {
  const best = competitors.reduce((m, s) => Math.max(m, RANK[s]), -1);
  return RANK[endpointScope] >= best;
}

export const COMPETING_MODEL_PURPOSES = ['anthropic_api_key', 'oauth_token', 'claude_credential'] as const;

export interface CompetingCredentialRow {
  purpose: string;
  accountId: string | null;
  workspaceId: string | null;
  healthStatus?: string | null;
  tokenExpiresAt?: Date | null;
}

/**
 * Scopes of the competing rows that could actually be delivered for this task:
 * a live (non-revoked) row of a competing purpose, visible to this workspace
 * and account. A `claude_credential` with no expiry is a dead refresh family
 * (resolveClaudeCredential skips it), so it doesn't compete either.
 * Re-checks the predicates in code so a loose query can't widen them.
 */
export function competingScopes(
  rows: readonly CompetingCredentialRow[],
  ctx: { workspaceId: string; accountId?: string | null },
): ModelCredentialScope[] {
  const out: ModelCredentialScope[] = [];
  for (const r of rows) {
    if (!(COMPETING_MODEL_PURPOSES as readonly string[]).includes(r.purpose)) continue;
    if (r.healthStatus === 'revoked') continue;
    if (r.purpose === 'claude_credential' && !r.tokenExpiresAt) continue;
    if (r.workspaceId && r.workspaceId !== ctx.workspaceId) continue;
    if (r.accountId && r.accountId !== ctx.accountId) continue;
    out.push(r.workspaceId ? 'workspace' : r.accountId ? 'account' : 'team');
  }
  return out;
}

/** Pick the endpoint row: workspace first, then team; revoked skipped; newest first. */
export function rankEndpointRows<T extends { workspaceId: string | null; accountId?: string | null; userId?: string | null; purpose?: string; healthStatus?: string | null; updatedAt?: Date | null }>(
  rows: readonly T[],
  workspaceId: string | null | undefined,
): T[] {
  return rows
    .filter(r =>
      (r.purpose === undefined || r.purpose === AGENT_ENDPOINT_PURPOSE) &&
      !r.accountId && !r.userId &&
      r.healthStatus !== 'revoked' &&
      (!r.workspaceId || r.workspaceId === workspaceId))
    .sort((a, b) =>
      (a.workspaceId ? 0 : 1) - (b.workspaceId ? 0 : 1) ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
}

// ── Resolvers (lazy DB) ───────────────────────────────────────────────────────

/**
 * The endpoint for this team (and workspace): a workspace row first, then the
 * team's; revoked rows skipped, newest first. A `kind: gateway` reference
 * resolves against the gateway at the same scope or broader. Null when there
 * is none or it can't be decrypted/parsed. Never throws.
 */
export async function resolveAgentEndpoint(opts: { teamId: string; workspaceId?: string | null }): Promise<ResolvedAgentEndpoint | null> {
  try {
    const { db } = await import('./db');
    const { secrets } = await import('./db/schema');
    const { eq, isNull, or, sql } = await import('drizzle-orm');
    const { teamCredentialWhere } = await import('./secrets/team-scope');
    const rows = await db.query.secrets.findMany({
      where: teamCredentialWhere(
        { teamId: opts.teamId, purpose: AGENT_ENDPOINT_PURPOSE },
        isNull(secrets.accountId),
        or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
      ),
      columns: { id: true, purpose: true, encryptedValue: true, workspaceId: true, accountId: true, userId: true, healthStatus: true, updatedAt: true },
    });
    const ranked = rankEndpointRows(rows ?? [], opts.workspaceId);
    if (ranked.length === 0) return null;
    const { decrypt } = await import('./secrets');
    for (const r of ranked) {
      try {
        const blob = parseAgentEndpointBlob(decrypt(r.encryptedValue));
        if (!blob) continue;
        const scope: AgentEndpointScope = r.workspaceId ? 'workspace' : 'team';
        let gateway: LiteLLMGateway | null = null;
        if (blob.kind === 'gateway') {
          // Same scope or broader: a team-wide reference never picks up one
          // workspace's gateway.
          gateway = await resolveLiteLLMGateway(
            { teamId: opts.teamId, workspaceId: scope === 'workspace' ? opts.workspaceId : null },
            { ignoreKeyPolicy: true },
          );
        }
        const route = resolveEndpointFromBlob(blob, gateway);
        if (route) return { ...route, secretId: r.id, scope };
      } catch (e) {
        console.error(`[agent-endpoint] failed to read secret ${r.id}:`, e);
      }
    }
  } catch (e) {
    console.warn('[agent-endpoint] lookup failed:', e);
  }
  return null;
}

export type AgentModelDecision =
  | { winner: 'endpoint'; endpoint: ResolvedAgentEndpoint }
  | { winner: 'anthropic'; endpoint: ResolvedAgentEndpoint; beatenBy: ModelCredentialScope };

/**
 * §2 ranking for one task. Null when no endpoint resolves: the caller then
 * does exactly what it did before endpoints existed. Never throws; a failed
 * competitor lookup is treated as "no competitors" only when the endpoint is
 * the most specific possible scope, and otherwise as a loss for the endpoint,
 * so an error can never move a workspace off its own Anthropic key.
 */
export async function resolveAgentModelRoute(opts: {
  teamId: string;
  workspaceId: string;
  accountId?: string | null;
}): Promise<AgentModelDecision | null> {
  const endpoint = await resolveAgentEndpoint(opts);
  if (!endpoint) return null;
  let scopes: ModelCredentialScope[];
  try {
    const { db } = await import('./db');
    const { secrets } = await import('./db/schema');
    const { eq, isNull, or } = await import('drizzle-orm');
    const { teamCredentialWhere } = await import('./secrets/team-scope');
    const rows = await db.query.secrets.findMany({
      where: teamCredentialWhere(
        { teamId: opts.teamId, purpose: COMPETING_MODEL_PURPOSES },
        opts.accountId ? or(isNull(secrets.accountId), eq(secrets.accountId, opts.accountId)) : isNull(secrets.accountId),
        or(isNull(secrets.workspaceId), eq(secrets.workspaceId, opts.workspaceId)),
      ),
      columns: { purpose: true, accountId: true, workspaceId: true, healthStatus: true, tokenExpiresAt: true },
    });
    scopes = competingScopes(rows ?? [], opts);
  } catch (e) {
    console.warn('[agent-endpoint] competitor lookup failed:', e);
    scopes = endpoint.scope === 'workspace' ? [] : ['workspace'];
  }
  if (endpointWinsRanking(endpoint.scope, scopes)) return { winner: 'endpoint', endpoint };
  const beatenBy = scopes.reduce<ModelCredentialScope>((m, s) => (RANK[s] > RANK[m] ? s : m), 'team');
  return { winner: 'anthropic', endpoint, beatenBy };
}

// ── Verify (§4) ───────────────────────────────────────────────────────────────

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One real Messages call through the endpoint: the budget model after mapping,
 * `max_tokens: 1`, with the configured header. 2xx ⇒ healthy, 401/403 ⇒
 * revoked, anything else (an outage, an unknown alias) ⇒ unknown, so an outage
 * never marks it dead. The error text never contains the key.
 */
export async function verifyAgentEndpoint(
  route: AgentEndpointRoute,
  model: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<{ health: 'healthy' | 'revoked' | 'unknown'; error: string | null }> {
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const scrub = (s: string) => s.split(route.apiKey).join('[key]').slice(0, 200);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (route.authHeader === 'x-api-key') headers['x-api-key'] = route.apiKey;
  else headers.authorization = `Bearer ${route.apiKey}`;
  const wireModel = mapAgentModel(route, model);
  try {
    const res = await fetcher(`${route.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: wireModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.ok) return { health: 'healthy', error: null };
    const detail = scrub((await res.text().catch(() => '')).slice(0, 160));
    if (res.status === 401 || res.status === 403) {
      return { health: 'revoked', error: scrub(`endpoint rejected the key (HTTP ${res.status})${detail ? `: ${detail}` : ''}`) };
    }
    return { health: 'unknown', error: scrub(`endpoint returned HTTP ${res.status} for ${wireModel}${detail ? `: ${detail}` : ''}`) };
  } catch (e) {
    return { health: 'unknown', error: scrub(`could not reach the endpoint: ${e instanceof Error ? e.message : String(e)}`) };
  }
}
