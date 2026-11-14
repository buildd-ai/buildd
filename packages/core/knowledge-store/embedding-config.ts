// Which embedding provider a namespace writes and queries with. One provider
// serves both, so a stored vector and the query vector it is compared with
// always come from the same model. Spec: docs/specs/pluggable-knowledge-store.md.
//
// Deployment default from env (EMBEDDING_PROVIDER unset = Voyage, unchanged).
// A team may pick, on Settings › Providers, one provider it already connected
// plus a model (`teams.embedding_provider` / `embedding_model`, see
// ../providers/embedding.ts). The key and, for a gateway, the base URL come
// from that provider's stored credential through the chat resolver, so a
// workspace's own credential beats the team's as it does for chat. Embeddings
// have no credential of their own.

import type { Corpus, Embedder } from './types';
import type { EmbeddingProvider } from '../voyage-budget';
import { getCodeEmbedder, isCodeCorpus } from './voyage-embedder';
import { OpenAICompatibleEmbedder } from './openai-compatible-embedder';
import {
  embeddingRouteBaseUrl,
  parseEmbeddingChoice,
  type EmbeddingChoice,
  type EmbeddingCredentialProvider,
} from '../providers/embedding';

type Env = Record<string, string | undefined>;

/**
 * DEPRECATED, read-only: a `secrets` purpose from before embeddings became a use
 * of a team's provider. New rows are refused (POST /api/secrets); an existing
 * row still applies to a team that has made no pick, with a warning. Remove
 * once no row is left.
 */
export const LEGACY_EMBEDDING_ENDPOINT_PURPOSE = 'embedding_endpoint' as const;

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  /** openai_compat: the base URL; `/embeddings` is appended. */
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  queryPrefix: string;
  docPrefix: string;
  matryoshka: boolean;
  /** USD per 1M tokens, for the usage estimate. Null: not priced. */
  pricePerMTokens: number | null;
  /** Free (self-hosted): attributed as `unmetered`. */
  unmetered: boolean;
  timeoutMs: number | null;
  maxBatch: number | null;
  /** Where the config came from. `secret`: a deprecated `embedding_endpoint` row. */
  source: 'env' | 'secret' | 'team';
  /** The team's pick cannot be used (no key): why. The namespace runs lexical-only. */
  unavailable?: string | null;
}

const TRUE = new Set(['1', 'true', 'on', 'yes']);

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parsePrice(raw: unknown): { pricePerMTokens: number | null; unmetered: boolean } {
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'unmetered') return { pricePerMTokens: null, unmetered: true };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n >= 0) {
    return n === 0 ? { pricePerMTokens: null, unmetered: true } : { pricePerMTokens: n, unmetered: false };
  }
  return { pricePerMTokens: null, unmetered: false };
}

function voyageConfig(source: EmbeddingConfig['source']): EmbeddingConfig {
  return {
    provider: 'voyage', baseUrl: null, model: null, apiKey: null, queryPrefix: '', docPrefix: '',
    matryoshka: false, pricePerMTokens: null, unmetered: false, timeoutMs: null, maxBatch: null, source, unavailable: null,
  };
}

/**
 * The deployment default. EMBEDDING_PROVIDER unset or `voyage`: Voyage exactly
 * as before. `openai_compat`: EMBEDDING_BASE_URL + EMBEDDING_MODEL (required),
 * EMBEDDING_API_KEY, EMBEDDING_QUERY_PREFIX, EMBEDDING_DOC_PREFIX,
 * EMBEDDING_MATRYOSHKA, EMBEDDING_PRICE_PER_1M_TOKENS (a number, or `unmetered`),
 * EMBEDDING_TIMEOUT_MS, EMBEDDING_MAX_BATCH.
 */
export function embeddingConfigFromEnv(env: Env = process.env): EmbeddingConfig {
  if (env.EMBEDDING_PROVIDER?.trim().toLowerCase() !== 'openai_compat') return voyageConfig('env');
  return {
    provider: 'openai_compat',
    baseUrl: env.EMBEDDING_BASE_URL?.trim() || null,
    model: env.EMBEDDING_MODEL?.trim() || null,
    apiKey: env.EMBEDDING_API_KEY?.trim() || null,
    queryPrefix: env.EMBEDDING_QUERY_PREFIX ?? '',
    docPrefix: env.EMBEDDING_DOC_PREFIX ?? '',
    matryoshka: TRUE.has(env.EMBEDDING_MATRYOSHKA?.trim().toLowerCase() ?? ''),
    ...parsePrice(env.EMBEDDING_PRICE_PER_1M_TOKENS?.trim()),
    timeoutMs: positiveInt(env.EMBEDDING_TIMEOUT_MS),
    maxBatch: positiveInt(env.EMBEDDING_MAX_BATCH),
    source: 'env',
  };
}

