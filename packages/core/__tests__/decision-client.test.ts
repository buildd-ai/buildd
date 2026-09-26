import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

/**
 * The decision primitive: typed questions → typed, calibrated answers from a
 * System One model on OpenRouter. Transport is the official `@typesafe-ai/sdk`
 * pointed at OpenRouter; HTTP is mocked underneath it via the SDK's own `fetch`
 * option, so these tests exercise the real SDK. The request shape asserted here
 * is the one in OpenRouter's TypeSafe SDK guide (`POST /api/v1/systemone`, body
 * `{ model, state, questions }`).
 */

let secretRows: any[] = [];
let teamRow: any = { enabledInferenceCapabilities: ['task_category_shadow'] };
let secretsThrows = false;

mock.module('../db', () => ({
  db: {
    query: {
      secrets: {
        findMany: () => (secretsThrows ? Promise.reject(new Error('db down')) : Promise.resolve(secretRows)),
      },
      teams: { findFirst: () => Promise.resolve(teamRow) },
    },
  },
}));

mock.module('../db/schema', () => ({
  teams: { id: 'id', enabledInferenceCapabilities: 'enabled_inference_capabilities' },
  secrets: {
    id: 'id', teamId: 'team_id', accountId: 'account_id', purpose: 'purpose', label: 'label',
    encryptedValue: 'encrypted_value', workspaceId: 'workspace_id',
    healthStatus: 'health_status', updatedAt: 'updated_at',
  },
}));

