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
 * Either shape may carry `"appliesTo": ["<workspace id>", …]` on the team-wide
 * row: the endpoint then applies to those workspaces only (absent = all).
 *
 * Either shape may also carry `"capabilities": { "toolSearch"?: boolean }`:
 * what the endpoint's wire protocol supports beyond plain Messages calls.
 * `toolSearch` is Claude's deferred MCP/tool loading (ToolSearch +
 * `tool_reference` blocks), which Claude Code turns off by itself whenever
 * ANTHROPIC_BASE_URL is not Anthropic. Effective value per kind
 * (`effectiveToolSearch`): `openrouter` on unless explicitly false;
 * `gateway` and `anthropic-compatible` off unless explicitly true. The runner
 * sets ENABLE_TOOL_SEARCH=true for a Claude run only when the endpoint that
 * won for that task says so.
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
 * ## Codex
 *
 * The same row also routes Codex tasks, when it has an OpenAI-compatible
 * route: `gateway` (LiteLLM) and `openrouter` both do, `anthropic-compatible`
 * does not (`AgentEndpointRoute.openAiBaseUrl`). Ranking is the same shape,
 * against the Codex-side credentials instead (`resolveAgentModelRoute`'s
 * `backend: 'codex'`, `CODEX_COMPETING_MODEL_PURPOSES`). A runner applies
 * `openAiBaseUrl` as `OPENAI_BASE_URL` plus the endpoint key as
 * `OPENAI_API_KEY`; an `anthropic-compatible`-only endpoint fails the Codex
 * task with a clear message rather than guessing a wire format.
 *
 * ## Module loading
 *
 * Pure helpers at the top; the DB and decryption are imported lazily in the
 * resolvers, so the parse/validate helpers load in a plain bun process (and in
 * the runner).
 */
import { gatewayUrlProblem, normalizeGatewayUrl, resolveLiteLLMGateway, type LiteLLMGateway } from './litellm-gateway';
import { openRouterModelId } from './openrouter-id';
import { verifyByFetch, type LookupAll, type VerifyOutcome } from './net/public-address';

export const AGENT_ENDPOINT_PURPOSE = 'agent_endpoint' as const;

/**
 * The claim-request `runnerFeatures` entry a runner sends when it applies
 * `modelEndpoint`. The claim delivers an endpoint (and withholds the Anthropic
 * credentials it replaces) only to a runner that declares it; any other runner
 * gets the claim it got before endpoints existed.
 */
export const AGENT_ENDPOINT_RUNNER_FEATURE = 'agent_endpoint' as const;
export const OPENROUTER_AGENT_BASE_URL = 'https://openrouter.ai/api';

export const AGENT_ENDPOINT_KINDS = ['gateway', 'openrouter', 'anthropic-compatible'] as const;
export type AgentEndpointKind = typeof AGENT_ENDPOINT_KINDS[number];
export type AgentEndpointAuthHeader = 'authorization' | 'x-api-key';

/** Alias map: native model id → the name the proxy serves it under. */
export type AgentModelMap = Record<string, string>;

/**
 * Protocol capabilities an endpoint is configured with. Absent key = the
 * kind's default (`effectiveToolSearch`). Stored only when set explicitly.
 */
export interface AgentEndpointCapabilities {
  /** Anthropic deferred tool loading (ToolSearch / `tool_reference`) passes through. */
  toolSearch?: boolean;
}

/**
 * Whether Claude runs through this endpoint get deferred tool loading. OpenRouter
 * supports ToolSearch / `tool_reference`, so it is on unless turned off. A
 * LiteLLM gateway or a custom URL may or may not pass the semantics through,
 * so it is off unless turned on.
 */
export function effectiveToolSearch(kind: AgentEndpointKind, capabilities?: AgentEndpointCapabilities | null): boolean {
  const explicit = capabilities?.toolSearch;
  if (typeof explicit === 'boolean') return explicit;
  return kind === 'openrouter';
}

/**
 * `appliesTo` (team-wide row only): the workspace ids this endpoint applies
 * to. Absent = every workspace in the team. A workspace-scoped row ignores it:
 * that row is its own workspace's. Ids that no longer belong to the team are
 * simply never matched (and dropped by the settings readback).
 */
