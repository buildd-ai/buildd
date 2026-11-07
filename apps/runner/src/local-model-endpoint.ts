/**
 * A per-machine local model endpoint (e.g. Ollama on the runner's own host).
 *
 * This is runner configuration only: it is read from the runner's environment
 * and applied to the agent subprocess env / per-task CODEX_HOME on this
 * machine. It is never reported to or fetched from the buildd service, so the
 * service gains no inbound path to the model, and it is refused unless it is a
 * loopback address. It carries no real credential: the placeholder token only
 * satisfies clients that insist on one.
 *
 *   BUILDD_LOCAL_MODEL_URL      http://localhost:11434   (loopback only)
 *   BUILDD_LOCAL_MODEL          model name served locally (required with the URL)
 *   BUILDD_LOCAL_MODEL_CONTEXT  context window in tokens (optional, Codex config)
 *
 * Claude backend: ANTHROPIC_BASE_URL = the origin (Ollama's Anthropic-compatible
 * /v1/messages). Codex backend: a generated `model_providers` entry in the
 * task's own CODEX_HOME/config.toml pointing at `<origin>/v1` with
 * wire_api = "responses". The user's real ~/.codex is never read or written.
 */
export const LOCAL_MODEL_URL_ENV = 'BUILDD_LOCAL_MODEL_URL';
export const LOCAL_MODEL_ENV = 'BUILDD_LOCAL_MODEL';
export const LOCAL_MODEL_CONTEXT_ENV = 'BUILDD_LOCAL_MODEL_CONTEXT';
/** Placeholder bearer for clients that require a non-empty key; Ollama ignores it. */
export const LOCAL_MODEL_DUMMY_TOKEN = 'ollama';
/** Codex `model_providers` id written into the generated config.toml. */
export const LOCAL_CODEX_PROVIDER_ID = 'buildd_local';

export interface LocalModelEndpoint {
  /** Origin only, e.g. http://localhost:11434 (Anthropic-compatible root). */
  baseUrl: string;
  /** `<origin>/v1`: the OpenAI-compatible (Responses) root for Codex. */
  openAiBaseUrl: string;
  model: string;
  contextWindow?: number;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The configured local endpoint, undefined when unset; throws on a bad setting. */
export function resolveLocalModelEndpoint(env: Record<string, string | undefined>): LocalModelEndpoint | undefined {
  const raw = env[LOCAL_MODEL_URL_ENV]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${LOCAL_MODEL_URL_ENV} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${LOCAL_MODEL_URL_ENV} must be http(s)`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`${LOCAL_MODEL_URL_ENV} must be a loopback address (localhost, 127.x, ::1): the local model endpoint is per-machine and is never exposed`);
  }
  const model = env[LOCAL_MODEL_ENV]?.trim();
  if (!model) throw new Error(`${LOCAL_MODEL_ENV} is required when ${LOCAL_MODEL_URL_ENV} is set`);
  const ctxRaw = env[LOCAL_MODEL_CONTEXT_ENV]?.trim();
  const ctx = ctxRaw ? Number(ctxRaw) : undefined;
  if (ctxRaw && !(Number.isInteger(ctx) && (ctx as number) > 0)) {
    throw new Error(`${LOCAL_MODEL_CONTEXT_ENV} must be a positive integer`);
  }
  return {
    baseUrl: url.origin,
    openAiBaseUrl: `${url.origin}/v1`,
    model,
    ...(ctx ? { contextWindow: ctx } : {}),
  };
}

const CLAUDE_AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * Env for an agent whose model traffic goes to the local endpoint. Mutates and
 * returns `env`. Every other model credential is removed, so nothing real is
 * sent to the local server and no subscription login is used.
 */
export function applyLocalModelEnv(env: Record<string, string>, local: LocalModelEndpoint, isCodexTask: boolean): Record<string, string> {
  if (isCodexTask) {
    delete env.ANTHROPIC_API_KEY;
    // The base URL lives in the generated config.toml provider, not here.
    delete env.OPENAI_BASE_URL;
    env.OPENAI_API_KEY = LOCAL_MODEL_DUMMY_TOKEN;
    return env;
  }
  for (const k of CLAUDE_AUTH_VARS) delete env[k];
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  delete env.ENABLE_TOOL_SEARCH;
  env.ANTHROPIC_BASE_URL = local.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = LOCAL_MODEL_DUMMY_TOKEN;
  for (const k of ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) env[k] = local.model;
  return env;
}

/**
 * Top-level + table TOML for the Codex config.toml. Top-level keys come first
 * (TOML scopes anything after a `[table]` header into it).
 */
export function codexLocalProviderToml(local: LocalModelEndpoint): { topLevel: string[]; tables: string[] } {
  const q = (s: string) => JSON.stringify(s);
  return {
    topLevel: [
      `model_provider = ${q(LOCAL_CODEX_PROVIDER_ID)}`,
      `model = ${q(local.model)}`,
      ...(local.contextWindow ? [`model_context_window = ${local.contextWindow}`] : []),
      '',
    ],
    tables: [
      `[model_providers.${LOCAL_CODEX_PROVIDER_ID}]`,
      'name = "Local model"',
      `base_url = ${q(local.openAiBaseUrl)}`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
    ],
  };
}