mock.module('../secrets', () => ({
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));

mock.module('drizzle-orm', () => ({
  and: (...c: any[]) => ({ __and: c }),
  eq: (f: any, v: any) => ({ __eq: [f, v] }),
  or: (...c: any[]) => ({ __or: c }),
  isNull: (f: any) => ({ __isNull: f }),
  sql: (s: any) => ({ __sql: s }),
}));

const {
  decisionCall,
  resolveDecisionKey,
  validateDecisionRequest,
  parseDecisionAnswers,
  gateChoice,
  describeDecisionError,
  DECISIONS_URL,
  DEFAULT_DECISION_MODEL,
  DECISION_KEY_PURPOSE,
  MAX_CHOICE_OPTIONS,
} = await import('../decision-client');

// ── helpers ──────────────────────────────────────────────────────────────────

const QUESTIONS = {
  team: {
    type: 'choice' as const,
    instructions: 'Which team should own this ticket?',
    criteria: { payments: 'Checkout and billing', frontend: 'Rendering and layout' },
  },
  is_bug: { type: 'noul' as const, instructions: 'Is this a software defect?' },
  urgency: {
    type: 'score' as const,
    instructions: 'How urgent?',
    criteria: ['Can wait', 'This week', 'Now'],
  },
};

/** Shape copied from the Decisions API reference's 200 example. */
const OK_BODY = {
  id: 'gen-dec-example',
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  answers: {
    team: { type: 'choice', choice: 'payments', confidence: 0.75, probabilities: { payments: 0.84, frontend: 0.16 } },
    is_bug: { type: 'noul', noul: 0.96 },
    urgency: {
      type: 'score', score: 1.99, confidence: 0.99,
      legend: { '0': 'Can wait', '1': 'This week', '2': 'Now' },
      probabilities: { '0': 0, '1': 0.01, '2': 0.99 },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function secretRow(over: Record<string, unknown> = {}) {
  return {
    id: 's-1', purpose: DECISION_KEY_PURPOSE, label: null, encryptedValue: 'enc:sk-or-team',
    accountId: null, workspaceId: null, healthStatus: 'healthy', updatedAt: new Date('2026-08-01'),
    ...over,
  };
}

const noSleep = () => Promise.resolve();

function params(over: Record<string, unknown> = {}) {
  return {
    capability: 'task_category_shadow' as const,
    teamId: 'team-1',
    state: { ticket: 'Checkout page is blank after I click Pay.' },
    questions: QUESTIONS,
    sleep: noSleep,
    ...over,
  };
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  secretRows = [secretRow()];
  teamRow = { enabledInferenceCapabilities: ['task_category_shadow'] };
  secretsThrows = false;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

// ── request shape ────────────────────────────────────────────────────────────

describe('decisionCall request', () => {
  it('POSTs {model, state, questions} to the Decisions API with a bearer key', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetcher = mock(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse(OK_BODY);
    });

    const res = await decisionCall(params({ fetcher }));
    expect(res.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen!.url).toBe(DECISIONS_URL);
    expect(DECISIONS_URL).toBe('https://openrouter.ai/api/v1/systemone');
    expect(seen!.init.method).toBe('POST');
    const headers = new Headers(seen!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-or-team');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-title')).toBe('buildd');
    // Proves the request went through the SDK, not a hand-rolled fetch.
    expect(headers.get('x-typesafe-sdk')).toBe('typesafe-sdk/0.6.0');

    const body = JSON.parse(seen!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe(DEFAULT_DECISION_MODEL);
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toEqual({ ticket: 'Checkout page is blank after I click Pay.' });
    expect(body.questions.team).toEqual({
      type: 'choice',
      instructions: 'Which team should own this ticket?',
      criteria: { payments: 'Checkout and billing', frontend: 'Rendering and layout' },
    });
    expect(body.questions.urgency.criteria).toEqual(['Can wait', 'This week', 'Now']);
  });

  it('honours a model override (e.g. the ~typesafe/jev-latest alias)', async () => {
    let model = '';
    const fetcher = async (_u: string, init: RequestInit) => {
      model = JSON.parse(init.body as string).model;
      return jsonResponse(OK_BODY);
    };
    await decisionCall(params({ fetcher, model: '~typesafe/jev-latest' }));
    expect(model).toBe('~typesafe/jev-latest');
  });
});

// ── success path ─────────────────────────────────────────────────────────────

describe('decisionCall answers', () => {
  it('returns typed answers, the versioned model, usage and cost', async () => {
    const res = await decisionCall(params({ fetcher: async () => jsonResponse(OK_BODY) }));
    if (!res.ok) throw new Error('expected ok');
    expect(res.answers.team.choice).toBe('payments');
    expect(res.answers.team.confidence).toBe(0.75);
    expect(res.answers.is_bug.noul).toBe(0.96);
    expect(res.answers.urgency.score).toBe(1.99);
    expect(res.model).toBe('typesafe/jev-1.13-20260917');
    expect(res.usage).toEqual({ inputTokens: 476, outputTokens: 70, costUsd: 0.000019992 });
    expect(res.attempts).toBe(1);
  });

  it('reports costUsd null when the provider omits it', async () => {
    const body = { ...OK_BODY, usage: { input_tokens: 10, output_tokens: 0 } };
    const res = await decisionCall(params({ fetcher: async () => jsonResponse(body) }));
    if (!res.ok) throw new Error('expected ok');
    expect(res.usage.costUsd).toBeNull();
  });

  it('rejects a choice outside the label set as a parse error', async () => {
    const body = structuredClone(OK_BODY) as any;
    body.answers.team.choice = 'sales';
    const res = await decisionCall(params({ fetcher: async () => jsonResponse(body) }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('parse');
  });

  it('rejects a missing answer as a parse error', async () => {
    const body = structuredClone(OK_BODY) as any;
    delete body.answers.is_bug;
    const res = await decisionCall(params({ fetcher: async () => jsonResponse(body) }));
    expect(!res.ok && res.error.kind).toBe('parse');
  });
});

// ── gating before spend ──────────────────────────────────────────────────────

describe('decisionCall gating', () => {
  it('does nothing when the capability is not enabled for the team (default)', async () => {
    teamRow = { enabledInferenceCapabilities: null };
    const fetcher = mock(async () => jsonResponse(OK_BODY));
    const res = await decisionCall(params({ fetcher }));
    expect(!res.ok && res.error).toEqual({ kind: 'capability_disabled', capability: 'task_category_shadow' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns missing_key without fetching when no key resolves', async () => {
    secretRows = [];
    const fetcher = mock(async () => jsonResponse(OK_BODY));
    const res = await decisionCall(params({ fetcher }));
    expect(!res.ok && res.error.kind).toBe('missing_key');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an invalid request locally, before any lookup or fetch', async () => {
    const fetcher = mock(async () => jsonResponse(OK_BODY));
    const res = await decisionCall(params({
      fetcher,
      questions: { only: { type: 'choice', instructions: 'Pick', criteria: { a: 'A' } } },
    }));
    expect(!res.ok && res.error.kind).toBe('invalid_request');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips the allowlist and lookup when an explicit apiKey is passed (offline eval)', async () => {
    teamRow = { enabledInferenceCapabilities: null };
    secretRows = [];
    let auth = '';
    const res = await decisionCall(params({
      apiKey: 'sk-or-eval',
      fetcher: async (_u: string, init: RequestInit) => {
        auth = new Headers(init.headers).get('authorization') ?? '';
        return jsonResponse(OK_BODY);
      },
    }));
    expect(res.ok).toBe(true);
    expect(auth).toBe('Bearer sk-or-eval');
  });
});

// ── retries and deadlines ────────────────────────────────────────────────────

describe('decisionCall retry contract', () => {
  it('retries once on 529 overload, then succeeds', async () => {
    let n = 0;
    const res = await decisionCall(params({
      fetcher: async () => (++n === 1 ? jsonResponse({ error: { code: 529 } }, 529) : jsonResponse(OK_BODY)),
    }));
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it('retries once on 429 and then reports rate_limited with retry-after', async () => {
    const fetcher = mock(async () => jsonResponse({ error: { code: 429 } }, 429, { 'retry-after': '3' }));
    const res = await decisionCall(params({ fetcher }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(!res.ok && res.error).toEqual({ kind: 'rate_limited', retryAfter: 3 });
  });

  it('never retries a 4xx other than 429 (bad request, auth, payment)', async () => {
    for (const status of [400, 401, 402, 413]) {
      const fetcher = mock(async () => jsonResponse({ error: { code: status } }, status));
      const res = await decisionCall(params({ fetcher }));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(!res.ok && res.error.kind).toBe('provider_error');
    }
  });

  it('retries a network failure once, then reports transport', async () => {
    const fetcher = mock(async () => { throw new TypeError('fetch failed'); });
    const res = await decisionCall(params({ fetcher }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(!res.ok && res.error.kind).toBe('transport');
  });

  it('maps an aborted fetch to timeout and does not retry it', async () => {
    const fetcher = mock(async () => {
      const e = new Error('The operation timed out.');
      e.name = 'TimeoutError';
      throw e;
    });
    const res = await decisionCall(params({ fetcher, timeoutMs: 100 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(!res.ok && res.error).toEqual({ kind: 'timeout', timeoutMs: 100 });
  });

  it('does not start a retry once the deadline is nearly spent', async () => {
    let t = 0;
    const fetcher = mock(async () => { t += 4_800; return jsonResponse({}, 503); });
    const res = await decisionCall(params({ fetcher, now: () => t, timeoutMs: 5_000 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(!res.ok && res.error.kind).toBe('provider_error');
  });

  it('enforces the deadline on a hung request: one attempt, reported as timeout', async () => {
    const fetcher = mock((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
    }));
    const t0 = Date.now();
    const res = await decisionCall(params({ fetcher, timeoutMs: 80 }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(!res.ok && res.error).toEqual({ kind: 'timeout', timeoutMs: 80 });
  });

  it('never lets the SDK retry on its own (retries are ours, bounded to one)', async () => {
    const fetcher = mock(async () => jsonResponse({ error: { code: 503 } }, 503));
    const res = await decisionCall(params({ fetcher }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(!res.ok && res.error).toMatchObject({ kind: 'provider_error', status: 503 });
  });

  it('passes an abort signal bounded by the remaining deadline', async () => {
    let signal: AbortSignal | undefined;
    await decisionCall(params({
      fetcher: async (_u: string, init: RequestInit) => { signal = init.signal ?? undefined; return jsonResponse(OK_BODY); },
    }));
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

// ── SDK configuration ────────────────────────────────────────────────────────

describe('decisionCall SDK configuration', () => {
  const ENV_KEYS = ['TYPESAFE_BASE_URL', 'TYPESAFE_API_KEY', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_LOG_LEVEL'];
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

  it('ignores TYPESAFE_* env vars: a stray env var cannot redirect the key or dump bodies', async () => {
    process.env.TYPESAFE_BASE_URL = 'https://attacker.example';
    process.env.TYPESAFE_API_KEY = 'sk-wrong';
    process.env.TYPESAFE_DEFAULT_MODEL = 'jev-latest';
    process.env.TYPESAFE_LOG_LEVEL = 'debug';
    const debug = mock(() => {});
    const origDebug = console.debug;
    console.debug = debug;
    try {
      let seen: { url: string; init: RequestInit } | null = null;
      const res = await decisionCall(params({
        fetcher: async (url: string, init: RequestInit) => { seen = { url, init }; return jsonResponse(OK_BODY); },
      }));
      expect(res.ok).toBe(true);
      expect(seen!.url).toBe(DECISIONS_URL);
      expect(new Headers(seen!.init.headers).get('authorization')).toBe('Bearer sk-or-team');
      expect(JSON.parse(seen!.init.body as string).model).toBe(DEFAULT_DECISION_MODEL);
      expect(debug).not.toHaveBeenCalled();
    } finally {
      console.debug = origDebug;
    }
  });

  it('reports a non-JSON 200 body as a parse error', async () => {
    const res = await decisionCall(params({
      fetcher: async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    }));
    expect(!res.ok && res.error).toEqual({ kind: 'parse', message: 'response was not JSON' });
  });

  it('keeps the provider error body (truncated) on a non-retryable status', async () => {
    const res = await decisionCall(params({
      fetcher: async () => jsonResponse({ error: { message: 'Insufficient credits' } }, 402),
    }));
    if (res.ok) throw new Error('expected failure');
    expect(res.error.kind).toBe('provider_error');
    if (res.error.kind !== 'provider_error') return;
    expect(res.error.status).toBe(402);
    expect(res.error.body).toContain('Insufficient credits');
  });
});

// ── key resolution ───────────────────────────────────────────────────────────

describe('resolveDecisionKey', () => {
  it('prefers the acting user\'s account key over workspace over team', async () => {
    secretRows = [
      secretRow({ id: 'team', encryptedValue: 'enc:team' }),
      secretRow({ id: 'ws', workspaceId: 'ws-1', encryptedValue: 'enc:ws' }),
      secretRow({ id: 'acct', accountId: 'acct-1', encryptedValue: 'enc:acct' }),
    ];
    expect(await resolveDecisionKey({ teamId: 'team-1', workspaceId: 'ws-1', accountId: 'acct-1' })).toBe('acct');
    expect(await resolveDecisionKey({ teamId: 'team-1', workspaceId: 'ws-1' })).toBe('ws');
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBe('team');
  });

  it('never uses another account\'s or another workspace\'s key', async () => {
    secretRows = [
      secretRow({ accountId: 'someone-else', encryptedValue: 'enc:other-acct' }),
      secretRow({ workspaceId: 'other-ws', encryptedValue: 'enc:other-ws' }),
    ];
    expect(await resolveDecisionKey({ teamId: 'team-1', workspaceId: 'ws-1', accountId: 'acct-1' })).toBeNull();
  });

  it('accepts an inference_key labelled openrouter, but not one for another provider', async () => {
    secretRows = [secretRow({ purpose: 'inference_key', label: 'OpenRouter', encryptedValue: 'enc:inf-or' })];
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBe('inf-or');
    secretRows = [secretRow({ purpose: 'inference_key', label: 'anthropic', encryptedValue: 'enc:sk-ant' })];
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBeNull();
  });

  it('prefers decision_key over inference_key at the same scope', async () => {
    secretRows = [
      secretRow({ purpose: 'inference_key', label: 'openrouter', encryptedValue: 'enc:inf' }),
      secretRow({ encryptedValue: 'enc:dec' }),
    ];
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBe('dec');
  });

  it('resolves through the shared resolver: a personal OpenRouter inference key serves decisions', async () => {
    // One OpenRouter key serves chat and decisions. A user's own key (set for
    // chat) is spent for that user's decisions; nobody else's.
    secretRows = [
      secretRow({ id: 'team', encryptedValue: 'enc:team-dec' }),
      secretRow({ id: 'mine', purpose: 'inference_key', label: 'openrouter', userId: 'u-1', encryptedValue: 'enc:mine' }),
    ];
    expect(await resolveDecisionKey({ teamId: 'team-1', userId: 'u-1' })).toBe('mine');
    expect(await resolveDecisionKey({ teamId: 'team-1', userId: 'u-2' })).toBe('team-dec');
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBe('team-dec');
  });

  it('never reads a non-OpenRouter purpose even if the query returns one', async () => {
    secretRows = [secretRow({ purpose: 'anthropic_api_key', encryptedValue: 'enc:sk-ant' })];
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBeNull();
  });

  it('uses OPENROUTER_API_KEY outside production only', async () => {
    secretRows = [];
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    process.env.NODE_ENV = 'development';
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBe('sk-or-env');
    process.env.NODE_ENV = 'production';
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBeNull();
  });

  it('survives a failed lookup', async () => {
    secretsThrows = true;
    process.env.NODE_ENV = 'production';
    expect(await resolveDecisionKey({ teamId: 'team-1' })).toBeNull();
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('validateDecisionRequest', () => {
  it('accepts the documented shapes', () => {
    expect(validateDecisionRequest('text', QUESTIONS)).toBeNull();
  });

  it('enforces label and level bounds', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`l${i}`, null]));
    expect(validateDecisionRequest('x', { q: { type: 'choice', instructions: 'i', criteria: many } })).toMatch(/max 255/);
    expect(validateDecisionRequest('x', { q: { type: 'score', instructions: 'i', criteria: ['one'] } })).toMatch(/2-10/);
    expect(validateDecisionRequest('x', {
      q: { type: 'score', instructions: 'i', criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) },
    })).toMatch(/2-10/);
  });

  it('refuses empty state, no questions, and oversized state', () => {
    expect(validateDecisionRequest('', QUESTIONS)).toMatch(/empty/);
    expect(validateDecisionRequest('x', {})).toMatch(/at least one/);
    expect(validateDecisionRequest('x'.repeat(200_000), QUESTIONS)).toMatch(/exceeds/);
  });
});

describe('parseDecisionAnswers', () => {
  it('drops answers for questions the caller did not ask', () => {
    const raw = { ...OK_BODY.answers, extra: { type: 'noul', noul: 1 } };
    const r = parseDecisionAnswers(QUESTIONS, raw);
    expect(r.ok && Object.keys(r.answers).sort()).toEqual(['is_bug', 'team', 'urgency']);
  });

  it('rejects a type mismatch', () => {
    const raw = { ...OK_BODY.answers, is_bug: { type: 'choice', choice: 'x' } };
    expect(parseDecisionAnswers(QUESTIONS, raw).ok).toBe(false);
  });
});

describe('gateChoice', () => {
  const answer = { type: 'choice' as const, choice: 'bug' as const, probabilities: { bug: 0.9 }, confidence: 0.85 };

  it('applies at or above the threshold', () => {
    expect(gateChoice(answer, 0.85)).toEqual({ apply: true, label: 'bug', confidence: 0.85 });
  });

  it('falls back below it, keeping the label for logging', () => {
    expect(gateChoice(answer, 0.9)).toEqual({ apply: false, reason: 'low_confidence', label: 'bug', confidence: 0.85 });
  });

  it('falls back on no answer', () => {
    expect(gateChoice(null, 0.5)).toEqual({ apply: false, reason: 'no_answer' });
  });
});

describe('describeDecisionError', () => {
  it('has a message for every kind', () => {
    const kinds = [
      { kind: 'capability_disabled', capability: 'task_category_shadow' },
      { kind: 'missing_key' },
      { kind: 'invalid_request', message: 'm' },
      { kind: 'timeout', timeoutMs: 1 },
      { kind: 'transport', message: 'm' },
      { kind: 'rate_limited' },
      { kind: 'provider_error', status: 500, body: '' },
      { kind: 'parse', message: 'm' },
    ] as const;
    for (const k of kinds) expect(describeDecisionError(k as any).length).toBeGreaterThan(0);
  });
});