export type AgentEndpointBlob =
  | { kind: 'gateway'; agentBaseUrl?: string; models?: AgentModelMap; appliesTo?: string[]; capabilities?: AgentEndpointCapabilities }
  | {
      kind: 'openrouter' | 'anthropic-compatible';
      baseUrl: string;
      apiKey: string;
      authHeader: AgentEndpointAuthHeader;
      models?: AgentModelMap;
      appliesTo?: string[];
      capabilities?: AgentEndpointCapabilities;
    };

/** What a run authenticates with once a blob is resolved. */
export interface AgentEndpointRoute {
  kind: AgentEndpointKind;
  /** Anthropic-compatible root, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  authHeader: AgentEndpointAuthHeader;
  models: AgentModelMap;
  /**
   * The OpenAI-compatible root (no trailing slash, e.g. `…/v1`), when this
   * endpoint has one — `gateway` (LiteLLM) and `openrouter` both do;
   * `anthropic-compatible` is Anthropic Messages format only and has none.
   * This is what a Codex task's `OPENAI_BASE_URL` becomes; its absence is
   * what tells the runner to fail a Codex task clearly instead of guessing.
   */
  openAiBaseUrl?: string;
  /** Effective deferred tool loading for Claude runs (`effectiveToolSearch`). */
  toolSearch: boolean;
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

/** Most workspaces one list may name; far above any real team. */
export const MAX_APPLIES_TO = 500;

/** `appliesTo`: absent/null = all workspaces; else a non-empty list of ids, trimmed and de-duplicated. */
export function parseAppliesTo(raw: unknown): { ok: true; appliesTo?: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'appliesTo must be a list of workspace ids, or null for all workspaces.' };
  const out: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (!id || /\s/.test(id)) return { ok: false, error: 'appliesTo must be a list of workspace ids.' };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) return { ok: false, error: 'Choose at least one workspace, or apply it to all workspaces.' };
  if (out.length > MAX_APPLIES_TO) return { ok: false, error: `appliesTo names at most ${MAX_APPLIES_TO} workspaces.` };
  return { ok: true, appliesTo: out };
}

/**
 * Whether a stored row applies to this workspace. A workspace-scoped row
 * (`rowWorkspaceId` set) is that workspace's own, so it always does (the
 * ranking already dropped other workspaces' rows). A team row applies
 * everywhere unless it carries `appliesTo`; then only to the listed
 * workspaces, and never to a lookup that names no workspace.
 */
export function endpointAppliesTo(
  blob: { appliesTo?: readonly string[] },
  rowWorkspaceId: string | null | undefined,
  workspaceId: string | null | undefined,
): boolean {
  if (rowWorkspaceId) return true;
  if (!blob.appliesTo) return true;
  return !!workspaceId && blob.appliesTo.includes(workspaceId);
}

/** `capabilities`: absent/null = kind defaults; else an object of known boolean flags. */
export function parseCapabilities(raw: unknown): { ok: true; capabilities?: AgentEndpointCapabilities } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isRecord(raw)) return { ok: false, error: 'capabilities must be an object.' };
  const out: AgentEndpointCapabilities = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'toolSearch') return { ok: false, error: `Unknown endpoint capability: ${k}.` };
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') return { ok: false, error: 'capabilities.toolSearch must be true or false.' };
    out.toolSearch = v;
  }
  return { ok: true, capabilities: Object.keys(out).length > 0 ? out : undefined };
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
  const scope = parseAppliesTo(input.appliesTo);
  if (scope.ok === false) return { ok: false, error: scope.error };
  const caps = parseCapabilities(input.capabilities);
  if (caps.ok === false) return { ok: false, error: caps.error };

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
    if (scope.appliesTo) blob.appliesTo = scope.appliesTo;
    if (caps.capabilities) blob.capabilities = caps.capabilities;
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
  if (scope.appliesTo) blob.appliesTo = scope.appliesTo;
  if (caps.capabilities) blob.capabilities = caps.capabilities;
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

/**
 * The OpenAI-compatible root for a kind that has one, given its Anthropic-side
 * pieces. `gateway`'s is the gateway's own OpenAI root (already `…/v1`, no
 * translation needed — LiteLLM speaks both wires off the same base);
 * `openrouter`'s is its Anthropic-compatible root plus `/v1` (OpenRouter's
 * native wire is OpenAI chat-completions). `anthropic-compatible` has none: a
 * self-contained custom proxy mimics only the Anthropic Messages API.
 */
