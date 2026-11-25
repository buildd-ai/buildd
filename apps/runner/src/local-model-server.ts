/**
 * This machine's local model server, as the relay sees it
 * (docs/specs/local-runner-provider.md §6.1, §6.2): detect it, list what it
 * serves, and call it.
 *
 * Detection: Ollama first (`GET /api/tags`, `POST /api/show` per model for
 * capabilities and the embedding length), then any OpenAI-compatible server
 * (`GET /v1/models`: LM Studio, llama.cpp, vLLM). The compatible list carries
 * no capabilities, so an embedding model is recognised by name and its size is
 * measured with one tiny embedding call.
 *
 * Inference always goes through the OpenAI-compatible routes both kinds serve:
 * `POST /v1/embeddings` and `POST /v1/chat/completions` (streamed).
 *
 *   BUILDD_LOCAL_MODEL_URL    base URL, default http://127.0.0.1:11434 (loopback only)
 *   BUILDD_LOCAL_MODEL_RELAY  `0` opts out: nothing is probed, advertised or claimed
 *
 * The advert says what is served, never where: no URL leaves this module
 * except in requests to the loopback server itself.
 */
import {
  LOCAL_MODELS_ADVERT_MAX_MODELS,
  isLocalModelName,
  type LocalModelAdvert,
  type LocalModelCapability,
  type LocalModelsAdvert,
  type LocalModelsServer,
  type RelayErrorCode,
} from '@buildd/shared';
import { LOCAL_MODEL_URL_ENV, isLoopbackHost } from './local-model-endpoint';

export const DEFAULT_LOCAL_MODEL_SERVER_URL = 'http://127.0.0.1:11434';
export const LOCAL_MODEL_RELAY_ENV = 'BUILDD_LOCAL_MODEL_RELAY';
/** How often the runner looks at the server again when nothing prompts it. */
export const LOCAL_MODEL_PROBE_INTERVAL_MS = 5 * 60_000;

const PROBE_TIMEOUT_MS = 3_000;
const MEASURE_TIMEOUT_MS = 30_000;
const ERROR_MESSAGE_MAX = 300;
const SHORT_MAX = 64;

/**
 * Where to look for the local model server, or null when the relay is off:
 * opted out, or the configured URL is unusable (not a URL, not http, not
 * loopback). Never throws: a bad URL already fails the runner's agent config
 * loudly (local-model-endpoint.ts); here it only means "advertise nothing".
 */
export function resolveLocalModelServer(env: Record<string, string | undefined>): { origin: string } | null {
  if (env[LOCAL_MODEL_RELAY_ENV]?.trim() === '0') return null;
  const raw = env[LOCAL_MODEL_URL_ENV]?.trim() || DEFAULT_LOCAL_MODEL_SERVER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHost(url.hostname)) return null;
  return { origin: url.origin };
}

/** A failed call to the local model server, already in the relay's error vocabulary. */
export class LocalModelError extends Error {
  constructor(readonly code: RelayErrorCode, message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'LocalModelError';
  }
}

export interface LocalChatMessage { role: string; content: string }

/** Sampling options as the relay's chat payload carries them (`relayChatPayload`). */
export interface LocalChatOptions {
  temperature?: number;
  maxOutputTokens?: number;
  stop?: string[];
  topP?: number;
  topK?: number;
  seed?: number;
}

export interface LocalChatResult {
  text: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** Completion tokens per second of generation, when the server reported token counts. */
  evalRate?: number;
}

export interface LocalEmbedResult {
  vectors: number[][];
  promptTokens?: number;
}

export interface LocalModelServerOptions {
  origin: string;
  fetch?: typeof fetch;
  now?: () => number;
  probeTimeoutMs?: number;
}

const NO_ANSWER = Symbol('no answer');
const EMBEDDING_NAME_RE = /embed|(^|[/_-])(bge|e5|gte|minilm|arctic)([/_:-]|$)/i;
const MISSING_MODEL_RE = /model\b.*\b(not found|does not exist|not loaded)|no such model|unknown model/i;