/**
 * Parse a deprecated `embedding_endpoint` secret (read-only). Shape:
 * `{ provider?: 'openai_compat'|'voyage', baseUrl, model, apiKey?, queryPrefix?,
 *    docPrefix?, matryoshka?, price?: number|'unmetered', timeoutMs?, maxBatch? }`.
 * `provider: 'voyage'` opts the scope back onto Voyage. A blob never inherits
 * from env: the platform's EMBEDDING_API_KEY must not reach a team's URL.
 */
export function parseEmbeddingEndpoint(raw: string): { ok: true; value: EmbeddingConfig } | { ok: false; error: string } {
  let blob: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'embedding_endpoint must be a JSON object' };
    blob = parsed;
  } catch {
    return { ok: false, error: 'embedding_endpoint must be a JSON object' };
  }
  const provider = blob.provider ?? 'openai_compat';
  if (provider === 'voyage') return { ok: true, value: voyageConfig('secret') };
  if (provider !== 'openai_compat') return { ok: false, error: 'provider must be openai_compat or voyage' };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const baseUrl = str(blob.baseUrl).trim();
  const model = str(blob.model).trim();
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) return { ok: false, error: 'baseUrl must be an http(s) URL' };
  if (!model) return { ok: false, error: 'model is required' };
  return {
    ok: true,
    value: {
      provider: 'openai_compat',
      baseUrl,
      model,
      apiKey: str(blob.apiKey).trim() || null,
      queryPrefix: str(blob.queryPrefix),
      docPrefix: str(blob.docPrefix),
      matryoshka: blob.matryoshka === true,
      ...parsePrice(blob.price),
      timeoutMs: positiveInt(blob.timeoutMs),
      maxBatch: positiveInt(blob.maxBatch),
      source: 'secret',
    },
  };
}

// ── Embedder for a corpus ────────────────────────────────────────────────────

const endpointEmbedders = new Map<string, OpenAICompatibleEmbedder>();
const ENDPOINT_EMBEDDERS_MAX = 100;
const warnedMisconfigured = new Set<string>();

/**
 * The embedder a corpus writes and queries with under `cfg`.
 *
 * - voyage: what PgVectorStore always did. code/docs/spec use voyage-code-3
 *   when VOYAGE_API_KEY is set; everything else, and a missing key, uses
 *   `fallback` (the embedder the store was constructed with).
 * - openai_compat: the one configured endpoint for every corpus. Missing a
 *   base URL or model, it is null (lexical-only), with one warning.
 */
export function getEmbedderForCorpus(corpus: Corpus, cfg: EmbeddingConfig, fallback: Embedder | null = null): Embedder | null {
  if (cfg.provider === 'voyage') {
    return isCodeCorpus(corpus) ? getCodeEmbedder() ?? fallback : fallback;
  }
  if (cfg.unavailable) {
    if (!warnedMisconfigured.has(cfg.unavailable)) {
      if (warnedMisconfigured.size >= ENDPOINT_EMBEDDERS_MAX) warnedMisconfigured.clear();
      warnedMisconfigured.add(cfg.unavailable);
      console.warn(`[embedding-config] ${cfg.unavailable}`);
    }
    return null;
  }
  if (!cfg.baseUrl || !cfg.model) {
    const key = `${cfg.source}:${cfg.baseUrl}:${cfg.model}`;
    if (!warnedMisconfigured.has(key)) {
      warnedMisconfigured.add(key);
      console.warn(`[embedding-config] openai_compat needs a base URL and a model (from ${cfg.source}); knowledge runs lexical-only`);
    }
    return null;
  }
  const key = JSON.stringify([cfg.baseUrl, cfg.model, cfg.apiKey, cfg.queryPrefix, cfg.docPrefix, cfg.matryoshka, cfg.unmetered, cfg.timeoutMs, cfg.maxBatch]);
  let embedder = endpointEmbedders.get(key);
  if (!embedder) {
    embedder = new OpenAICompatibleEmbedder({
      baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, queryPrefix: cfg.queryPrefix, docPrefix: cfg.docPrefix,
      matryoshka: cfg.matryoshka, unmetered: cfg.unmetered, timeoutMs: cfg.timeoutMs, maxBatch: cfg.maxBatch,
    });
    if (endpointEmbedders.size >= ENDPOINT_EMBEDDERS_MAX) endpointEmbedders.delete(endpointEmbedders.keys().next().value as string);
    endpointEmbedders.set(key, embedder);
  }
  return embedder;
}

