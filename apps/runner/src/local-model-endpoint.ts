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
 * The Anthropic model id Claude Code is told the local model stands in for.
 *
 * Claude Code checks every request's model id against its own catalog. An id
 * it does not know (any Ollama tag) makes it print
 * `[claude-code:unrecognized_model]` on stderr, which the runner reads as the
 * reason a session died. A `modelOverrides` entry (Anthropic id -> provider id)
 * makes the Ollama tag resolve to this id, so it counts as known while the
 * Ollama tag is still what goes on the wire.
 *
 * Sonnet 4.6 because its request shape (adaptive thinking, effort, the same
 * betas) is exactly what Claude Code sends for an unknown id, which Ollama's
 * /v1/messages already accepted. The live test in
 * `__tests__/unit/local-model-cli.test.ts` runs the bundled CLI against a fake
 * server, so a CLI that stops knowing this id fails there, not on a runner.
 */
export const LOCAL_CLAUDE_REFERENCE_MODEL = 'claude-sonnet-4-6';

/** Codex model catalog file written next to the task's config.toml. */
export const LOCAL_CODEX_CATALOG_FILE = 'buildd-local-models.json';
/** Context window Codex is told when BUILDD_LOCAL_MODEL_CONTEXT is unset. */
export const LOCAL_CODEX_DEFAULT_CONTEXT = 32768;

/**
 * Env for an agent whose model traffic goes to the local endpoint. Mutates and
 * returns `env`. Every other model credential is removed, so nothing real is
 * sent to the local server and no subscription login is used.
 */
export function applyLocalModelEnv(env: Record<string, string>, local: LocalModelEndpoint, isCodexTask: boolean): Record<string, string> {
  if (isCodexTask) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ENABLE_TOOL_SEARCH;
    // The base URL lives in the generated config.toml provider, not here.
    delete env.OPENAI_BASE_URL;
    env.OPENAI_API_KEY = LOCAL_MODEL_DUMMY_TOKEN;
    return env;
  }
  for (const k of CLAUDE_AUTH_VARS) delete env[k];
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  env.ANTHROPIC_BASE_URL = local.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = LOCAL_MODEL_DUMMY_TOKEN;
  for (const k of ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) env[k] = local.model;
  // Off, not just unset: Claude Code still defers tools (ToolSearch + a
  // placeholder) for a loopback base URL, and a local model cannot follow a
  // tool_reference, so the buildd MCP tools would never be callable.
  env.ENABLE_TOOL_SEARCH = 'false';
  // Compact against the window the local server actually has, not the
  // reference model's.
  if (local.contextWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(local.contextWindow);
  else delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  return env;
}

/**
 * Claude Code settings for a local-model session (merged into the SDK's
 * `settings`): the local model id resolves to a model the CLI knows. See
 * LOCAL_CLAUDE_REFERENCE_MODEL.
 */
export function claudeLocalModelSettings(local: LocalModelEndpoint): { modelOverrides: Record<string, string> } {
  return { modelOverrides: { [LOCAL_CLAUDE_REFERENCE_MODEL]: local.model } };
}

/**
 * Codex model catalog (`model_catalog_json`) holding the local model.
 *
 * Without metadata for its model, Codex emits "Model metadata for `<id>` not
 * found. Defaulting to fallback metadata" as an `error` item before the first
 * turn, which the runner's Codex backend treats as the end of the session. The
 * entry gives Codex what it needs: a shell tool (function-type `exec_command`,
 * which any OpenAI-compatible server can carry), text input only, no
 * reasoning levels, and the configured context window.
 *
 * Field set checked against codex-cli 0.166 (`codex exec --strict-config`);
 * `__tests__/unit/local-model-cli.test.ts` runs the bundled binary against it.
 */
export function codexLocalModelCatalog(local: LocalModelEndpoint): { models: Array<Record<string, unknown>> } {
  return {
    models: [{
      slug: local.model,
      display_name: local.model,
      description: 'Local model served on this machine',
      context_window: local.contextWindow ?? LOCAL_CODEX_DEFAULT_CONTEXT,
      supported_reasoning_levels: [],
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: 0,
      support_verbosity: false,
      supports_parallel_tool_calls: false,
      input_modalities: ['text'],
      truncation_policy: { mode: 'tokens', limit: 10000 },
      experimental_supported_tools: [],
      base_instructions: [
        'You are a coding agent running on the user\'s machine with a shell tool.',
        'Work in the current repository: read files, run commands, edit code and run tests with the tools you have.',
        'Keep going until the task is done, then summarise what you changed.',
      ].join(' '),
    }],
  };
}

/**
 * Top-level + table TOML for the Codex config.toml. Top-level keys come first
 * (TOML scopes anything after a `[table]` header into it). `catalogPath` is
 * the written codexLocalModelCatalog file.
 */
export function codexLocalProviderToml(local: LocalModelEndpoint, catalogPath: string): { topLevel: string[]; tables: string[] } {
  const q = (s: string) => JSON.stringify(s);
  return {
    topLevel: [
      `model_provider = ${q(LOCAL_CODEX_PROVIDER_ID)}`,
      `model = ${q(local.model)}`,
      ...(local.contextWindow ? [`model_context_window = ${local.contextWindow}`] : []),
      `model_catalog_json = ${q(catalogPath)}`,
      // Hosted web search is an OpenAI tool type a local server cannot run.
      'web_search = "disabled"',
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
