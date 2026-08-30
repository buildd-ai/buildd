/**
 * Inference calls as a first-class primitive.
 *
 * Buildd has two execution shapes and only ever had a supported path for one of
 * them. An **agent run** is stateful, tool-using, repo-bearing, and authed against
 * an OAuth subscription seat. An **inference call** is single-shot, synchronous,
 * structured, and metered in API tokens. Anything needing the second shape — a
 * classification, a judgment, a summary — got smuggled in as a hand-rolled
 * `fetch` to `api.anthropic.com`, and each site invented its own model
 * resolution, its own fence-stripping regex, and its own failure mode.
 *
 * This module is the one path. Callers name a *tier*, not a model, not a
 * provider, and not an endpoint. See `docs/design/inference-calls-primitive.md`.
 *
 * ## Provider routing
 *
 * The provider comes from the team's model tier registry, which has always stored
 * `provider: 'anthropic' | 'openai-codex' | 'openrouter'` per tier row and has
 * never had server-side code that honoured anything but Anthropic. Point a tier
 * row at OpenRouter and every inference call on that tier goes to OpenRouter —
 * no call-site edits.
 *
 * ## Why OAuth cannot back an inference call
 *
 * This is an architectural invariant, not a cost preference, and it is the reason
 * this module reads API keys only. OAuth subscription auth is runner-anchored:
 * the broker provisions a session token against a seat, not per request (see
 * `docs/design/runner-oauth-broker.md`). An inference call has no seat and no
 * session to anchor to. So `oauth_token` and `claude_credential` rows are
 * deliberately NOT consulted here, even though they would technically produce a
 * 200 on some endpoints. An inference call is metered API dollars or it is
 * `missing_key`. Do not revisit this per call site.
 *
 * This is also why prose goal criteria are graded by *dispatching a task* rather
 * than by calling this client: a dispatched agent run has a seat, so it can use
 * the subscription the team actually pays for. See `mission-criteria-prose.ts`.
 */

import { db } from './db';
import { secrets, teams } from './db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { decrypt } from './secrets';
import { resolveTierEntry } from './model-tier-registry';
import type { Tier, TierProvider } from './model-tier-defaults';
import { isInferenceEnabled, type InferenceCapability } from './inference-policy';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_MAX_TOKENS = 1024;
const RETRY_BACKOFF_MS = 1000;

/**
 * Default wall-clock ceiling per attempt.
 *
 * Inference calls sit inside request paths that must not hang — the
 * worker-completion PATCH and the cron tick. An unbounded fetch to a degraded
 * provider would hold both open.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Secret purpose holding an inference API key. `label` names the provider. */
export const INFERENCE_KEY_PURPOSE = 'inference_key' as const;

// ── Result and error types ────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Why an inference call did not produce an answer.
 *
 * Callers used to be unable to tell a missing key from a malformed response from
 * a timeout, because all three arrived as `[]`. Each of these wants a different
 * user-facing response, so each is a distinct kind.
 */
export type InferenceError =
  | { kind: 'missing_key'; provider: TierProvider }
  | { kind: 'capability_disabled'; capability: InferenceCapability }
  | { kind: 'unsupported_provider'; provider: string }
  | { kind: 'transport'; message: string }
  | { kind: 'provider_error'; status: number; body: string }
  | { kind: 'rate_limited'; retryAfter?: number }
  | { kind: 'parse'; raw: string };

export type InferenceResult<T> =
  | { ok: true; data: T; model: string; provider: TierProvider; usage: TokenUsage }
  | { ok: false; error: InferenceError };

/** One-line operator-facing summary of a failure. */
export function describeInferenceError(error: InferenceError): string {
  switch (error.kind) {
    case 'missing_key':
      return `no ${error.provider} inference key configured for this team`;
    case 'capability_disabled':
      return `inference is not enabled for '${error.capability}' on this team`;
    case 'unsupported_provider':
      return `provider '${error.provider}' cannot serve inference calls`;
    case 'transport':
      return `inference call failed to reach the provider: ${error.message}`;
    case 'provider_error':
      return `provider returned HTTP ${error.status}`;
    case 'rate_limited':
      return 'provider rate-limited the inference call';
    case 'parse':
      return 'provider response could not be parsed as the expected JSON';
  }
}

// ── Key resolution ────────────────────────────────────────────────────────────

/**
 * Env fallback per provider, kept only for backward compatibility while teams
 * migrate their keys into `secrets`. Neither var is set in production, which is
 * exactly the bug this indirection exists to stop repeating.
 */
const ENV_FALLBACK: Record<string, string | undefined> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/**
 * Purposes accepted for a provider's key, in preference order.
 *
 * `anthropic_api_key` is honoured for Anthropic so a team that already pasted a
 * key for worker runs does not have to paste it twice. Notably absent:
 * `oauth_token` and `claude_credential` — see the module docstring.
 */
