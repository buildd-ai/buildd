import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  envelopeProblem,
  MAX_INLINE_PAYLOAD_BYTES,
  parseKeyRing,
  retryDelayMs,
  signingKey,
  signRequest,
  verifyRequest,
  type DispatchEnvelope,
} from './index';

const base: DispatchEnvelope = {
  id: 'd1',
  kind: 'work_execution',
  source: { system: 'buildd', scope: 'workspace:w1', subject: 'task:t1' },
  target: { steps: [{ target: 'buildd:ws:w1:runner-wake', mode: 'first' }] },
  attempt: 0,
};

describe('envelopeProblem', () => {
  test('accepts a minimal envelope', () => {
    expect(envelopeProblem(base)).toBeNull();
  });

  test.each([
    ['id', { ...base, id: '' }],
    ['kind', { ...base, kind: 'jira_ticket' }],
    ['source', { ...base, source: { system: 'buildd' } }],
    ['target.steps', { ...base, target: { steps: [] } }],
    ['target.steps[].mode', { ...base, target: { steps: [{ target: 'x', mode: 'maybe' }] } }],
    ['target.steps needs a first step', { ...base, target: { steps: [{ target: 'x', mode: 'also' }] } }],
    ['notBefore', { ...base, notBefore: 'tomorrow-ish' }],
    ['attempt', { ...base, attempt: -1 }],
    ['labels', { ...base, labels: { cause: 'x', causes: [1] } }],
  ])('rejects bad %s', (why, e) => {
    expect(envelopeProblem(e)).toBe(why);
  });

  test('caps the inline payload', () => {
    const big = { blob: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES) };
    expect(envelopeProblem({ ...base, payload: big })).toBe('payload too large');
    expect(envelopeProblem({ ...base, payload: { taskId: 't1' } })).toBeNull();
  });
});

describe('signing', () => {
  const ring = { k1: 'secret-one', k2: 'secret-two' };
  const req = { method: 'POST', path: '/v1/envelopes', body: '{"envelopes":[]}' };
  const now = 1_800_000_000;

  async function headersFor(keyId: string, secret: string, over: Partial<typeof req> = {}, signedAt = now) {
    const h = await signRequest({ keyId, secret, ...req, ...over, now: signedAt });
    return new Headers(h);
  }

  test('round-trips, with either active key', async () => {
    for (const [id, secret] of Object.entries(ring)) {
      const r = await verifyRequest({ keys: ring, ...req, headers: await headersFor(id, secret), now });
      expect(r).toEqual({ ok: true, keyId: id });
    }
  });

  test('rejects a tampered body, path or method', async () => {
    const headers = await headersFor('k1', ring.k1);
    for (const over of [{ body: '{"envelopes":[1]}' }, { path: '/v1/other' }, { method: 'PUT' }]) {
      const r = await verifyRequest({ keys: ring, ...req, ...over, headers, now });
      expect(r).toEqual({ ok: false, why: 'bad_signature' });
    }
  });

  test('rejects outside the skew window, accepts inside it', async () => {
    const headers = await headersFor('k1', ring.k1);
    expect((await verifyRequest({ keys: ring, ...req, headers, now: now + 301 })).ok).toBe(false);
    expect((await verifyRequest({ keys: ring, ...req, headers, now: now - 301 })).ok).toBe(false);
    expect((await verifyRequest({ keys: ring, ...req, headers, now: now + 299 })).ok).toBe(true);
  });

  test('rejects unknown keys, a wrong secret, missing headers and an empty ring', async () => {
    expect(await verifyRequest({ keys: ring, ...req, headers: await headersFor('k9', 'x'), now })).toEqual({ ok: false, why: 'unknown_key' });
    expect(await verifyRequest({ keys: ring, ...req, headers: await headersFor('k1', 'wrong'), now })).toEqual({ ok: false, why: 'bad_signature' });
    expect(await verifyRequest({ keys: ring, ...req, headers: new Headers(), now })).toEqual({ ok: false, why: 'missing' });
    expect((await verifyRequest({ keys: {}, ...req, headers: await headersFor('k1', ring.k1), now })).ok).toBe(false);
  });

  test('does not resolve key ids through the prototype', async () => {
    const r = await verifyRequest({ keys: ring, ...req, headers: await headersFor('toString', 'x'), now });
    expect(r).toEqual({ ok: false, why: 'unknown_key' });
  });

  test('parseKeyRing', () => {
    expect(parseKeyRing('k2:new, k1:old')).toEqual({ k2: 'new', k1: 'old' });
    expect(parseKeyRing('bare')).toEqual({ k1: 'bare' });
    expect(parseKeyRing('')).toEqual({});
    expect(parseKeyRing(undefined)).toEqual({});
    expect(parseKeyRing(':nokey,nosecret:')).toEqual({});
    expect(signingKey(parseKeyRing('k2:new,k1:old'))).toEqual({ keyId: 'k2', secret: 'new' });
    expect(signingKey({})).toBeNull();
  });
});

describe('retryDelayMs', () => {
  test('15 s doubling, capped at 30 min', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(retryDelayMs(0)).toBe(15_000);
    expect(retryDelayMs(20)).toBe(30 * 60_000);
  });
});

test('the contract imports nothing but itself', () => {
  const dir = import.meta.dir;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect({ f, bad: imports.filter(i => !i!.startsWith('./')) }).toEqual({ f, bad: [] });
  }
});