function openAiBaseUrlFor(kind: AgentEndpointKind, anthropicBaseUrl: string, gatewayBaseUrl: string | undefined): string | undefined {
  if (kind === 'gateway') return gatewayBaseUrl;
  if (kind === 'openrouter') return `${anthropicBaseUrl}/v1`;
  return undefined;
}

/** A blob plus (for `kind: gateway`) the gateway it points at, as a route. Null when it routes nothing. */
export function resolveEndpointFromBlob(blob: AgentEndpointBlob, gateway: LiteLLMGateway | null): AgentEndpointRoute | null {
  if (blob.kind === 'gateway') {
    if (!gateway) return null;
    const baseUrl = blob.agentBaseUrl ?? agentBaseUrlFromGateway(gateway.baseURL);
    return {
      kind: 'gateway',
      baseUrl,
      apiKey: gateway.apiKey,
      authHeader: 'authorization',
      models: blob.models ?? {},
      openAiBaseUrl: openAiBaseUrlFor('gateway', baseUrl, gateway.baseURL),
      toolSearch: effectiveToolSearch('gateway', blob.capabilities),
    };
  }
  return {
    kind: blob.kind,
    baseUrl: blob.baseUrl,
    apiKey: blob.apiKey,
    authHeader: blob.authHeader,
    models: blob.models ?? {},
    openAiBaseUrl: openAiBaseUrlFor(blob.kind, blob.baseUrl, undefined),
    toolSearch: effectiveToolSearch(blob.kind, blob.capabilities),
  };
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

/**
 * The Codex-side equivalent: a team/workspace OpenAI key (`openai_api_key`) or
 * a ChatGPT/OAuth connect (`codex_credential`, api_key or oauth shape — either
 * is "a credential exists", liveness is the same revoked check as the
 * Anthropic purposes). Used instead of `COMPETING_MODEL_PURPOSES` when ranking
 * the endpoint for a Codex task, so a more specific Codex credential still
 * beats a broader team endpoint — mirroring the Claude path exactly, just
 * against the credentials a Codex run would actually otherwise use.
 */
export const CODEX_COMPETING_MODEL_PURPOSES = ['openai_api_key', 'codex_credential'] as const;

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
  purposes: readonly string[] = COMPETING_MODEL_PURPOSES,
): ModelCredentialScope[] {
  const out: ModelCredentialScope[] = [];
  for (const r of rows) {
    if (!purposes.includes(r.purpose)) continue;
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
 * team's (only when its `appliesTo` is absent or lists this workspace);
 * revoked rows skipped, newest first. A `kind: gateway` reference
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
        // A team row narrowed to some workspaces: not this one.
        if (!endpointAppliesTo(blob, r.workspaceId, opts.workspaceId)) continue;
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
 * so an error can never move a workspace off its own credential.
 *
 * `backend` picks which credentials compete: `claude` (default) ranks against
 * `COMPETING_MODEL_PURPOSES` (anthropic_api_key / oauth_token /
 * claude_credential); `codex` ranks against `CODEX_COMPETING_MODEL_PURPOSES`
 * (openai_api_key / codex_credential) instead — the credentials a Codex run
 * would otherwise use. The endpoint itself is backend-agnostic (one row for
 * both); only the competitor set changes.
 */
export async function resolveAgentModelRoute(opts: {
  teamId: string;
  workspaceId: string;
  accountId?: string | null;
  backend?: 'claude' | 'codex';
}): Promise<AgentModelDecision | null> {
  const endpoint = await resolveAgentEndpoint(opts);
  if (!endpoint) return null;
  const purposes = opts.backend === 'codex' ? CODEX_COMPETING_MODEL_PURPOSES : COMPETING_MODEL_PURPOSES;
  let scopes: ModelCredentialScope[];
  try {
    const { db } = await import('./db');
    const { secrets } = await import('./db/schema');
    const { eq, isNull, or } = await import('drizzle-orm');
    const { teamCredentialWhere } = await import('./secrets/team-scope');
    const rows = await db.query.secrets.findMany({
      where: teamCredentialWhere(
        { teamId: opts.teamId, purpose: purposes },
        opts.accountId ? or(isNull(secrets.accountId), eq(secrets.accountId, opts.accountId)) : isNull(secrets.accountId),
        or(isNull(secrets.workspaceId), eq(secrets.workspaceId, opts.workspaceId)),
      ),
      columns: { purpose: true, accountId: true, workspaceId: true, healthStatus: true, tokenExpiresAt: true },
    });
    scopes = competingScopes(rows ?? [], opts, purposes);
  } catch (e) {
    console.warn('[agent-endpoint] competitor lookup failed:', e);
    scopes = endpoint.scope === 'workspace' ? [] : ['workspace'];
  }
  if (endpointWinsRanking(endpoint.scope, scopes)) return { winner: 'endpoint', endpoint };
  const beatenBy = scopes.reduce<ModelCredentialScope>((m, s) => (RANK[s] > RANK[m] ? s : m), 'team');
  return { winner: 'anthropic', endpoint, beatenBy };
}

/**
 * Cheap existence check for the claim capability gate and backend-failover's
 * "is Codex configured" question (mirrors `hasCodexCredential` /
 * `hasOpenAiApiKey`): does an endpoint resolve for this scope AND does it have
 * an OpenAI-compatible route? Not the ranking — `resolveAgentModelRoute`
 * decides whether it actually wins against a more specific Codex credential
 * once a worker is claiming. This only answers "could Codex run at all here".
 */
export async function hasOpenAiCompatibleAgentEndpoint(opts: { teamId: string; workspaceId?: string | null }): Promise<boolean> {
  const endpoint = await resolveAgentEndpoint(opts);
  return !!endpoint?.openAiBaseUrl;
}

// ── Verify (§4) ───────────────────────────────────────────────────────────────

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The native model id Verify should probe. With an alias table, a model the
 * endpoint will actually be asked for: the fallback when it is aliased, else
 * the first aliased model (a key restricted to the aliased targets would refuse
 * the unaliased fallback). OpenRouter ignores aliases (mapAgentModel), so it
 * always probes the fallback.
 */
export function agentEndpointProbeModel(route: { kind: AgentEndpointKind; models?: AgentModelMap }, fallback: string): string {
  if (route.kind === 'openrouter') return fallback;
  const aliased = Object.keys(route.models ?? {});
  if (aliased.length === 0 || aliased.includes(fallback)) return fallback;
  return aliased[0];
}

export interface AgentEndpointVerifyOutcome extends VerifyOutcome {
  /** 403: the wire model id the endpoint refused for this key. */
  refusedModel?: string;
}

/**
 * One real Messages call through the endpoint: `model` after mapping,
 * `max_tokens: 1`, with the configured header. 2xx ⇒ healthy, 401 ⇒ revoked,
 * 403 ⇒ unknown with `refusedModel` (a LiteLLM key restricted to some models
 * answers 403 for the others, so a 403 says "not this model", not "dead key"),
 * anything else (an outage, an unknown alias) ⇒ unknown, so an outage never
 * marks it dead. Through net/public-address verifyByFetch: public hosts only,
 * no redirects, and the error is fixed text plus a status code and the model id
 * we sent, never the reply. `blocked`: the URL itself may not be used.
 * `wire`: `model` is already the name to send (agent-endpoint-models
 * selectProbeModel picked it from the endpoint's list), so it is not mapped.
 */
export async function verifyAgentEndpoint(
  route: AgentEndpointRoute,
  model: string,
  opts: { fetcher?: Fetcher; timeoutMs?: number; lookup?: LookupAll; wire?: boolean } = {},
): Promise<AgentEndpointVerifyOutcome> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (route.authHeader === 'x-api-key') headers['x-api-key'] = route.apiKey;
  else headers.authorization = `Bearer ${route.apiKey}`;
  const wireModel = opts.wire ? model : mapAgentModel(route, model);
  const shown = wireModel.length > 100 ? `${wireModel.slice(0, 100)}…` : wireModel;
  return verifyByFetch('endpoint', `${route.baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: wireModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  }, {
    fetcher: opts.fetcher,
    lookup: opts.lookup,
    classify: (status): AgentEndpointVerifyOutcome | null => status === 403
      ? {
          health: 'unknown',
          refusedModel: shown,
          error: `endpoint refused model "${shown}" for this key (403). The key may not be allowed to use it: add a model alias pointing it at a model the key allows`,
        }
      : null,
  });
}
