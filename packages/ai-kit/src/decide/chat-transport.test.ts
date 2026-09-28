import { describe, expect, it } from 'bun:test';
import { choice, decide, defineDecision, noul, resolveDecisionEndpoint, score, toModelsUsage, type DecisionReceipt } from './index';
import { chatMessages, chatOptions, MAX_CHAT_OPTIONS, probabilitiesFromLogprobs } from './chat-transport';

const noSleep = () => Promise.resolve();
const QUESTIONS = { team: choice('Which team?', { payments: 'Billing', frontend: 'Layout' }), bug: noul('Is it a bug?') };
const ENDPOINT = { kind: 'chat' as const, baseURL: 'https://litellm.example.test/v1' };

/** An OpenAI-compatible completion whose first token has these top logprobs. */
function completion(top: Record<string, number>, over: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    model: 'qwen3-8b',
    choices: [{
      message: { content: Object.keys(top)[0] },
      logprobs: { content: [{ token: Object.keys(top)[0], logprob: 0, top_logprobs: Object.entries(top).map(([token, p]) => ({ token, logprob: Math.log(p) })) }] },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 1 },
    ...over,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Answers each question by recognising its prompt. */
function fakeServer(seen: { url: string; body: any; headers: Headers }[] = []) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    seen.push({ url, body, headers: new Headers(init!.headers) });
    const prompt = body.messages[1].content as string;
    if (prompt.includes('Which team?')) return completion({ ' A': 0.72, ' B': 0.18, 'The': 0.1 });
    return completion({ A: 0.9, B: 0.1 });
  };
}

const call = (over: Record<string, unknown> = {}) =>
  decide({ apiKey: 'sk-litellm', endpoint: ENDPOINT, model: 'qwen3-8b', state: { ticket: 'Checkout is blank' }, questions: QUESTIONS, sleep: noSleep, fetch: fakeServer(), ...over });

describe('chat endpoint', () => {
  it('asks one lettered, single-token question per request with logprobs, to the given base URL', async () => {
    const seen: { url: string; body: any; headers: Headers }[] = [];
    const res = await call({ fetch: fakeServer(seen) });
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.url).toBe('https://litellm.example.test/v1/chat/completions');
      expect(s.headers.get('authorization')).toBe('Bearer sk-litellm');
      expect(s.body).toMatchObject({ model: 'qwen3-8b', max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: MAX_CHAT_OPTIONS });
      expect(s.body.usage).toBeUndefined();
    }
  });

  it('returns Jev-shaped answers from renormalised option probabilities', async () => {
    const res = await call();
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.answers.team.choice).toBe('payments');
    expect(res.answers.team.probabilities.payments).toBeCloseTo(0.8, 5);
    expect(res.answers.team.confidence).toBeCloseTo(0.8, 5);
    expect(res.answers.bug.noul).toBeCloseTo(0.9, 5);
    expect(res.model).toBe('qwen3-8b');
    expect(res.usage).toEqual({ inputTokens: 240, outputTokens: 2, costUsd: null });
  });

  it('refuses to invent a confidence when the model returns no logprobs', async () => {
    const res = await call({ fetch: async () => completion({ A: 1 }, { choices: [{ message: { content: 'A' } }] }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('uncalibrated');
  });

  it('needs a model and an https base URL (http only for localhost)', async () => {
    const noModel = await decide({ apiKey: 'k', endpoint: ENDPOINT, state: 's', questions: QUESTIONS });
    expect(!noModel.ok && noModel.error.kind).toBe('invalid_request');
    expect(resolveDecisionEndpoint({ kind: 'chat', baseURL: 'http://gateway.example.test/v1' }).ok).toBe(false);
    expect(resolveDecisionEndpoint({ kind: 'chat', baseURL: 'http://localhost:4000/v1' }).ok).toBe(true);
  });

  it('refuses a question with more options than one token\'s logprobs cover', async () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CHAT_OPTIONS + 1 }, (_, i) => [`l${i}`, `label ${i}`]));
    const res = await decide({ apiKey: 'k', endpoint: ENDPOINT, model: 'm', state: 's', questions: { q: choice('Which?', many) }, fetch: fakeServer() });
    expect(!res.ok && res.error.kind).toBe('invalid_request');
  });

  it('retries a 5xx inside the deadline and reports a 4xx', async () => {
    let n = 0;
    const flaky = async (url: string, init?: RequestInit) => (++n === 1 ? new Response('busy', { status: 503 }) : fakeServer()(url, init));
    const ok = await decide({ apiKey: 'k', endpoint: ENDPOINT, model: 'm', state: 's', questions: { bug: noul('Bug?') }, sleep: noSleep, fetch: flaky });
    expect(ok.ok).toBe(true);
    const bad = await decide({ apiKey: 'k', endpoint: ENDPOINT, model: 'm', state: 's', questions: { bug: noul('Bug?') }, fetch: async () => new Response('no', { status: 401 }) });
    expect(!bad.ok && bad.error).toMatchObject({ kind: 'provider_error', status: 401 });
  });

  it('asks OpenRouter for cost, and a receipt names the endpoint and who is paid', async () => {
    const receipts: DecisionReceipt[] = [];
    const seen: { url: string; body: any; headers: Headers }[] = [];
    await decide({
      apiKey: 'sk-or', endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1' }, model: 'qwen/qwen3-8b',
      state: 's', questions: { bug: noul('Bug?') }, fetch: fakeServer(seen), onUsage: r => { receipts.push(r); },
    });
    expect(seen[0].body.usage).toEqual({ include: true });
    expect(receipts[0]).toMatchObject({ provider: 'openrouter', endpoint: 'chat' });
    expect(toModelsUsage(receipts[0]).plan.provider).toBe('openrouter');
    await call({ onUsage: (r: DecisionReceipt) => { receipts.push(r); } });
    expect(receipts[1]).toMatchObject({ provider: 'openai', endpoint: 'chat', model: 'qwen3-8b' });
  });
});

