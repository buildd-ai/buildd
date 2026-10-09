/**
 * The `workers-ai` decision endpoint: Cloudflare's Clef decision models
 * (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`) on Workers AI, called
 * directly (`https://api.cloudflare.com/client/v4/accounts/<id>/ai/run`) or
 * through an AI Gateway (`https://gateway.ai.cloudflare.com/v1/<id>/<gw>/workers-ai`).
 * `decide` calls it when `endpoint.kind === 'workers-ai'`.
 *
 * Clef speaks the System One request and answer shape (`state`, typed
 * `questions`, `answers` keyed by question name), so the answers go through the
 * same `parseDecisionAnswers` as Jev's. What differs is the transport: the
 * model is a path segment, the key is a Cloudflare API token, and the
 * Cloudflare REST API wraps the body in `{ success, errors, result }`, which
 * is unwrapped here.
 *
 * Thresholds measured on Jev do not transfer to Clef: re-run the eval.
 *
 * Pure apart from `fetch`. Types come from `./index` as types only, so there
 * is no runtime import cycle.
 */
import type { DecideError, DecisionAnswers, DecisionQuestions, DecisionUsage } from './index';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** The Clef models, by the id the request body's `model` takes. */
export const CLEF_MODEL = 'clef';
export const CLEF_FLASH_MODEL = 'clef-flash';
export const CLEF_MODELS = [CLEF_MODEL, CLEF_FLASH_MODEL] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];

const CLEF_RE = /^(?:@cf\/)?(?:cloudflare\/)?(clef(?:-flash)?)$/;

/** True for a Clef model id: `clef`, `clef-flash`, or their `@cf/cloudflare/…` (or `cloudflare/…`) forms. */
export function isClefModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && CLEF_RE.test(model.trim());
}

/** A Clef id as the body's `model` (`clef` / `clef-flash`) and its Workers AI path (`@cf/cloudflare/clef`). Null when it is not Clef. */
export function clefModelIds(model: string): { body: ClefModel; path: string } | null {
  const m = CLEF_RE.exec(model.trim());
  if (!m) return null;
  const body = m[1] as ClefModel;
  return { body, path: `@cf/cloudflare/${body}` };
}

export interface WorkersAiDecideArgs<Q extends DecisionQuestions> {
  /** Workers AI root: `…/accounts/<id>/ai/run`, or an AI Gateway's `…/workers-ai`. The model path is appended. */
  baseURL: string;
  /** A Cloudflare API token with Workers AI access. */
  apiKey: string;
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Q;
  headers: Record<string, string>;
  fetch: Fetcher;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  started: number;
  timeoutMs: number;
  attemptTimeoutMs?: number;
  maxAttempts: number;
  retryable: (status: number) => boolean;
  backoff: number;
  minRetryBudget: number;
  /** `parseDecisionAnswers`, passed in so this file needs no runtime import from `./index`. */
  parse: (questions: Q, raw: unknown) => { ok: true; answers: DecisionAnswers<Q> } | { ok: false; message: string };
}

export type WorkersAiDecideResult<Q extends DecisionQuestions> =
  | { ok: true; answers: DecisionAnswers<Q>; model: string; usage: DecisionUsage; attempts: number }
  | { ok: false; error: DecideError; attempts: number };

/** The Cloudflare REST envelope's `result`, or the body itself when it is not wrapped (AI Gateway may pass it through). */
function unwrap(body: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'response was not a JSON object' };
  const b = body as Record<string, unknown>;
  if ('result' in b && ('success' in b || 'errors' in b)) {
    if (b.success === false) return { ok: false, message: describeErrors(b.errors) || 'Workers AI reported success: false' };
    const r = b.result;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, message: 'Workers AI result missing' };
    return { ok: true, value: r as Record<string, unknown> };
  }
  return { ok: true, value: b };
}

function describeErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return '';
  return errors.map(e => (e && typeof e === 'object' ? String((e as { message?: unknown }).message ?? '') : '')).filter(Boolean).join('; ');
}

function tokens(usage: Record<string, unknown> | undefined, ...keys: string[]): number {
  for (const k of keys) {
    const n = Number(usage?.[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export async function decideViaWorkersAi<Q extends DecisionQuestions>(args: WorkersAiDecideArgs<Q>): Promise<WorkersAiDecideResult<Q>> {
  const ids = clefModelIds(args.model);
  if (!ids) {
    return { ok: false, error: { kind: 'invalid_request', message: `model '${args.model}' is not a Clef model (clef, clef-flash)` }, attempts: 0 };
  }
  const url = `${args.baseURL.replace(/\/+$/, '')}/${ids.path}`;
  const payload = JSON.stringify({ model: ids.body, state: args.state, questions: args.questions });

  let attempts = 0;
  let lastError: DecideError = { kind: 'transport', message: 'not attempted' };
  while (attempts < args.maxAttempts) {
    const remaining = args.timeoutMs - (args.now() - args.started);
    if (remaining <= 0) return { ok: false, error: { kind: 'timeout', timeoutMs: args.timeoutMs }, attempts };
    if (attempts > 0 && remaining < args.minRetryBudget) break;
    attempts++;
    const capped = args.attemptTimeoutMs !== undefined && args.attemptTimeoutMs < remaining;
    const budget = capped ? args.attemptTimeoutMs! : remaining;

    let res: Response;
    try {
      res = await args.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...args.headers, authorization: `Bearer ${args.apiKey}` },
        body: payload,
        signal: AbortSignal.timeout(budget),
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        lastError = { kind: 'timeout', timeoutMs: args.timeoutMs };
        if (!capped) return { ok: false, error: lastError, attempts };
      } else {
        lastError = { kind: 'transport', message: e instanceof Error ? e.message : String(e) };
      }
      if (attempts < args.maxAttempts) await args.sleep(args.backoff * 2 ** (attempts - 1));
      continue;
    }

    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        lastError = { kind: 'rate_limited', ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
      } else {
        lastError = { kind: 'provider_error', status: res.status, body };
      }
      if (!args.retryable(res.status)) return { ok: false, error: lastError, attempts };
      if (attempts < args.maxAttempts) await args.sleep(args.backoff * 2 ** (attempts - 1));
      continue;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: { kind: 'parse', message: 'response was not JSON' }, attempts };
    }
    const result = unwrap(body);
    if (!result.ok) return { ok: false, error: { kind: 'parse', message: result.message }, attempts };
    const parsed = args.parse(args.questions, result.value.answers);
    if (!parsed.ok) return { ok: false, error: { kind: 'parse', message: parsed.message }, attempts };
    const usage = result.value.usage as Record<string, unknown> | undefined;
    return {
      ok: true,
      answers: parsed.answers,
      model: typeof result.value.model === 'string' ? result.value.model : ids.path,
      usage: {
        inputTokens: tokens(usage, 'input_tokens', 'prompt_tokens'),
        outputTokens: tokens(usage, 'output_tokens', 'completion_tokens'),
        // Workers AI bills per neuron and does not return a cost.
        costUsd: null,
      },
      attempts,
    };
  }
  return { ok: false, error: lastError, attempts };
}
