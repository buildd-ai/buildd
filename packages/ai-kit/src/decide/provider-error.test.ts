import { describe, expect, it } from 'bun:test';
import {
  choice, decide, decisionReceiptError, providerErrorExcerpt, redactSecrets,
  PROVIDER_ERROR_EXCERPT_CHARS, type DecisionReceipt,
} from './index';
import { normalizeDecisionFailure } from './policy';

// Synthetic fixtures: a made-up account and token, never a real one.
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'synthetic-cf-token-0000000000000000';
const ENDPOINT = {
  kind: 'workers-ai' as const,
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`,
};
const QUESTIONS = { team: choice('Which team?', { payments: 'Billing', frontend: 'Layout' }) };
const CF_AUTH_ERROR = { success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('provider error excerpts', () => {
  it('redacts the given secrets and any bearer value', () => {
    const text = `token ${TOKEN} rejected; Authorization: Bearer abc.def-123 sent`;
    const out = redactSecrets(text, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('abc.def-123');
    expect(out).toContain('[redacted]');
  });

  it('keeps the status and the first 200 characters, whitespace folded', () => {
    const long = `{"errors":[{"message":"${'x'.repeat(400)}"}]}`;
    const ex = providerErrorExcerpt(401, long);
    expect(ex.startsWith('HTTP 401: ')).toBe(true);
    expect(ex.length).toBe('HTTP 401: '.length + PROVIDER_ERROR_EXCERPT_CHARS);
    expect(providerErrorExcerpt(500, '  a \n\n b  ')).toBe('HTTP 500: a b');
    expect(providerErrorExcerpt(502, '')).toBe('HTTP 502');
  });

  it('summarises a provider_error with status and body, and any other error by kind', () => {
    expect(decisionReceiptError({ kind: 'provider_error', status: 401, body: JSON.stringify(CF_AUTH_ERROR) })).toEqual({
      kind: 'provider_error', status: 401, body: JSON.stringify(CF_AUTH_ERROR),
    });
    expect(decisionReceiptError({ kind: 'timeout', timeoutMs: 5000 })).toEqual({ kind: 'timeout' });
  });
});

describe('decide on a provider rejection', () => {
  it('puts the status and the redacted body on the receipt, never the token', async () => {
    const receipts: DecisionReceipt[] = [];
    const res = await decide({
      apiKey: TOKEN,
      endpoint: { ...ENDPOINT, headers: { 'cf-aig-authorization': `Bearer ${TOKEN}` } },
      state: 'Checkout is failing',
      questions: QUESTIONS,
      sleep: () => Promise.resolve(),
      // A provider that echoes the token back, the worst case.
      fetch: async () => json({ ...CF_AUTH_ERROR, echo: TOKEN }, 401),
      onUsage: r => { receipts.push(r); },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_error');
    const body = (res.error as { body: string }).body;
    expect(body).toContain('Authentication error');
    expect(body).not.toContain(TOKEN);

    await Promise.resolve();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe('error');
    expect(receipts[0].error?.kind).toBe('provider_error');
    expect(receipts[0].error?.status).toBe(401);
    expect(receipts[0].error?.body).toContain('Authentication error');
    expect(receipts[0].error?.body).not.toContain(TOKEN);
    expect((receipts[0].error?.body ?? '').length).toBeLessThanOrEqual(PROVIDER_ERROR_EXCERPT_CHARS);
  });

  it('carries no error on a successful receipt', async () => {
    const receipts: DecisionReceipt[] = [];
    await decide({
      apiKey: TOKEN, endpoint: ENDPOINT, state: 's', questions: QUESTIONS, sleep: () => Promise.resolve(),
      fetch: async () => json({ success: true, errors: [], messages: [], result: { model: 'clef', answers: { team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.9, frontend: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 10 } } }),
      onUsage: r => { receipts.push(r); },
    });
    expect(receipts[0].outcome).toBe('ok');
    expect(receipts[0].error).toBeUndefined();
  });

  it('keeps the excerpt on the normalized failure a decision kind records', () => {
    const f = normalizeDecisionFailure({ kind: 'provider_error', status: 401, body: JSON.stringify(CF_AUTH_ERROR) });
    expect(f.body).toContain('Authentication error');
    expect(f.status).toBe(401);
  });
});
