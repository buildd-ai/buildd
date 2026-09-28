/**
 * The `chat` decision endpoint: typed questions answered by any model behind
 * an OpenAI-compatible `/chat/completions` API (a LiteLLM proxy, vLLM, Ollama,
 * OpenRouter's chat API, an open-weights model). `decide` calls it when
 * `endpoint.kind === 'chat'`.
 *
 * One request per question. The options are lettered (`A`, `B`, ...) and the
 * model is asked for one token at temperature 0 with `top_logprobs`. The
 * probabilities are read from those logprobs, renormalised over the option
 * letters, so a chat model returns the same answer shape as Jev:
 *
 * - `choice`: the most probable label; `confidence` is its probability;
 * - `score`: the probability-weighted level index; `confidence` is the top
 *   level's probability;
 * - `noul`: the probability of yes.
 *
 * A model that returns no logprobs has no confidence to give. That is the
 * `uncalibrated` error, never an invented number: gates and thresholds are
 * only meaningful over real probabilities. Thresholds never transfer between
 * models, or from Jev: re-run the eval for each model.
 *
 * Pure apart from `fetch`. Types come from `./index` as types only, so there
 * is no runtime import cycle.
 */
import type {
  ChoiceQuestion,
  DecideError,
  DecisionAnswers,
  DecisionQuestion,
  DecisionQuestions,
  DecisionText,
  DecisionUsage,
  NoulQuestion,
  ScoreQuestion,
} from './index';

/** `top_logprobs` is capped at 20 by OpenAI-compatible servers: one letter per option. */
export const MAX_CHAT_OPTIONS = 20;
const LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('');

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatDecideArgs<Q extends DecisionQuestions> {
  /** OpenAI-compatible API root, e.g. `https://litellm.example.com/v1`. `/chat/completions` is appended. */
  baseURL: string;
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
}

export type ChatDecideResult<Q extends DecisionQuestions> =
  | { ok: true; answers: DecisionAnswers<Q>; model: string; usage: DecisionUsage; attempts: number }
  | { ok: false; error: DecideError; attempts: number };

const text = (v: DecisionText | null | undefined) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** The lettered options for one question, in order. */
export function chatOptions(q: DecisionQuestion): { letter: string; key: string; label: string; definition: string }[] {
  if (q.type === 'choice') {
    return Object.entries((q as ChoiceQuestion).criteria).map(([label, def], i) => ({ letter: LETTERS[i], key: label, label, definition: text(def) }));
  }
  if (q.type === 'score') {
    const levels = (q as ScoreQuestion).criteria;
    return levels.map((def, i) => ({
      letter: LETTERS[i], key: String(i),
      label: `level ${i}${i === 0 ? ' (lowest)' : i === levels.length - 1 ? ' (highest)' : ''}`,
      definition: text(def),
    }));
  }
  const c = (q as NoulQuestion).criteria;
  return [
    { letter: 'A', key: 'yes', label: 'yes', definition: text(c?.true) },
    { letter: 'B', key: 'no', label: 'no', definition: text(c?.false) },
  ];
}

/** The chat messages for one question. */
export function chatMessages(state: ChatDecideArgs<DecisionQuestions>['state'], q: DecisionQuestion) {
  const opts = chatOptions(q);
  const stateText = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
  return [
    {
      role: 'system',
      content: 'You classify. Read the state, then answer the question with the letter of the single best option. Reply with that letter only.',
    },
    {
      role: 'user',
      content: [
        'State:', stateText, '',
        'Question:', text(q.instructions), '',
        'Options:',
        ...opts.map(o => `${o.letter}. ${o.label}${o.definition ? `: ${o.definition}` : ''}`),
        '',
        `Answer with one letter: ${opts.map(o => o.letter).join(', ')}.`,
      ].join('\n'),
    },
  ];
}

