import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB / secrets-provider mocks ───────────────────────────────────────────────
// getAllPublicKeys() runs a real SQL predicate, so the mock interprets the
// drizzle condition tree instead of hardcoding a row list. That way the test
// exercises the predicate rather than mocking it away.

type KeyRow = {
  id: string;
  label: string | null;
  tokenExpiresAt: Date | null;
  createdAt: Date;
};

let keyRows: KeyRow[] = [];
// Fake key material — not a real keypair, just enough shape to round-trip.
const fakeStoredKeypair = (id: string) => JSON.stringify({
  privateKeyJwk: { kty: 'EC', crv: 'P-256', d: `FAKE-d-${id}`, x: `FAKE-x-${id}`, y: `FAKE-y-${id}` },
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: `FAKE-x-${id}`, y: `FAKE-y-${id}`, use: 'sig', alg: 'ES256' },
});

type Cond = { type: string; field?: string; value?: unknown; conditions?: Cond[] };

function matches(cond: Cond | undefined, row: Record<string, unknown>): boolean {
  if (!cond) return true;
  switch (cond.type) {
    case 'and': return (cond.conditions ?? []).every(c => matches(c, row));
    case 'or': return (cond.conditions ?? []).some(c => matches(c, row));
    case 'eq': return row[cond.field!] === cond.value;
    case 'isNull': return row[cond.field!] == null;
    case 'gt': return row[cond.field!] != null && (row[cond.field!] as Date) > (cond.value as Date);
    default: return false;
  }
}

mock.module('drizzle-orm', () => ({
  eq: (field: string, value: unknown) => ({ type: 'eq', field, value }),
  isNull: (field: string) => ({ type: 'isNull', field }),
  gt: (field: string, value: unknown) => ({ type: 'gt', field, value }),
  and: (...conditions: Cond[]) => ({ type: 'and', conditions }),
  or: (...conditions: Cond[]) => ({ type: 'or', conditions }),
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: {
    id: 'id',
    label: 'label',
    purpose: 'purpose',
    tokenExpiresAt: 'tokenExpiresAt',
    createdAt: 'createdAt',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      secrets: {
        findMany: async (args: { where?: Cond }) =>
          keyRows
            .filter(r => matches(args?.where, { ...r, purpose: 'signing_key' }))
            .map(r => ({ id: r.id, label: r.label })),
        findFirst: async (args: { where?: Cond }) =>
          keyRows
            .filter(r => matches(args?.where, { ...r, purpose: 'signing_key' }))
            .map(r => ({ id: r.id, label: r.label, createdAt: r.createdAt }))[0] ?? undefined,
      },
    },
  },
}));

mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({
    get: async (id: string) => (keyRows.some(r => r.id === id) ? fakeStoredKeypair(id) : null),
  }),
}));

import { generateSigningKeypair, signAssertion, makeKid, getAllPublicKeys } from './signing-keys';

