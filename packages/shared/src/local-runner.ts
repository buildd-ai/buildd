/**
 * Local runner provider: the shapes both sides of the relay agree on
 * (docs/specs/local-runner-provider.md §2.2, §5, §6.2). Pure, client-safe.
 *
 * - `LocalRunnerConfig` is `teams.local_runner`: which runner serves the team
 *   and which Ollama tag answers chat. Dimensions are never stored here: they
 *   are recorded per namespace (`knowledge_namespaces`, ./namespace record
 *   below) so a model that changes size shows up as a mismatch.
 * - `LocalModelsAdvert` is what a runner reports in its heartbeat and the
 *   server keeps in `worker_heartbeats.local_models`: what is served, never
 *   where. The parser is strict on purpose: unknown fields are dropped and a
 *   value that looks like a URL or a token is refused, so the column can never
 *   become an inbound path.
 * - The supported vector sizes and the `knowledge_chunks` column each one
 *   lives in (spec §5.2, decision A: one column per size).
 */

// ── Vector sizes ─────────────────────────────────────────────────────────────

/** Sizes `knowledge_chunks` has a column and an HNSW index for. Anything else is refused at pick time, never truncated. */
export const SUPPORTED_EMBEDDING_DIMENSIONS = [768, 1024, 1536] as const;
export type SupportedEmbeddingDimension = (typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number];

/** The `knowledge_chunks` column a size is stored in. 1024 keeps the original name so the Voyage path is untouched. */
export type VectorColumn = 'embedding' | 'embedding_768' | 'embedding_1536';
export const VECTOR_COLUMNS: readonly VectorColumn[] = ['embedding', 'embedding_768', 'embedding_1536'];

const COLUMN_BY_DIMENSION: Readonly<Record<SupportedEmbeddingDimension, VectorColumn>> = {
  768: 'embedding_768',
  1024: 'embedding',
  1536: 'embedding_1536',
};

export function isSupportedEmbeddingDimension(value: unknown): value is SupportedEmbeddingDimension {
  return typeof value === 'number' && (SUPPORTED_EMBEDDING_DIMENSIONS as readonly number[]).includes(value);
}

/** The column for a size, or null when the size is not supported. */
export function vectorColumnForDimensions(dimensions: number): VectorColumn | null {
  return isSupportedEmbeddingDimension(dimensions) ? COLUMN_BY_DIMENSION[dimensions] : null;
}

/** The size a column holds. */
export function dimensionsForVectorColumn(column: VectorColumn): SupportedEmbeddingDimension {
  return column === 'embedding_768' ? 768 : column === 'embedding_1536' ? 1536 : 1024;
}

/** Where a namespace's re-embed stands (`knowledge_namespaces.reembed_status`). */
export const REEMBED_STATUSES = ['none', 'pending', 'running', 'done', 'failed'] as const;
export type ReembedStatus = (typeof REEMBED_STATUSES)[number];

// ── teams.local_runner ───────────────────────────────────────────────────────

export interface LocalRunnerConfig {
  /** A `worker_heartbeats.id` of the team's own runner. Null = no pick (refused on write, read tolerantly). */
  runnerId: string | null;
  /** The Ollama tag chat relays to; required when chat is assigned to `local_runner`. */
  chatModel: string | null;
}

export const LOCAL_MODEL_NAME_MAX = 128;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Ollama tag as the picker stores it: short, no whitespace, never a URL. */
export function isLocalModelName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= LOCAL_MODEL_NAME_MAX
    && !/\s/.test(value)
    && !value.includes('://');
}

/** The stored column as a config; null for anything unreadable. Fields it cannot read are null. */
export function parseLocalRunnerConfig(raw: unknown): LocalRunnerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    runnerId: typeof r.runnerId === 'string' && UUID_RE.test(r.runnerId) ? r.runnerId.toLowerCase() : null,
    chatModel: isLocalModelName(r.chatModel) ? r.chatModel : null,
  };
}

// ── worker_heartbeats.local_models ───────────────────────────────────────────