// ── Resolving a namespace owner's config ─────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG_CACHE_TTL_MS = 60_000;
const CONFIG_CACHE_MAX = 2_000;
const configCache = new Map<string, { at: number; cfg: Promise<EmbeddingConfig> }>();

/** Drop cached per-owner configs. Tests only. */
export function resetEmbeddingConfigCache(): void {
  configCache.clear();
}

/** A namespace owner's team, its workspace (null for a team-wide namespace) and the team's pick. */
export interface OwnerEmbeddingSetting {
  teamId: string;
  workspaceId: string | null;
  provider: string | null;
  model: string | null;
}

/** The owner is a namespace's first segment: a workspace id or a team id. */
async function loadOwnerSetting(ownerId: string): Promise<OwnerEmbeddingSetting | null> {
  const [{ db }, { sql }] = await Promise.all([import('../db'), import('drizzle-orm')]);
  const res = await db.execute(sql`
    SELECT t.id::text AS team_id, w.id::text AS workspace_id, t.embedding_provider, t.embedding_model
    FROM teams t
    LEFT JOIN workspaces w ON w.team_id = t.id AND w.id = ${ownerId}::uuid
    WHERE t.id = ${ownerId}::uuid OR w.id IS NOT NULL
    LIMIT 1
  `);
  const row = (res.rows as Array<{ team_id: string; workspace_id: string | null; embedding_provider: string | null; embedding_model: string | null }>)[0];
  return row ? { teamId: row.team_id, workspaceId: row.workspace_id, provider: row.embedding_provider, model: row.embedding_model } : null;
}

/** What the embedder needs from a provider's stored credential. `baseUrl` null: the route's own root. */
export interface EmbeddingCredential { apiKey: string; baseUrl: string | null }

/**
 * The provider's stored credential, as chat resolves it for team work (no
 * person): a workspace row first, then the team's, under the team's key
 * policy. A gateway's credential carries its base URL.
 */
async function resolveProviderEmbeddingCredential(
  provider: EmbeddingCredentialProvider,
  scope: { teamId: string; workspaceId: string | null },
): Promise<EmbeddingCredential | null> {
  if (provider === 'litellm') {
    const { resolveLiteLLMGateway } = await import('../litellm-gateway');
    const g = await resolveLiteLLMGateway(scope);
    return g ? { apiKey: g.apiKey, baseUrl: g.baseURL } : null;
  }
  const { resolveInferenceKey } = await import('../inference-keys');
  const key = await resolveInferenceKey({ provider, teamId: scope.teamId, workspaceId: scope.workspaceId });
  return key ? { apiKey: key, baseUrl: null } : null;
}

/** The team's pick as a config: the provider's credential, or a reason it cannot run. */
async function teamConfig(
  choice: EmbeddingChoice,
  setting: OwnerEmbeddingSetting,
  resolveCredential: NonNullable<ResolveEmbeddingConfigDeps['resolveCredential']>,
): Promise<EmbeddingConfig> {
  if (choice.provider === 'voyage') return voyageConfig('team');
  const provider = choice.provider;
  const base: EmbeddingConfig = {
    provider: 'openai_compat', baseUrl: null, model: choice.model, apiKey: null, queryPrefix: '', docPrefix: '',
    matryoshka: false, pricePerMTokens: null, unmetered: false, timeoutMs: null, maxBatch: null, source: 'team', unavailable: null,
  };
  let cred: EmbeddingCredential | null = null;
  try {
    cred = await resolveCredential(provider, { teamId: setting.teamId, workspaceId: setting.workspaceId });
  } catch (err) {
    console.warn(`[embedding-config] ${provider} credential lookup failed:`, err instanceof Error ? err.message : err);
  }
  const baseUrl = cred && (provider === 'litellm' ? cred.baseUrl : embeddingRouteBaseUrl(provider));
  if (!cred || !baseUrl) {
    return { ...base, unavailable: `${EMBEDDING_PROVIDER_LABEL[provider]} is chosen for embeddings but has no usable key for this team or workspace; knowledge runs lexical-only.` };
  }
  return { ...base, baseUrl, apiKey: cred.apiKey };
}