/** Token → option letter: " A", "A.", "(a)" all read as A. */
function letterOf(token: string): string | null {
  const t = token.trim().replace(/^[("'`*]+|[)"'`*.:]+$/g, '').toUpperCase();
  return t.length === 1 && LETTERS.includes(t) ? t : null;
}

/**
 * Option probabilities from a completion's first-token `top_logprobs`,
 * renormalised over the option letters. Null when the response has none.
 */
export function probabilitiesFromLogprobs(body: unknown, letters: readonly string[]): Record<string, number> | null {
  const top = (body as any)?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
  if (!Array.isArray(top) || top.length === 0) return null;
  const mass: Record<string, number> = {};
  for (const entry of top) {
    if (!entry || typeof entry.token !== 'string' || typeof entry.logprob !== 'number') continue;
    const l = letterOf(entry.token);
    if (l && letters.includes(l)) mass[l] = (mass[l] ?? 0) + Math.exp(entry.logprob);
  }
  const total = Object.values(mass).reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(letters.map(l => [l, (mass[l] ?? 0) / total]));
}

/** One question's answer from its option probabilities (keyed by letter). */
export function answerFromProbabilities(q: DecisionQuestion, byLetter: Record<string, number>): unknown {
  const opts = chatOptions(q);
  const p = (o: { letter: string }) => byLetter[o.letter] ?? 0;
  const best = opts.reduce((a, b) => (p(b) > p(a) ? b : a));
  if (q.type === 'noul') return { type: 'noul', noul: p(opts[0]) };
  const probabilities = Object.fromEntries(opts.map(o => [o.key, p(o)]));
  if (q.type === 'score') {
    return {
      type: 'score',
      score: opts.reduce((s, o, i) => s + i * p(o), 0),
      legend: Object.fromEntries(opts.map(o => [o.key, o.definition])),
      probabilities,
      confidence: p(best),
    };
  }
  return { type: 'choice', choice: best.key, probabilities, confidence: p(best) };
}

/** A chat request is refused locally when a question has more options than one token's logprobs can cover. */
export function validateChatQuestions(questions: DecisionQuestions): string | null {
  for (const [name, q] of Object.entries(questions)) {
    const n = chatOptions(q).length;
    if (n > MAX_CHAT_OPTIONS) return `question '${name}' has ${n} options; the chat endpoint supports at most ${MAX_CHAT_OPTIONS}`;
  }
  return null;
}

type OneResult =
  | { ok: true; answer: unknown; model: string | null; input: number; output: number; cost: number | null; attempts: number }
  | { ok: false; error: DecideError; attempts: number };

async function askOne(args: ChatDecideArgs<DecisionQuestions>, q: DecisionQuestion): Promise<OneResult> {
  const url = `${args.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const letters = chatOptions(q).map(o => o.letter);
  const payload: Record<string, unknown> = {
    model: args.model,
    messages: chatMessages(args.state, q),
    max_tokens: 1,
    temperature: 0,
    logprobs: true,
    top_logprobs: MAX_CHAT_OPTIONS,
  };
  // OpenRouter returns the call's cost only when asked.
  if (/(^|\.)openrouter\.ai$/.test(new URL(url).hostname)) payload.usage = { include: true };

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
        body: JSON.stringify(payload),
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

    let body: any;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: { kind: 'parse', message: 'response was not JSON' }, attempts };
    }
    const probs = probabilitiesFromLogprobs(body, letters);
    if (!probs) {
      return {
        ok: false,
        error: { kind: 'uncalibrated', message: `model '${args.model}' returned no usable token logprobs for the option letters` },
        attempts,
      };
    }
    const cost = body?.usage?.cost;
    return {
      ok: true,
      answer: answerFromProbabilities(q, probs),
      model: typeof body?.model === 'string' ? body.model : null,
      input: Number(body?.usage?.prompt_tokens) || 0,
      output: Number(body?.usage?.completion_tokens) || 0,
      cost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      attempts,
    };
  }
  return { ok: false, error: lastError, attempts };
}

/** Every question in parallel, inside the one deadline. The first failure fails the call. */
export async function decideViaChat<Q extends DecisionQuestions>(args: ChatDecideArgs<Q>): Promise<ChatDecideResult<Q>> {
  const names = Object.keys(args.questions);
  const results = await Promise.all(names.map(n => askOne(args as ChatDecideArgs<DecisionQuestions>, args.questions[n])));
  const attempts = Math.max(0, ...results.map(r => r.attempts));
  const failed = results.find((r): r is Extract<OneResult, { ok: false }> => !r.ok);
  if (failed) return { ok: false, error: failed.error, attempts };
  const oks = results as Extract<OneResult, { ok: true }>[];
  const costs = oks.map(r => r.cost);
  return {
    ok: true,
    answers: Object.fromEntries(names.map((n, i) => [n, oks[i].answer])) as DecisionAnswers<Q>,
    model: oks.find(r => r.model)?.model ?? args.model,
    usage: {
      inputTokens: oks.reduce((s, r) => s + r.input, 0),
      outputTokens: oks.reduce((s, r) => s + r.output, 0),
      costUsd: costs.every(c => c !== null) ? costs.reduce((s, c) => s + (c as number), 0) : null,
    },
    attempts,
  };
}
