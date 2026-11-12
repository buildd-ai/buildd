// Which embedding provider a namespace writes and queries with. One provider
// serves both, so a stored vector and the query vector it is compared with
// always come from the same model. Spec: docs/specs/pluggable-knowledge-store.md.
//
// Deployment default from env (EMBEDDING_PROVIDER unset = Voyage, unchanged);
// a team or workspace may override it with a `secrets` row of purpose
// `embedding_endpoint` (an encrypted JSON blob), most specific scope first, as
// every other credential (docs/credentials-architecture.md).

import type { Corpus, Embedder } from './types';
import type { EmbeddingProvider } from '../voyage-budget';
import { getCodeEmbedder, isCodeCorpus } from './voyage-embedder';
import { OpenAICompatibleEmbedder } from './openai-compatible-embedder';

type Env = Record<string, string | undefined>;

/** Secret purpose holding a team's or workspace's embedding endpoint (JSON). */
export const EMBEDDING_ENDPOINT_PURPOSE = 'embedding_endpoint' as const;

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
  /** Where the config came from. */
  source: 'env' | 'secret';
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
    matryoshka: false, pricePerMTokens: null, unmetered: false, timeoutMs: null, maxBatch: null, source,
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
 * Parse an `embedding_endpoint` secret. Shape:
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

/**
 * The owner's `embedding_endpoint` blob, decrypted, or null. The owner is a
 * namespace's first segment: a workspace id or a team id. A workspace's own row
 * beats its team's team-wide row; account- and person-scoped rows never apply
 * (a namespace is shared by everyone in it).
 */
async function loadEndpointSecret(ownerId: string): Promise<string | null> {
  const [{ db }, { sql }] = await Promise.all([import('../db'), import('drizzle-orm')]);
  const res = await db.execute(sql`
    SELECT s.encrypted_value
    FROM secrets s
    LEFT JOIN workspaces w ON w.id = ${ownerId}::uuid
    WHERE s.purpose = ${EMBEDDING_ENDPOINT_PURPOSE}
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
  loadSecret?: (ownerId: string) => Promise<string | null>;
}

/**
 * The config for a namespace owner: its `embedding_endpoint` secret when there
 * is a valid one, else env. An owner that is not a UUID (tests, fixtures)
 * cannot own a secret and costs no lookup; a failed or invalid lookup falls
 * back to env, never to an error.
 */
export function resolveEmbeddingConfig(ownerId: string, deps: ResolveEmbeddingConfigDeps = {}): Promise<EmbeddingConfig> {
  const env = deps.env ?? process.env;
  const fromEnv = embeddingConfigFromEnv(env);
  if (!UUID_RE.test(ownerId)) return Promise.resolve(fromEnv);
  const now = Date.now();
  const cached = deps.loadSecret ? undefined : configCache.get(ownerId);
  if (cached && now - cached.at < CONFIG_CACHE_TTL_MS) return cached.cfg;
  const cfg = (async () => {
    try {
      const raw = await (deps.loadSecret ?? loadEndpointSecret)(ownerId);
      if (!raw) return fromEnv;
      const parsed = parseEmbeddingEndpoint(raw);
      if (parsed.ok) return parsed.value;
      console.warn(`[embedding-config] ignoring invalid embedding_endpoint for ${ownerId}: ${parsed.error}`);
      return fromEnv;
    } catch (err) {
      console.warn(`[embedding-config] embedding_endpoint lookup failed for ${ownerId}; using env:`, err instanceof Error ? err.message : err);
      return fromEnv;
    }
  })();
  if (!deps.loadSecret) {
    if (configCache.size >= CONFIG_CACHE_MAX) configCache.delete(configCache.keys().next().value as string);
    configCache.set(ownerId, { at: now, cfg });
  }
  return cfg;
}