describe('chat prompt and parsing', () => {
  it('letters choice labels, score levels (lowest first) and yes/no', () => {
    expect(chatOptions(QUESTIONS.team).map(o => `${o.letter}=${o.key}`)).toEqual(['A=payments', 'B=frontend']);
    expect(chatOptions(score('How bad?', ['minor', 'major', 'outage'])).map(o => o.key)).toEqual(['0', '1', '2']);
    expect(chatOptions(QUESTIONS.bug).map(o => o.key)).toEqual(['yes', 'no']);
    const [, user] = chatMessages({ ticket: 'x' }, QUESTIONS.team);
    expect(user.content).toContain('A. payments: Billing');
    expect(user.content).toContain('Answer with one letter: A, B.');
  });

  it('reads " A", "A." and "(a)" as A and ignores tokens that are not options', () => {
    const body = { choices: [{ logprobs: { content: [{ top_logprobs: [
      { token: ' A', logprob: Math.log(0.3) }, { token: 'A.', logprob: Math.log(0.2) }, { token: '(b)', logprob: Math.log(0.25) }, { token: 'Z', logprob: Math.log(0.25) },
    ] }] } }] };
    const p = probabilitiesFromLogprobs(body, ['A', 'B'])!;
    expect(p.A).toBeCloseTo(0.5 / 0.75, 5);
    expect(p.B).toBeCloseTo(0.25 / 0.75, 5);
  });

  it('a score is the probability-weighted level', async () => {
    const res = await decide({
      apiKey: 'k', endpoint: ENDPOINT, model: 'm', state: 's', questions: { sev: score('How bad?', ['minor', 'major', 'outage']) },
      fetch: async () => completion({ A: 0.2, B: 0.5, C: 0.3 }),
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.answers.sev.score).toBeCloseTo(1.1, 5);
    expect(res.answers.sev.confidence).toBeCloseTo(0.5, 5);
  });
});

describe('defineDecision with a custom model', () => {
  const base = { id: 'test.triage', promptVersion: '2026-09-28.a', questions: QUESTIONS, mode: 'shadow' as const };

  it('leaves the default (Jev) fingerprint unchanged and gives a chat endpoint its own', () => {
    const jev = defineDecision(base);
    const explicit = defineDecision({ ...base, endpoint: { kind: 'systemone' } });
    const chat = defineDecision({ ...base, model: 'qwen3-8b', endpoint: ENDPOINT });
    const otherHost = defineDecision({ ...base, model: 'qwen3-8b', endpoint: { kind: 'chat', baseURL: 'https://other.example.test/v1' } });
    expect(explicit.fingerprint).toBe(jev.fingerprint);
    expect(chat.fingerprint).not.toBe(jev.fingerprint);
    expect(otherHost.fingerprint).toBe(chat.fingerprint);
    expect(chat.version).toContain('|qwen3-8b|');
  });

  it('rejects a chat endpoint with no model at definition time', () => {
    expect(() => defineDecision({ ...base, endpoint: ENDPOINT })).toThrow(/needs a model/);
  });

  it('runs through the chat endpoint', async () => {
    const d = defineDecision({ ...base, model: 'qwen3-8b', endpoint: ENDPOINT });
    const run = await d.run({ apiKey: 'k', state: 's', fetch: fakeServer(), sleep: noSleep });
    expect(run.ok).toBe(true);
    expect(run.receipt).toMatchObject({ endpoint: 'chat', provider: 'openai', decisionId: 'test.triage' });
  });
});

describe('systemone base URL', () => {
  it('sends the System One call to a custom host', async () => {
    let url = '';
    await decide({
      apiKey: 'k', endpoint: { kind: 'systemone', baseURL: 'https://systemone.example.test/api' }, state: 's', questions: { bug: noul('Bug?') },
      fetch: async (u: string) => { url = u; return new Response(JSON.stringify({ answers: { bug: { type: 'noul', noul: 0.8 } } }), { status: 200, headers: { 'content-type': 'application/json' } }); },
    });
    expect(url).toBe('https://systemone.example.test/api/v1/systemone');
  });
});
