import { describe, it, expect } from 'bun:test';
import { generateSigningKeypair, signAssertion } from './signing-keys';

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