const EMBEDDING_PROVIDER_LABEL: Record<EmbeddingCredentialProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  litellm: 'The LiteLLM gateway',
};

/**
 * A deprecated `embedding_endpoint` blob, decrypted, or null. A workspace's own
 * row beats its team's team-wide row; account- and person-scoped rows never
 * apply. Read only for a team with no pick.
 */
async function loadLegacyEndpointSecret(ownerId: string): Promise<string | null> {
  const [{ db }, { sql }] = await Promise.all([import('../db'), import('drizzle-orm')]);
  const res = await db.execute(sql`
    SELECT s.encrypted_value
    FROM secrets s
    LEFT JOIN workspaces w ON w.id = ${ownerId}::uuid
    WHERE s.purpose = ${LEGACY_EMBEDDING_ENDPOINT_PURPOSE}
      AND s.account_id IS NULL AND s.user_id IS NULL
      AND (
        s.workspace_id = ${ownerId}::uuid
        OR (s.workspace_id IS NULL AND (s.team_id = w.team_id OR s.team_id = ${ownerId}::uuid))
      )
    ORDER BY (s.workspace_id IS NOT NULL) DESC, s.created_at DESC
    LIMIT 1
  `);
  const row = (res.rows as Array<{ encrypted_value: string }>)[0];
  if (!row) return null;
  const { decrypt } = await import('../secrets');
  return decrypt(row.encrypted_value);
}

export interface ResolveEmbeddingConfigDeps {
  env?: Env;
  loadSetting?: (ownerId: string) => Promise<OwnerEmbeddingSetting | null>;
  resolveCredential?: (provider: EmbeddingCredentialProvider, scope: { teamId: string; workspaceId: string | null }) => Promise<EmbeddingCredential | null>;
  loadLegacySecret?: (ownerId: string) => Promise<string | null>;
}

/**
 * The config for a namespace owner, one per namespace for writes and queries:
 * the team's pick when it made one, else a deprecated `embedding_endpoint` row,
 * else env. An owner that is not a UUID (tests, fixtures) costs no lookup. A
 * failed lookup falls back to env; a pick whose provider has no key runs
 * lexical-only with the reason logged. Never throws.
 */
export function resolveEmbeddingConfig(ownerId: string, deps: ResolveEmbeddingConfigDeps = {}): Promise<EmbeddingConfig> {
  const env = deps.env ?? process.env;
  const fromEnv = embeddingConfigFromEnv(env);
  if (!UUID_RE.test(ownerId)) return Promise.resolve(fromEnv);
  const injected = !!(deps.loadSetting || deps.resolveCredential || deps.loadLegacySecret);
  const now = Date.now();
  const cached = injected ? undefined : configCache.get(ownerId);
  if (cached && now - cached.at < CONFIG_CACHE_TTL_MS) return cached.cfg;
  const cfg = (async () => {
    try {
      const setting = await (deps.loadSetting ?? loadOwnerSetting)(ownerId);
      const choice = setting ? parseEmbeddingChoice(setting.provider, setting.model) : null;
      if (setting && choice) return teamConfig(choice, setting, deps.resolveCredential ?? resolveProviderEmbeddingCredential);
    } catch (err) {
      console.warn(`[embedding-config] embedding setting lookup failed for ${ownerId}; using env:`, err instanceof Error ? err.message : err);
      return fromEnv;
    }
    try {
      const raw = await (deps.loadLegacySecret ?? loadLegacyEndpointSecret)(ownerId);
      if (!raw) return fromEnv;
      const parsed = parseEmbeddingEndpoint(raw);
      if (parsed.ok) {
        console.warn(`[embedding-config] ${ownerId} embeds with a deprecated embedding_endpoint secret; pick a provider for embeddings on Settings › Providers instead.`);
        return parsed.value;
      }
      console.warn(`[embedding-config] ignoring invalid embedding_endpoint for ${ownerId}: ${parsed.error}`);
      return fromEnv;
    } catch (err) {
      console.warn(`[embedding-config] embedding_endpoint lookup failed for ${ownerId}; using env:`, err instanceof Error ? err.message : err);
      return fromEnv;
    }
  })();
  if (!injected) {
    if (configCache.size >= CONFIG_CACHE_MAX) configCache.delete(configCache.keys().next().value as string);
    configCache.set(ownerId, { at: now, cfg });
  }
  return cfg;
}
