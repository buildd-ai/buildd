import { describe, expect, it } from 'bun:test';
import {
  choice, decide, defaultDecisionModel, defineDecision, noul, resolveDecisionEndpoint, toModelsUsage,
  CLEF_MODEL, JEV_MODEL, type DecisionReceipt,
} from './index';
import { clefModelIds, isClefModel } from './workers-ai-transport';

const noSleep = () => Promise.resolve();
const QUESTIONS = { team: choice('Which team?', { payments: 'Billing', frontend: 'Layout' }), urgent: noul('Is it urgent?') };
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const GATEWAY_ROOT = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/buildd/workers-ai`;
const ENDPOINT = { kind: 'workers-ai' as const, baseURL: GATEWAY_ROOT, headers: { 'cf-aig-authorization': 'Bearer cf-gw' } };

const ANSWERS = {
  team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.81, frontend: 0.19 }, confidence: 0.81 },
  urgent: { type: 'noul', noul: 0.93 },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The Cloudflare REST envelope around a Clef answer. */
const enveloped = (over: Record<string, unknown> = {}) =>
  json({ success: true, errors: [], messages: [], result: { model: 'clef', answers: ANSWERS, usage: { input_tokens: 310 }, ...over } });

const call = (over: Record<string, unknown> = {}) =>
  decide({ apiKey: 'cf-token', endpoint: ENDPOINT, state: 'Checkout is failing for everyone', questions: QUESTIONS, sleep: noSleep, fetch: async () => enveloped(), ...over });

describe('Clef model ids', () => {
  it('accepts the bare, cloudflare/ and @cf/ forms of clef and clef-flash', () => {
    for (const m of ['clef', 'clef-flash', 'cloudflare/clef', '@cf/cloudflare/clef-flash']) expect(isClefModel(m)).toBe(true);
    for (const m of ['typesafe/jev-1.13', 'clefs', '@cf/meta/llama-3', '', null]) expect(isClefModel(m)).toBe(false);
  });

  it('splits an id into the body model and the Workers AI path', () => {
    expect(clefModelIds('@cf/cloudflare/clef-flash')).toEqual({ body: 'clef-flash', path: '@cf/cloudflare/clef-flash' });
    expect(clefModelIds('clef')).toEqual({ body: 'clef', path: '@cf/cloudflare/clef' });
    expect(clefModelIds('qwen3')).toBeNull();
  });

  it('defaults a workers-ai endpoint to Clef and systemone to Jev', () => {
    expect(defaultDecisionModel('workers-ai')).toBe(CLEF_MODEL);
    expect(defaultDecisionModel(undefined)).toBe(JEV_MODEL);
    expect(defaultDecisionModel('chat')).toBe('');
  });
});

describe('workers-ai endpoint', () => {
  it('posts the System One body to the model path with the Cloudflare token and gateway header', async () => {
    const seen: { url: string; body: any; headers: Headers }[] = [];
    const res = await call({
      model: 'clef-flash',
      headers: { 'x-title': 'buildd' },
      fetch: async (url: string, init?: RequestInit) => {
        seen.push({ url, body: JSON.parse(init!.body as string), headers: new Headers(init!.headers) });
        return enveloped({ model: 'clef-flash' });
      },
    });
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${GATEWAY_ROOT}/@cf/cloudflare/clef-flash`);
    expect(seen[0].body).toEqual({ model: 'clef-flash', state: 'Checkout is failing for everyone', questions: QUESTIONS });
    expect(seen[0].headers.get('authorization')).toBe('Bearer cf-token');
    expect(seen[0].headers.get('cf-aig-authorization')).toBe('Bearer cf-gw');
    expect(seen[0].headers.get('x-title')).toBe('buildd');
  });

  it('unwraps the REST envelope into Jev-shaped answers', async () => {
    const res = await call();
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.answers.team.choice).toBe('payments');
    expect(res.answers.urgent.noul).toBe(0.93);
    expect(res.model).toBe('clef');
    expect(res.usage).toEqual({ inputTokens: 310, outputTokens: 0, costUsd: null });
  });

  it('also reads an unwrapped body', async () => {
    const res = await call({ fetch: async () => json({ model: 'clef', answers: ANSWERS }) });
    expect(res.ok).toBe(true);
  });

  it('turns success: false into a parse error carrying Cloudflare\'s message', async () => {
    const res = await call({ fetch: async () => json({ success: false, errors: [{ code: 5006, message: 'bad questions' }], result: null }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ kind: 'parse', message: 'bad questions' });
  });

  it('refuses an answer outside the label set', async () => {
    const bad = { ...ANSWERS, team: { ...ANSWERS.team, choice: 'sales' } };
    const res = await call({ fetch: async () => enveloped({ answers: bad }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('parse');
  });

  it('retries a 5xx once, and not a 4xx', async () => {
    let n = 0;
    const flaky = await call({ fetch: async () => (++n === 1 ? json({}, 503) : enveloped()) });
    expect(flaky.ok).toBe(true);
    expect(flaky.attempts).toBe(2);

    let m = 0;
    const denied = await call({ fetch: async () => { m++; return json({ errors: [{ message: 'no' }] }, 403); } });
    expect(denied.ok).toBe(false);
    expect(m).toBe(1);
    if (!denied.ok) expect(denied.error).toMatchObject({ kind: 'provider_error', status: 403 });
  });

  it('refuses a non-Clef model before any request', async () => {
    let called = false;
    const res = await call({ model: 'typesafe/jev-1.13', fetch: async () => { called = true; return enveloped(); } });
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('invalid_request');
  });

  it('needs a baseURL and a key', async () => {
    expect(resolveDecisionEndpoint({ kind: 'workers-ai', baseURL: '' })).toEqual({ ok: false, message: 'a workers-ai endpoint needs a baseURL' });
    const res = await call({ apiKey: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('missing_key');
  });

  it('receipts name cloudflare and the workers-ai endpoint', async () => {
    const receipts: DecisionReceipt[] = [];
    await call({ onUsage: (r: DecisionReceipt) => { receipts.push(r); } });
    await Promise.resolve();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ provider: 'cloudflare', endpoint: 'workers-ai', model: 'clef', outcome: 'ok' });
    expect(() => toModelsUsage(receipts[0])).toThrow(/cloudflare/);
  });
});

describe('Jev through an AI Gateway', () => {
  it('sends systemone endpoint headers with the request', () => {
    const ep = resolveDecisionEndpoint({ kind: 'systemone', baseURL: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/buildd/openrouter`, headers: { 'cf-aig-authorization': 'Bearer cf-gw' } });
    expect(ep).toMatchObject({ ok: true, kind: 'systemone', provider: 'openrouter', headers: { 'cf-aig-authorization': 'Bearer cf-gw' } });
  });
});

describe('defineDecision on Clef', () => {
  it('defaults to Clef, versions on it, and fingerprints apart from Jev', () => {
    const base = { id: 'test.triage', promptVersion: '2026-10-09.a', questions: QUESTIONS, mode: 'shadow' as const };
    const clef = defineDecision({ ...base, endpoint: { kind: 'workers-ai', baseURL: GATEWAY_ROOT } });
    const jev = defineDecision(base);
    expect(clef.version).toContain('|clef|');
    expect(clef.fingerprint).not.toBe(jev.fingerprint);
  });
});