const KEY_PURPOSES: Record<string, string[]> = {
  anthropic: [INFERENCE_KEY_PURPOSE, 'anthropic_api_key'],
  openrouter: [INFERENCE_KEY_PURPOSE],
};

export async function resolveInferenceKey(opts: {
  provider: TierProvider;
  teamId: string;
  workspaceId?: string | null;
}): Promise<string | null> {
  const purposes = KEY_PURPOSES[opts.provider] ?? [];

  if (purposes.length > 0) {
    const rows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, opts.teamId),
        or(...purposes.map(p => eq(secrets.purpose, p as never))),
        or(
          isNull(secrets.workspaceId),
          opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`,
        ),
      ),
      columns: {
        id: true, purpose: true, label: true, encryptedValue: true,
        workspaceId: true, healthStatus: true, updatedAt: true,
      },
    });

    // An `inference_key` row is provider-qualified by its label; an
    // `anthropic_api_key` row has no label to check and is Anthropic by purpose.
    //
    // The purpose is re-checked in JS rather than trusted to the `where`: a loose
    // or mocked query would otherwise let a purpose this provider does not accept
    // through, which for `openrouter` would mean handing an Anthropic key to
    // OpenRouter. A credential must never reach a provider it was not issued for.
    const candidates = rows.filter(r =>
      purposes.includes(r.purpose) &&
      (r.purpose !== INFERENCE_KEY_PURPOSE || (r.label ?? '').toLowerCase() === opts.provider),
    );

    // Same ordering as the claim route: purpose preference, workspace-scoped over
    // team-wide, healthy over revoked, then most recently updated — so a stale or
    // revoked leftover can never shadow a working key.
    const best = candidates.sort((a, b) =>
      purposes.indexOf(a.purpose) - purposes.indexOf(b.purpose) ||
      (b.workspaceId === opts.workspaceId ? 1 : 0) - (a.workspaceId === opts.workspaceId ? 1 : 0) ||
      ((a.healthStatus as string) === 'revoked' ? 1 : 0) - ((b.healthStatus as string) === 'revoked' ? 1 : 0) ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
    )[0];

    if (best) {
      try {
        const value = decrypt(best.encryptedValue);
        if (value) return value;
      } catch (e) {
        console.error(`[inference] failed to decrypt secret ${best.id}:`, e);
      }
    }
  }

  const envVar = ENV_FALLBACK[opts.provider];
  return (envVar ? process.env[envVar] : undefined) || null;
}

/**
 * Read the team's inference allowlist.
 *
 * Fails closed: if the lookup errors we treat inference as disabled rather than
 * spending money on the strength of a failed query.
 */
async function teamAllowsCapability(teamId: string, capability: InferenceCapability): Promise<boolean> {
  try {
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { enabledInferenceCapabilities: true },
    });
    return isInferenceEnabled(capability, team?.enabledInferenceCapabilities ?? null);
  } catch (e) {
    console.warn(`[inference] capability lookup failed for team ${teamId}:`, e);
    return false;
  }
}

// ── JSON extraction ───────────────────────────────────────────────────────────

/**
 * Pull a JSON object out of a model's text response.
 *
 * Centralised because there were three different regexes doing this, none of
 * which handled every case. Tries the raw text, then a fenced block, then the
 * first balanced-brace run — a plain `/\{[\s\S]*\}/` greedily swallows trailing
 * prose and fails on any commentary after the object.
 */
export function extractJson(text: string): unknown | null {
  const attempt = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const trimmed = text.trim();
  const direct = attempt(trimmed);
  if (direct !== null) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = attempt(fenced[1].trim());
    if (parsed !== null) return parsed;
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return attempt(trimmed.slice(start, i + 1));
    }
  }
  return null;
}

// ── Provider transports ───────────────────────────────────────────────────────

interface ProviderReply {
  text: string;
  usage: TokenUsage;
}

type Fetcher = typeof fetch;

async function callAnthropic(opts: {
  apiKey: string; model: string; system: string; user: string;
  imageB64?: string; maxTokens: number; fetcher: Fetcher; timeoutMs: number;
}): Promise<{ ok: true; reply: ProviderReply } | { ok: false; error: InferenceError }> {
  const content: unknown[] = [];
  if (opts.imageB64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: opts.imageB64 },
    });
  }
  content.push({ type: 'text', text: opts.user });

  const res = await opts.fetcher(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

  const failure = await classifyHttpFailure(res);
  if (failure) return { ok: false, error: failure };

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    ok: true,
    reply: {
      text: data.content?.find(b => b.type === 'text')?.text ?? '',
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    },
  };
}

async function callOpenRouter(opts: {
  apiKey: string; model: string; system: string; user: string;
  imageB64?: string; maxTokens: number; fetcher: Fetcher; timeoutMs: number;
}): Promise<{ ok: true; reply: ProviderReply } | { ok: false; error: InferenceError }> {
  // OpenAI-compatible chat format. Multimodal uses an image_url part with a data
  // URI rather than Anthropic's base64 source block.
  const userContent: unknown = opts.imageB64
    ? [
        { type: 'text', text: opts.user },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${opts.imageB64}` } },
      ]
    : opts.user;

  const res = await opts.fetcher(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${opts.apiKey}`,
      // OpenRouter attributes requests by referer/title; without them calls are
      // anonymous in the team's OpenRouter dashboard.
      'http-referer': 'https://buildd.dev',
      'x-title': 'buildd',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

  const failure = await classifyHttpFailure(res);
  if (failure) return { ok: false, error: failure };

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    ok: true,
    reply: {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    },
  };
}

async function classifyHttpFailure(res: Response): Promise<InferenceError | null> {
  if (res.ok) return null;
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    return { kind: 'rate_limited', ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
  }
  const body = await res.text().catch(() => '');
  return { kind: 'provider_error', status: res.status, body: body.slice(0, 500) };
}

/** Retryable failures are transient by nature; a 4xx or a parse error is not. */
function isRetryable(error: InferenceError): boolean {
  return error.kind === 'transport' || (error.kind === 'provider_error' && error.status >= 500);
}

// ── The primitive ─────────────────────────────────────────────────────────────

export interface InferenceCallParams<T> {
  /**
   * Which call site this is. Checked against the team's allowlist before any
   * spend — the check lives here rather than at each call site so a new caller
   * cannot forget it.
   */
  capability: InferenceCapability;
  /** Which tier to spend on. The provider and model come from the team's registry. */
  tier: Tier;
  teamId: string;
  workspaceId?: string | null;
  system: string;
  user: string;
  /** Base64 PNG for multimodal judgments (visual QA). */
  imageB64?: string;
  maxTokens?: number;
  /** Per-attempt wall-clock ceiling (default 20s). */
  timeoutMs?: number;
  /**
   * Turn the extracted JSON into the caller's type, or return null to reject it.
   * Kept as a callback rather than a schema object so this module stays free of a
   * validation-library version pin; callers may use zod inside it.
   */
  validate: (parsed: unknown) => T | null;
  /** Test seams. */
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Make one structured inference call.
 *
 * Resolves tier → provider + model, resolves the provider's key, calls the
 * provider, extracts JSON, and validates. Retries **once** on a transport error
 * or a 5xx; never on a 4xx, a rate limit, or a parse failure. Returns a typed
 * error rather than throwing, so callers can choose their own degradation — the
 * old sites all returned `[]` and left the operator with no way to tell why.
 */
export async function inferenceCall<T>(params: InferenceCallParams<T>): Promise<InferenceResult<T>> {
  const fetcher = params.fetcher ?? fetch;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Ask permission before doing anything that costs money or time. Checked first,
  // ahead of tier resolution, so a disabled capability is one cheap query.
  if (!(await teamAllowsCapability(params.teamId, params.capability))) {
    return { ok: false, error: { kind: 'capability_disabled', capability: params.capability } };
  }

  const entry = await resolveTierEntry(params.tier, params.teamId, params.workspaceId);
  const provider = entry.provider;

  if (provider !== 'anthropic' && provider !== 'openrouter') {
    // openai-codex is an agent backend: it drives a CLI with its own session, not
    // a single-shot structured endpoint this client can speak to.
    return { ok: false, error: { kind: 'unsupported_provider', provider } };
  }

  const apiKey = await resolveInferenceKey({
    provider,
    teamId: params.teamId,
    workspaceId: params.workspaceId,
  });
  if (!apiKey) return { ok: false, error: { kind: 'missing_key', provider } };

  const invoke = async (): Promise<{ ok: true; reply: ProviderReply } | { ok: false; error: InferenceError }> => {
    try {
      const args = {
        apiKey, model: entry.model, system: params.system, user: params.user,
        imageB64: params.imageB64, maxTokens, fetcher,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      };
      return provider === 'anthropic' ? await callAnthropic(args) : await callOpenRouter(args);
    } catch (e) {
      return { ok: false, error: { kind: 'transport', message: e instanceof Error ? e.message : String(e) } };
    }
  };

  let attempt = await invoke();
  if (!attempt.ok && isRetryable(attempt.error)) {
    await sleep(RETRY_BACKOFF_MS);
    attempt = await invoke();
  }
  if (!attempt.ok) {
    console.error(`[inference] ${provider}/${entry.model} tier=${params.tier}: ${describeInferenceError(attempt.error)}`);
    return { ok: false, error: attempt.error };
  }

  const extracted = extractJson(attempt.reply.text);
  const data = extracted === null ? null : params.validate(extracted);
  if (data === null) {
    console.error(`[inference] ${provider}/${entry.model}: unparseable response: ${attempt.reply.text.slice(0, 200)}`);
    return { ok: false, error: { kind: 'parse', raw: attempt.reply.text.slice(0, 2000) } };
  }

  return { ok: true, data, model: entry.model, provider, usage: attempt.reply.usage };
}