export const LOCAL_MODELS_ADVERT_MAX_MODELS = 50;
export const LOCAL_MODEL_CAPABILITIES = ['embedding', 'completion'] as const;
export type LocalModelCapability = (typeof LOCAL_MODEL_CAPABILITIES)[number];

export interface LocalModelAdvert {
  name: string;
  family: string | null;
  parameterSize: string | null;
  capabilities: LocalModelCapability[];
  /** The embedding length for an `embedding`-capable model; null when Ollama did not say. */
  dimensions: number | null;
  contextLength: number | null;
}

export interface LocalModelsServer {
  kind: 'ollama';
  version: string | null;
  reachable: boolean;
  checkedAt: string | null;
}

/** The runner's rolling last-hour relay window (spec §6.4). Counts and durations only. */
export interface LocalRelayStats {
  jobs: number;
  errors: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

export interface LocalModelsAdvert {
  server: LocalModelsServer;
  models: LocalModelAdvert[];
  relayStats?: LocalRelayStats;
}

const SHORT_MAX = 64;

/** A short label (family, parameter size, version): never a URL, never anything token-shaped. */
function shortLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > SHORT_MAX || v.includes('://')) return null;
  // A long run of key characters with nothing else is token-shaped, not a label.
  if (/^[A-Za-z0-9_-]{40,}$/.test(v)) return null;
  return v;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseModel(raw: unknown): LocalModelAdvert | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isLocalModelName(r.name)) return null;
  const capabilities = Array.isArray(r.capabilities)
    ? [...new Set(r.capabilities.filter((c): c is LocalModelCapability => (LOCAL_MODEL_CAPABILITIES as readonly unknown[]).includes(c)))]
    : [];
  const dimensions = nonNegInt(r.dimensions);
  return {
    name: r.name,
    family: shortLabel(r.family),
    parameterSize: shortLabel(r.parameterSize),
    capabilities,
    dimensions: dimensions && dimensions > 0 ? dimensions : null,
    contextLength: nonNegInt(r.contextLength) || null,
  };
}

function parseRelayStats(raw: unknown): LocalRelayStats | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    jobs: nonNegInt(r.jobs) ?? 0,
    errors: nonNegInt(r.errors) ?? 0,
    p50DurationMs: nonNegNumber(r.p50DurationMs),
    p95DurationMs: nonNegNumber(r.p95DurationMs),
    lastErrorCode: shortLabel(r.lastErrorCode),
    lastErrorAt: isoOrNull(r.lastErrorAt),
  };
}

/**
 * Strict parse of a heartbeat's `localModels` (spec §6.2, AC-19): at most 50
 * models, names ≤ 128 chars, unknown fields dropped, a model whose name is a
 * URL dropped. Null when the payload is not an advert at all.
 */
export function parseLocalModelsAdvert(raw: unknown): LocalModelsAdvert | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const server = r.server && typeof r.server === 'object' && !Array.isArray(r.server) ? (r.server as Record<string, unknown>) : null;
  if (!server || server.kind !== 'ollama') return null;
  const models = Array.isArray(r.models)
    ? r.models.map(parseModel).filter((m): m is LocalModelAdvert => m !== null).slice(0, LOCAL_MODELS_ADVERT_MAX_MODELS)
    : [];
  const out: LocalModelsAdvert = {
    server: {
      kind: 'ollama',
      version: shortLabel(server.version),
      reachable: server.reachable === true,
      checkedAt: isoOrNull(server.checkedAt),
    },
    models,
  };
  const relayStats = parseRelayStats(r.relayStats);
  if (relayStats) out.relayStats = relayStats;
  return out;
}

/** The advertised embedding models a picker may offer, with whether each size is supported. */
export function advertisedEmbeddingModels(advert: LocalModelsAdvert | null): Array<{ name: string; dimensions: number | null; supported: boolean }> {
  if (!advert) return [];
  return advert.models
    .filter(m => m.capabilities.includes('embedding'))
    .map(m => ({ name: m.name, dimensions: m.dimensions, supported: m.dimensions !== null && isSupportedEmbeddingDimension(m.dimensions) }));
}
