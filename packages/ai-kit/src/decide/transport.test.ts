import { afterEach, describe, expect, it, mock } from 'bun:test';
import { choice, decide, DECIDE_URL, JEV_MODEL, noul, type DecisionReceipt } from './index';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A 200 body in the Decisions API's shape. */
function okBody(answers: Record<string, unknown>, cost: number | undefined = 0.00002) {
  return {
    model: 'typesafe/jev-1.13-20260917',
    answers,
    usage: { input_tokens: 400, output_tokens: 50, ...(cost === undefined ? {} : { cost }) },
  };
}

const noSleep = () => Promise.resolve();

const QUESTIONS = { team: choice('Which team?', { payments: 'Billing', frontend: 'Layout' }), bug: noul('Is it a bug?') };
const ANSWERS = {
  team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.84, frontend: 0.16 }, confidence: 0.75 },
  bug: { type: 'noul', noul: 0.96 },
};
const OK = okBody(ANSWERS);

const call = (over: Record<string, unknown> = {}) =>
  decide({ apiKey: 'sk-or-test', state: { ticket: 'Checkout is blank' }, questions: QUESTIONS, sleep: noSleep, ...over });

describe('decide request', () => {
  it('POSTs {model, state, questions} through the SDK to OpenRouter with the caller key', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const res = await call({
      headers: { 'x-title': 'money' },
      fetch: async (url: string, init: RequestInit) => { seen = { url, init }; return jsonResponse(OK); },
    });
    expect(res.ok).toBe(true);
    expect(seen!.url).toBe(DECIDE_URL);
    expect(DECIDE_URL).toBe('https://openrouter.ai/api/v1/systemone');
    const headers = new Headers(seen!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-or-test');
    expect(headers.get('x-title')).toBe('money');
    expect(headers.get('x-typesafe-sdk')).toMatch(/^typesafe-sdk\//);
    const body = JSON.parse(seen!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe(JEV_MODEL);
  });

  it('pins a versioned Jev id, never the latest alias', () => {
    expect(JEV_MODEL).toMatch(/^typesafe\/jev-\d+\.\d+$/);
  });

  it('returns typed answers, the versioned model, usage and cost', async () => {
    const res = await call({ fetch: async () => jsonResponse(OK) });
    if (!res.ok) throw new Error('expected ok');
    expect(res.answers.team.choice).toBe('payments');
    expect(res.answers.bug.noul).toBe(0.96);
    expect(res.model).toBe('typesafe/jev-1.13-20260917');
    expect(res.usage).toEqual({ inputTokens: 400, outputTokens: 50, costUsd: 0.00002 });
  });

  it('refuses a missing key and an invalid request without fetching', async () => {
    const fetch = mock(async () => jsonResponse(OK));
    expect(await call({ apiKey: '', fetch })).toMatchObject({ ok: false, error: { kind: 'missing_key' }, attempts: 0 });
    expect(await call({ state: '', fetch })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores TYPESAFE_* env vars', async () => {
    process.env.TYPESAFE_BASE_URL = 'https://attacker.example';
    process.env.TYPESAFE_API_KEY = 'sk-wrong';
    try {
      let url = '';
      let auth = '';
      await call({ fetch: async (u: string, init: RequestInit = {}) => { url = u; auth = new Headers(init.headers).get('authorization')!; return jsonResponse(OK); } });
      expect(url).toBe(DECIDE_URL);
      expect(auth).toBe('Bearer sk-or-test');
    } finally {
      delete process.env.TYPESAFE_BASE_URL;
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  it('reports a label outside the set as parse', async () => {
    const body = okBody({ ...ANSWERS, team: { ...ANSWERS.team, choice: 'sales' } });
    expect(await call({ fetch: async () => jsonResponse(body) })).toMatchObject({ ok: false, error: { kind: 'parse' } });
  });
});

describe('decide retries', () => {
  for (const status of [408, 429, 500, 503, 524, 529]) {
    it(`retries ${status} once by default, then succeeds`, async () => {
      let n = 0;
      const res = await call({ fetch: async () => (++n === 1 ? jsonResponse({}, status) : jsonResponse(OK)) });
      expect(res.ok).toBe(true);
      expect(res.attempts).toBe(2);
    });
  }

  it('never retries other 4xx (bad request, auth, out of credit, too large)', async () => {
    for (const status of [400, 401, 402, 413]) {
      const fetch = mock(async () => jsonResponse({ error: { message: 'nope' } }, status));
      const res = await call({ fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ ok: false, error: { kind: 'provider_error', status } });
    }
  });

  it('reports rate_limited with retry-after after the last attempt', async () => {
    const fetch = mock(async () => jsonResponse({}, 429, { 'retry-after': '3' }));
    const res = await call({ fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(!res.ok && res.error).toEqual({ kind: 'rate_limited', retryAfter: 3 });
  });

  it('honours maxAttempts and a custom retry rule', async () => {
    const three = mock(async () => jsonResponse({}, 503));
    await call({ fetch: three, maxAttempts: 3 });
    expect(three).toHaveBeenCalledTimes(3);
    const legacy = mock(async () => jsonResponse({}, 408));
    await call({ fetch: legacy, retryable: (s: number) => s === 429 || s >= 500 });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure, then reports transport', async () => {
    const fetch = mock(async () => { throw new TypeError('fetch failed'); });
    const res = await call({ fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(!res.ok && res.error.kind).toBe('transport');
  });

  it('backs off exponentially between attempts', async () => {
    const waits: number[] = [];
    await call({ fetch: async () => jsonResponse({}, 503), maxAttempts: 3, sleep: async (ms: number) => { waits.push(ms); } });
    expect(waits).toEqual([250, 500]);
  });
});

describe('decide time budget', () => {
  it('bounds a hung request by the deadline: one attempt, timeout', async () => {
    const fetch = mock((_u: string, init: RequestInit = {}) => new Promise<Response>((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
    }));
    const t0 = Date.now();
    const res = await call({ fetch, timeoutMs: 80 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(!res.ok && res.error).toEqual({ kind: 'timeout', timeoutMs: 80 });
  });

  it('does not start a retry once the deadline is nearly spent', async () => {
    let t = 0;
    const fetch = mock(async () => { t += 4_800; return jsonResponse({}, 503); });
    const res = await call({ fetch, now: () => t, timeoutMs: 5_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(!res.ok && res.error.kind).toBe('provider_error');
  });

  it('counts the deadline from startedAt', async () => {
    const fetch = mock(async () => jsonResponse(OK));
    const res = await call({ fetch, now: () => 6_000, startedAt: 0, timeoutMs: 5_000 });
    expect(fetch).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, error: { kind: 'timeout' }, latencyMs: 6_000 });
  });

  it('retries an attempt that hit its per-attempt cap while deadline remains', async () => {
    let n = 0;
    const fetch = mock((_u: string, init: RequestInit = {}) => {
      if (++n === 2) return Promise.resolve(jsonResponse(OK));
      return new Promise<Response>((_r, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
      });
    });
    const res = await call({ fetch, timeoutMs: 3_000, attemptTimeoutMs: 50, minRetryBudgetMs: 100 });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
  });
});

describe('decide receipts', () => {
  afterEach(() => {});

  it('emits one content-free receipt per call that reached the network', async () => {
    const receipts: DecisionReceipt[] = [];
    await call({ fetch: async () => jsonResponse(OK), onUsage: (r: DecisionReceipt) => { receipts.push(r); }, decisionId: 'app.triage' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: 'decision', decisionId: 'app.triage', provider: 'openrouter', model: 'typesafe/jev-1.13-20260917',
      usage: { inputTokens: 400, outputTokens: 50, costUsd: 0.00002 }, outcome: 'ok', attempts: 1,
    });
    expect(JSON.stringify(receipts[0])).not.toContain('Checkout');
    expect(JSON.stringify(receipts[0])).not.toContain('payments');
  });

  it('emits an error receipt on failure, none when nothing was sent, and survives a throwing sink', async () => {
    const receipts: DecisionReceipt[] = [];
    await call({ fetch: async () => jsonResponse({}, 400), onUsage: (r: DecisionReceipt) => { receipts.push(r); } });
    await call({ apiKey: '', onUsage: (r: DecisionReceipt) => { receipts.push(r); } });
    expect(receipts.map(r => r.outcome)).toEqual(['error']);
    const res = await call({ fetch: async () => jsonResponse(OK), onUsage: () => { throw new Error('sink down'); } });
    expect(res.ok).toBe(true);
    const res2 = await call({ fetch: async () => jsonResponse(OK), onUsage: () => Promise.reject(new Error('sink down')) });
    expect(res2.ok).toBe(true);
  });
});