// Helper to decode a base64url string
function decodeB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  const binary = atob(b64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function parseJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerB64, payloadB64] = token.split('.');
  const header = JSON.parse(new TextDecoder().decode(decodeB64Url(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(decodeB64Url(payloadB64)));
  return { header, payload };
}

describe('generateSigningKeypair', () => {
  it('generates a P-256 keypair with correct metadata', async () => {
    const kid = 'buildd-2026-07';
    const kp = await generateSigningKeypair(kid);

    expect(kp.privateKeyJwk.kty).toBe('EC');
    expect(kp.publicKeyJwk.kty).toBe('EC');
    expect((kp.privateKeyJwk as { crv?: string }).crv).toBe('P-256');
    expect((kp.publicKeyJwk as { crv?: string }).crv).toBe('P-256');
    expect(kp.privateKeyJwk.kid).toBe(kid);
    expect(kp.publicKeyJwk.kid).toBe(kid);
    expect(kp.publicKeyJwk.alg).toBe('ES256');
    expect(kp.publicKeyJwk.use).toBe('sig');
    // Private key must have the 'd' component
    expect(kp.privateKeyJwk).toHaveProperty('d');
    // Public key must NOT have 'd'
    expect(kp.publicKeyJwk).not.toHaveProperty('d');
  });

  it('generates distinct keypairs on each call', async () => {
    const kp1 = await generateSigningKeypair('buildd-2026-01');
    const kp2 = await generateSigningKeypair('buildd-2026-01');
    expect(kp1.publicKeyJwk.x).not.toBe(kp2.publicKeyJwk.x);
  });
});

describe('signAssertion', () => {
  it('produces a valid compact JWS with correct header claims', async () => {
    const kid = 'buildd-2026-07';
    const kp = await generateSigningKeypair(kid);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'https://buildd.dev',
      sub: 'account-1:team-1',
      act: { sub: 'worker:w-1', tid: 'task-1' },
      aud: 'https://cue.buildd.dev/api/mcp',
      jti: 'abc123',
      iat: now,
      exp: now + 300,
    };

    const token = await signAssertion(payload, kp.privateKeyJwk, kid);

    expect(token.split('.')).toHaveLength(3);
    const { header, payload: p } = parseJwt(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe(kid);
    expect(header.typ).toBe('JWT');
    expect(p.iss).toBe('https://buildd.dev');
    expect(p.sub).toBe('account-1:team-1');
    expect(p.aud).toBe('https://cue.buildd.dev/api/mcp');
    expect(p.jti).toBe('abc123');
    expect(p.iat).toBe(now);
    expect(p.exp).toBe(now + 300);
    expect((p.act as { sub: string }).sub).toBe('worker:w-1');
    expect((p.act as { tid: string }).tid).toBe('task-1');
  });

  it('signature verifies with the corresponding public key', async () => {
    const kid = 'buildd-2026-07';
    const kp = await generateSigningKeypair(kid);
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: 'https://buildd.dev', iat: now, exp: now + 300, jti: 'x' };

    const token = await signAssertion(payload, kp.privateKeyJwk, kid);
    const [headerB64, payloadB64, sigB64] = token.split('.');
    const signingInput = `${headerB64}.${payloadB64}`;

    const publicKey = await crypto.subtle.importKey(
      'jwk',
      kp.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const sigBytes = decodeB64Url(sigB64);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      new TextEncoder().encode(signingInput),
    );

    expect(valid).toBe(true);
  });

  it('signature from a different key does NOT verify', async () => {
    const kid = 'buildd-2026-07';
    const kp1 = await generateSigningKeypair(kid);
    const kp2 = await generateSigningKeypair(kid);
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: 'https://buildd.dev', iat: now, exp: now + 300, jti: 'x' };

    const token = await signAssertion(payload, kp1.privateKeyJwk, kid);
    const [headerB64, payloadB64, sigB64] = token.split('.');
    const signingInput = `${headerB64}.${payloadB64}`;

    const wrongPublicKey = await crypto.subtle.importKey(
      'jwk',
      kp2.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      wrongPublicKey,
      decodeB64Url(sigB64),
      new TextEncoder().encode(signingInput),
    );

    expect(valid).toBe(false);
  });

  it('jti values are unique across calls (each call produces a different payload)', async () => {
    // This tests that the caller is responsible for jti uniqueness (random per call)
    const kid = 'test-kid';
    const kp = await generateSigningKeypair(kid);
    const now = Math.floor(Date.now() / 1000);

    const jti1 = crypto.randomUUID();
    const jti2 = crypto.randomUUID();
    expect(jti1).not.toBe(jti2);

    const t1 = await signAssertion({ jti: jti1, iat: now, exp: now + 300 }, kp.privateKeyJwk, kid);
    const t2 = await signAssertion({ jti: jti2, iat: now, exp: now + 300 }, kp.privateKeyJwk, kid);
    expect(t1).not.toBe(t2);
  });

  it('assertion expires at iat + 300 seconds', async () => {
    const kid = 'test-kid';
    const kp = await generateSigningKeypair(kid);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 300;

    const token = await signAssertion({ iat, exp, jti: 'j' }, kp.privateKeyJwk, kid);
    const { payload } = parseJwt(token);

    expect(payload.exp).toBe(iat + 300);
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
  });

  it('audience is exactly the connector assertionAudience', async () => {
    const kid = 'test-kid';
    const kp = await generateSigningKeypair(kid);
    const aud = 'https://cue.buildd.dev/api/mcp';
    const now = Math.floor(Date.now() / 1000);

    const token = await signAssertion({ aud, iat: now, exp: now + 300, jti: 'j' }, kp.privateKeyJwk, kid);
    const { payload } = parseJwt(token);

    expect(payload.aud).toBe(aud);
  });
});