/** OpenAI's finish reasons in the chat layer's vocabulary. */
const FINISH_REASONS: Record<string, string> = { stop: 'stop', length: 'length', content_filter: 'content-filter', tool_calls: 'tool-calls' };

function shortLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v && v.length <= SHORT_MAX && !v.includes('://') ? v : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `model_info["<arch>.<suffix>"]`, whatever the architecture is called. */
function modelInfoNumber(info: unknown, suffix: string): number | null {
  if (!info || typeof info !== 'object') return null;
  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key.endsWith(`.${suffix}`)) return positiveInt(value);
  }
  return null;
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = parsed.error;
    const msg = typeof e === 'string' ? e : (e && typeof e === 'object' ? (e as { message?: unknown }).message : parsed.message);
    if (typeof msg === 'string' && msg) return msg.slice(0, ERROR_MESSAGE_MAX);
  } catch { /* not JSON */ }
  return body.trim().slice(0, ERROR_MESSAGE_MAX);
}

export class LocalModelServer {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private current: LocalModelsAdvert | null = null;
  private fingerprint = 'null';
  /** Per model (name and digest): what `/api/show` said, so a probe does not ask again. */
  private readonly details = new Map<string, Omit<LocalModelAdvert, 'name'>>();
  /** Measured embedding lengths, per model name. */
  private readonly measured = new Map<string, number | null>();

  constructor(opts: LocalModelServerOptions) {
    this.origin = opts.origin.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  }

  /** The last probe as a heartbeat advert; null until a server has answered once. */
  advert(): LocalModelsAdvert | null {
    return this.current;
  }

  /** The tags a claim may name: what the server served at the last probe. */
  modelNames(): string[] {
    return this.current?.server.reachable ? this.current.models.map(m => m.name) : [];
  }

  /**
   * Look at the server now. Resolves true when what it serves changed since
   * the last probe (models, capabilities, sizes, version, reachability).
   * Never throws.
   */
  async probe(): Promise<boolean> {
    const checkedAt = new Date(this.now()).toISOString();
    let found: { server: Omit<LocalModelsServer, 'checkedAt'>; models: LocalModelAdvert[] } | null = null;
    try {
      found = (await this.probeOllama()) ?? (await this.probeOpenAiCompat());
    } catch {
      found = null;
    }
    if (!found) {
      // A machine that never had a server advertises nothing; one that did says it went away.
      if (!this.current) return false;
      found = { server: { kind: this.current.server.kind, version: this.current.server.version, reachable: false }, models: [] };
    }
    const fingerprint = JSON.stringify(found);
    const changed = fingerprint !== this.fingerprint;
    this.fingerprint = fingerprint;
    this.current = { server: { ...found.server, checkedAt }, models: found.models };
    return changed;
  }

