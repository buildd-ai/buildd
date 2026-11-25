/**
 * Which provider a team's knowledge is embedded with: `teams.embedding_provider`
 * and `teams.embedding_model`, two plain columns. Pure, client-safe.
 *
 * Embedding is one more use of a provider the team already connected on
 * Settings › Providers; it has no credential of its own. The embedder reads the
 * key (and, for a gateway, the base URL) from that provider's stored credential
 * through the same resolver as chat, so a workspace's own credential beats the
 * team's exactly as it does there (knowledge-store/embedding-config.ts).
 *
 * NULL provider: the deployment default (Voyage unless the operator set
 * EMBEDDING_PROVIDER), unchanged for every team that never picks.
 */
import { ROUTES } from '@buildd/ai-kit/models/routes';

/**
 * Voyage first: the default. Then providers on the Providers page with an
 * OpenAI-compatible `/embeddings`, and `local_runner`: the team's own runner's
 * Ollama through the relay queue (docs/specs/local-runner-provider.md), which
 * has no credential and is never a paid fallback.
 */
export const EMBEDDING_PROVIDERS = ['voyage', 'openrouter', 'openai', 'litellm', 'local_runner'] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];
/** A provider reached through a stored credential: everything but Voyage and the local runner. */
export type EmbeddingCredentialProvider = Exclude<EmbeddingProviderId, 'voyage' | 'local_runner'>;

export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderId = 'voyage';
export const EMBEDDING_MODEL_MAX = 200;

export interface EmbeddingChoice {
  provider: EmbeddingProviderId;
  /** Null for Voyage: it picks voyage-code-3 or the store's model per corpus. */
  model: string | null;
}

export function isEmbeddingProvider(value: unknown): value is EmbeddingProviderId {
  return typeof value === 'string' && (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

/** Why a submitted provider + model cannot be stored, or null. `provider: null` resets to the default. */
export function embeddingChoiceError(provider: unknown, model: unknown): string | null {
  if (provider === null) return null;
  if (!isEmbeddingProvider(provider)) return `provider must be one of ${EMBEDDING_PROVIDERS.join(', ')}, or null`;
  if (provider === 'voyage') return null;
  if (typeof model !== 'string' || !model.trim()) return 'model is required for this provider';
  if (model.trim().length > EMBEDDING_MODEL_MAX) return `model must be at most ${EMBEDDING_MODEL_MAX} characters`;
  if (/\s/.test(model.trim())) return 'model must not contain spaces';
  return null;
}

/** The stored columns as a choice, or null for the default (also for anything unreadable). */
export function parseEmbeddingChoice(provider: unknown, model: unknown): EmbeddingChoice | null {
  if (!isEmbeddingProvider(provider)) return null;
  if (provider === 'voyage') return { provider, model: null };
  if (embeddingChoiceError(provider, model)) return null;
  return { provider, model: (model as string).trim() };
}

/** The OpenAI-compatible root for a route-backed provider. A gateway's comes from its credential. */
export function embeddingRouteBaseUrl(provider: 'openrouter' | 'openai'): string {
  return ROUTES[provider].baseURL!;
}

/** Shown in the model field: an id that returns 1024 dimensions on that provider. */
export const EMBEDDING_MODEL_PLACEHOLDER: Record<EmbeddingCredentialProvider, string> = {
  openrouter: 'openai/text-embedding-3-large',
  openai: 'text-embedding-3-large',
  litellm: 'the model name on your gateway',
};