describe('makeKid', () => {
  // Regression: a month-granular kid collides when two keys are minted in the
  // same month (a forced rotation, or a concurrent JWKS bootstrap). Two JWKS
  // entries sharing one kid make verifier key selection non-deterministic.
  it('produces different kids for two keys minted in the same month', () => {
    const a = makeKid(new Date('2026-07-02T00:00:00.000Z'));
    const b = makeKid(new Date('2026-07-19T12:34:56.000Z'));
    expect(a).not.toBe(b);
  });

  it('produces different kids even for the same instant (concurrent mint)', () => {
    const at = new Date('2026-07-02T00:00:00.000Z');
    expect(makeKid(at)).not.toBe(makeKid(at));
  });

  it('keeps the buildd-YYYY-MM prefix so kids stay recognisable', () => {
    const kid = makeKid(new Date('2026-07-02T00:00:00.000Z'));
    expect(kid.startsWith('buildd-2026-07')).toBe(true);
    // Distinguishing suffix, not a bare month.
    expect(kid).not.toBe('buildd-2026-07');
  });
});

describe('getAllPublicKeys', () => {
  const now = new Date();
  const inFiveDays = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);

  beforeEach(() => {
    keyRows = [];
  });

  it('publishes the Active key (tokenExpiresAt IS NULL)', async () => {
    keyRows = [
      { id: 'key-active', label: 'buildd-2026-07-abc1', tokenExpiresAt: null, createdAt: twentyDaysAgo },
    ];
    const keys = await getAllPublicKeys();
    expect(keys.map(k => k.kid)).toEqual(['buildd-2026-07-abc1']);
  });

  it('publishes a Retiring key whose tokenExpiresAt is still in the future', async () => {
    // Relying parties must still be able to verify assertions signed before rotation.
    keyRows = [
      { id: 'key-retiring', label: 'buildd-2026-06-def2', tokenExpiresAt: inFiveDays, createdAt: twentyDaysAgo },
      { id: 'key-active', label: 'buildd-2026-07-abc1', tokenExpiresAt: null, createdAt: now },
    ];
    const keys = await getAllPublicKeys();
    expect(keys.map(k => k.kid).sort()).toEqual(['buildd-2026-06-def2', 'buildd-2026-07-abc1']);
  });

  it('does NOT publish an expired Retiring key even if the deleter never ran', async () => {
    // Regression: expiry used to be enforced only by the rotation cron's delete
    // step, which the manifest stages disabled.
    keyRows = [
      { id: 'key-expired', label: 'buildd-2026-05-old0', tokenExpiresAt: oneDayAgo, createdAt: twentyDaysAgo },
      { id: 'key-active', label: 'buildd-2026-07-abc1', tokenExpiresAt: null, createdAt: now },
    ];
    const keys = await getAllPublicKeys();
    expect(keys.map(k => k.kid)).toEqual(['buildd-2026-07-abc1']);
  });

  it('still resolves a legacy month-format kid', async () => {
    keyRows = [
      { id: 'key-legacy', label: 'buildd-2026-07', tokenExpiresAt: null, createdAt: twentyDaysAgo },
    ];
    const keys = await getAllPublicKeys();
    expect(keys.map(k => k.kid)).toEqual(['buildd-2026-07']);
    expect(keys[0].publicKeyJwk.kty).toBe('EC');
  });
});