  /** The JSON body of a 2xx answer; null for any other answer; `NO_ANSWER` when nothing answered at all. */
  private async getJson(path: string, init: RequestInit = {}, timeoutMs = this.probeTimeoutMs): Promise<any | null | typeof NO_ANSWER> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return NO_ANSWER;
    }
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private async probeOllama(): Promise<{ server: Omit<LocalModelsServer, 'checkedAt'>; models: LocalModelAdvert[] } | null> {
    const tags = await this.getJson('/api/tags');
    // Nothing listening: one refused connection per probe, not one per server kind.
    if (tags === NO_ANSWER) throw new Error('no local model server');
    if (!tags || !Array.isArray(tags.models)) return null;
    const versionReply = await this.getJson('/api/version');
    const version = shortLabel(versionReply && versionReply !== NO_ANSWER ? versionReply.version : null);
    const models: LocalModelAdvert[] = [];
    for (const tag of tags.models as Array<Record<string, any>>) {
      const name = tag?.name ?? tag?.model;
      if (!isLocalModelName(name)) continue;
      if (models.length >= LOCAL_MODELS_ADVERT_MAX_MODELS) break;
      const key = `${name}@${typeof tag.digest === 'string' ? tag.digest : ''}`;
      let detail = this.details.get(key);
      if (!detail) {
        const show = await this.getJson('/api/show', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }),
        });
        const answered = show && show !== NO_ANSWER ? show : null;
        detail = await this.describeOllamaModel(name, tag, answered);
        // Keep only an answer the server gave: a failed show is asked again next probe.
        if (answered) this.details.set(key, detail);
      }
      models.push({ name, ...detail });
    }
    return { server: { kind: 'ollama', version, reachable: true }, models };
  }

  private async describeOllamaModel(name: string, tag: Record<string, any>, show: any): Promise<Omit<LocalModelAdvert, 'name'>> {
    const details = show?.details ?? tag.details ?? {};
    const family = shortLabel(details.family);
    const listed = Array.isArray(show?.capabilities) ? (show.capabilities as unknown[]) : null;
    let capabilities: LocalModelCapability[];
    if (listed) {
      capabilities = (['embedding', 'completion'] as const).filter(c => listed.includes(c));
    } else {
      // An Ollama that predates `capabilities`: go by the family and the name.
      capabilities = [EMBEDDING_NAME_RE.test(name) || /bert/i.test(family ?? '') ? 'embedding' : 'completion'];
    }
    const embeds = capabilities.includes('embedding');
    let dimensions = embeds ? modelInfoNumber(show?.model_info, 'embedding_length') : null;
    if (embeds && dimensions === null) dimensions = await this.measureDimensions(name);
    return {
      family,
      parameterSize: shortLabel(details.parameter_size),
      capabilities,
      dimensions,
      contextLength: modelInfoNumber(show?.model_info, 'context_length'),
    };
  }

  private async probeOpenAiCompat(): Promise<{ server: Omit<LocalModelsServer, 'checkedAt'>; models: LocalModelAdvert[] } | null> {
    const list = await this.getJson('/v1/models');
    if (!list || list === NO_ANSWER || !Array.isArray(list.data)) return null;
    const models: LocalModelAdvert[] = [];
    for (const entry of list.data as Array<Record<string, unknown>>) {
      const name = entry?.id;
      if (!isLocalModelName(name)) continue;
      if (models.length >= LOCAL_MODELS_ADVERT_MAX_MODELS) break;
      const embeds = EMBEDDING_NAME_RE.test(name);
      models.push({
        name, family: null, parameterSize: null,
        capabilities: [embeds ? 'embedding' : 'completion'],
        dimensions: embeds ? await this.measureDimensions(name) : null,
        contextLength: null,
      });
    }
    return { server: { kind: 'openai_compat', version: null, reachable: true }, models };
  }

  /** The length of one real embedding, for a server that does not say. Asked once per model. */
  private async measureDimensions(model: string): Promise<number | null> {
    if (this.measured.has(model)) return this.measured.get(model)!;
    let dimensions: number | null = null;
    try {
      const { vectors } = await this.embed(model, ['a'], AbortSignal.timeout(MEASURE_TIMEOUT_MS));
      dimensions = positiveInt(vectors[0]?.length);
    } catch { /* stays unknown: the picker lists it as unsupported */ }
    // A failed measurement is not remembered, so a model still loading is tried again.
    if (dimensions !== null) this.measured.set(model, dimensions);
    return dimensions;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new LocalModelError('timeout', 'the local model call was stopped before it finished');
      throw new LocalModelError('ollama_error', `the local model server did not answer: ${err instanceof Error ? err.message.slice(0, ERROR_MESSAGE_MAX) : 'connection failed'}`);
    }
    if (res.ok) return res;
    const text = errorText(await res.text().catch(() => ''));
    if (MISSING_MODEL_RE.test(text)) throw new LocalModelError('model_missing', text, res.status);
    throw new LocalModelError('ollama_error', text || `the local model server answered HTTP ${res.status}`, res.status);
  }

  /** `POST /v1/embeddings`: one vector per input, in input order, exactly as the server returned them. */
  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<LocalEmbedResult> {
    const res = await this.post('/v1/embeddings', { model, input: inputs }, signal);
    let body: any;
    try {
      body = await res.json();
    } catch {
      if (signal?.aborted) throw new LocalModelError('timeout', 'the local model call was stopped before it finished');
      throw new LocalModelError('bad_result', 'the embeddings answer was not JSON');
    }
    if (!Array.isArray(body?.data)) throw new LocalModelError('bad_result', 'the embeddings answer has no data array');
    const rows = [...body.data as Array<{ index?: unknown; embedding?: unknown }>]
      .map((row, i) => ({ index: typeof row?.index === 'number' ? row.index : i, embedding: row?.embedding }))
      .sort((a, b) => a.index - b.index);
    const vectors: number[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row.embedding)) throw new LocalModelError('bad_result', 'an embedding is not an array');
      vectors.push(row.embedding as number[]);
    }
    const promptTokens = body.usage?.prompt_tokens;
    return { vectors, ...(typeof promptTokens === 'number' && Number.isFinite(promptTokens) ? { promptTokens } : {}) };
  }

  /**
   * `POST /v1/chat/completions`, streamed: `onDelta` gets each piece of text as
   * it arrives, the result holds all of it. A server that answers in one JSON
   * body is read as such.
   */
  async chat(
    model: string,
    messages: LocalChatMessage[],
    options: LocalChatOptions = {},
    run: { signal?: AbortSignal; onDelta?: (delta: string) => void } = {},
  ): Promise<LocalChatResult> {
    const request: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (typeof options.temperature === 'number') request.temperature = options.temperature;
    if (typeof options.maxOutputTokens === 'number') request.max_tokens = options.maxOutputTokens;
    if (Array.isArray(options.stop) && options.stop.length) request.stop = options.stop;
    if (typeof options.topP === 'number') request.top_p = options.topP;
    if (typeof options.seed === 'number') request.seed = options.seed;
    // topK has no OpenAI-compatible field; it is left to the model's own default.

    const res = await this.post('/v1/chat/completions', request, run.signal);
    const started = this.now();
    let firstTokenAt: number | null = null;
    let text = '';
    let finish: string | null = null;
    let usage: LocalChatResult['usage'];

    const take = (chunk: any) => {
      const choice = chunk?.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content;
      if (typeof delta === 'string' && delta) {
        firstTokenAt ??= this.now();
        text += delta;
        run.onDelta?.(delta);
      }
      if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason;
      const u = chunk?.usage;
      if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
        usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
      }
    };

    try {
      if ((res.headers.get('content-type') ?? '').includes('application/json')) {
        take(await res.json());
      } else if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const line = (raw: string) => {
          const l = raw.trim();
          if (!l.startsWith('data:')) return;
          const data = l.slice(5).trim();
          if (!data || data === '[DONE]') return;
          try { take(JSON.parse(data)); } catch { /* a frame that is not JSON carries no text */ }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        }
        line(buffer);
      }
    } catch (err) {
      if (err instanceof LocalModelError) throw err;
      if (run.signal?.aborted) throw new LocalModelError('timeout', 'the local model call was stopped before it finished');
      throw new LocalModelError('ollama_error', `the local model stream broke: ${err instanceof Error ? err.message.slice(0, ERROR_MESSAGE_MAX) : 'read failed'}`);
    }

    const result: LocalChatResult = { text, finishReason: finish ? (FINISH_REASONS[finish] ?? 'other') : 'other' };
    if (usage) {
      result.usage = usage;
      const seconds = (this.now() - (firstTokenAt ?? started)) / 1000;
      if (usage.completionTokens > 0 && seconds > 0) result.evalRate = Math.round((usage.completionTokens / seconds) * 10) / 10;
    }
    return result;
  }
}
