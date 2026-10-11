import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  verifyLicenseToken, resolveLicenseStatus, redactedLicenseSummary, checkCommercialCapability,
  BUILT_IN_PUBLIC_KEYS, clampPolicy, DEFAULT_LICENSE_POLICY, parsePublicKeyOverride,
} from '../license';
import { signToken, publicKeyOf, TEST_SEED_A, TEST_SEED_B, basePayload, T0, DAY } from './fixtures/license-test-signer';

const KEY_A = publicKeyOf(TEST_SEED_A);
const KEYS = { 'test-a': KEY_A };
const NOW = T0 + 10 * DAY;
const sign = (over: Record<string, unknown> = {}, seed = TEST_SEED_A, header?: Record<string, unknown>) =>
  signToken(seed, basePayload(over), header);
const verify = (token: string, o: Parameters<typeof verifyLicenseToken>[1] = {}) =>
  verifyLicenseToken(token, { keys: KEYS, now: NOW, ...o });

// Stable vector: Ed25519 is deterministic, so this token never changes.
const VECTOR_KEY = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw';
const VECTOR =
  'eyJhbGciOiJFZERTQSIsInR5cCI6ImJ1aWxkZC1saWNlbnNlIiwia2lkIjoidGVzdC1hIn0.eyJ2IjoxLCJpc3MiOiJidWlsZGQtbGljZW5zaW5nIiwianRpIjoibGljX3Rlc3RfMDAxIiwiY3VzdG9tZXIiOnsiaWQiOiJjdXN0X3Rlc3QiLCJuYW1lIjoiRXhhbXBsZSBDb3JwIn0sImVkaXRpb24iOiJ0ZWFtIiwiZmVhdHVyZXMiOlsiY29sbGFiIl0sImxpbWl0cyI6eyJtYXhTZWF0cyI6MjV9LCJpYXQiOjE3OTAwMDAwMDAsIm5iZiI6MTc5MDAwMDAwMCwiZXhwIjoxODIxNTM2MDAwLCJraW5kIjoicHJvZHVjdGlvbiJ9.KkOoBQsO34txa_8O8cHaFDoC-R-f9tV_yd2czk9NjXQTP6L3VfNxMEYGdnVbQEgn90z_KZa4vIaJpmehv_KbCA';

describe('verify: valid tokens', () => {
  test('stable test vector verifies', () => {
    expect(publicKeyOf(TEST_SEED_A)).toBe(VECTOR_KEY);
    expect(sign()).toBe(VECTOR);
    const s = verifyLicenseToken(VECTOR, { keys: { 'test-a': VECTOR_KEY }, now: NOW });
    expect(s.status).toBe('active');
    expect(s.claims).toMatchObject({ id: 'lic_test_001', edition: 'team', maxSeats: 25, features: ['collab'], keyId: 'test-a' });
  });
  test('enterprise edition with deployment binding', () => {
    const t = sign({ edition: 'enterprise', features: ['sso', 'scim'], deployment: { id: 'dep_1' } });
    const s = verify(t, { deploymentId: 'dep_1' });
    expect(s.status).toBe('active');
    expect(s.claims?.edition).toBe('enterprise');
    expect(s.claims?.deploymentId).toBe('dep_1');
  });
  test('unbound token ignores deployment id', () => {
    expect(verify(sign(), { deploymentId: 'anything' }).status).toBe('active');
  });
  test('unknown feature ids are carried, not rejected', () => {
    expect(verify(sign({ features: ['some_future_thing'] })).claims?.features).toEqual(['some_future_thing']);
  });
});

describe('verify: rejections', () => {
  test('missing license is absent, not invalid', () => {
    expect(verifyLicenseToken(undefined, { keys: KEYS }).status).toBe('absent');
    expect(verifyLicenseToken('   ', { keys: KEYS }).status).toBe('absent');
  });
  test('wrong signer', () => {
    expect(verify(sign({}, TEST_SEED_B))).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });
  test('unknown kid, including prototype keys', () => {
    expect(verify(sign({}, TEST_SEED_A, { alg: 'EdDSA', typ: 'buildd-license', kid: 'other' }))).toMatchObject({ reason: 'unknown_key_id' });
    expect(verify(sign({}, TEST_SEED_A, { alg: 'EdDSA', typ: 'buildd-license', kid: 'constructor' }))).toMatchObject({ reason: 'unknown_key_id' });
  });
  test.each(['none', 'HS256', 'RS256', 'ES256', 'eddsa'])('bad algorithm %s', (alg) => {
    expect(verify(sign({}, TEST_SEED_A, { alg, typ: 'buildd-license', kid: 'test-a' }))).toMatchObject({ reason: 'unsupported_algorithm' });
  });
  test('wrong token type', () => {
    expect(verify(sign({}, TEST_SEED_A, { alg: 'EdDSA', typ: 'JWT', kid: 'test-a' }))).toMatchObject({ reason: 'unsupported_type' });
  });
  test('tampered payload fails signature', () => {
    const [h, , s] = sign().split('.');
    const forged = Buffer.from(JSON.stringify(basePayload({ edition: 'enterprise', features: ['sso'] }))).toString('base64url');
    expect(verify(`${h}.${forged}.${s}`)).toMatchObject({ status: 'invalid', reason: 'bad_signature' });
  });
  test('tampered header and truncated signature fail', () => {
    const [, p, s] = sign().split('.');
    const h2 = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'buildd-license', kid: 'test-a', x: 1 })).toString('base64url');
    expect(verify(`${h2}.${p}.${s}`).reason).toBe('bad_signature');
    expect(verify(sign().slice(0, -4)).status).toBe('invalid');
  });
  test.each(['garbage', 'a.b', 'a.b.c.d', '!!.@@.##', '....'])('malformed %s', (t) => {
    expect(verify(t).status).toBe('invalid');
  });
  test('oversized token', () => {
    expect(verify('a'.repeat(9000))).toMatchObject({ reason: 'too_large' });
  });
  test('unknown edition', () => {
    expect(verify(sign({ edition: 'platinum' }))).toMatchObject({ reason: 'unknown_edition' });
  });
  test('unsupported version and wrong issuer', () => {
    expect(verify(sign({ v: 2 })).reason).toBe('unsupported_version');
    expect(verify(sign({ iss: 'someone-else' })).reason).toBe('wrong_issuer');
  });
  test('unknown critical field rejected; known critical accepted', () => {
    expect(verify(sign({ crit: ['quota_v2'] })).reason).toBe('unknown_critical_field');
    expect(verify(sign({ crit: ['features'] })).status).toBe('active');
    expect(verify(sign({ crit: 'features' })).reason).toBe('invalid_field');
  });
  test('non-critical unknown fields tolerated', () => {
    expect(verify(sign({ futureThing: 1 })).status).toBe('active');
  });
  test.each([
    ['bad kind', { kind: 'free' }], ['bad jti', { jti: '' }], ['no customer', { customer: undefined }],
    ['features not array', { features: 'collab' }], ['bad feature id', { features: ['Bad Id'] }],
    ['seats zero', { limits: { maxSeats: 0 } }], ['seats float', { limits: { maxSeats: 1.5 } }],
    ['exp before nbf', { exp: T0 - 1 }], ['exp string', { exp: '1' }], ['negative grace', { graceDays: -1 }],
    ['bad deployment', { deployment: { id: 5 } }],
  ])('invalid field: %s', (_n, over) => {
    expect(verify(sign(over as Record<string, unknown>))).toMatchObject({ status: 'invalid', reason: 'invalid_field' });
  });
  test('deployment binding mismatch / missing id', () => {
    const t = sign({ deployment: { id: 'dep_1' } });
    expect(verify(t, { deploymentId: 'dep_2' }).reason).toBe('deployment_mismatch');
    expect(verify(t).reason).toBe('deployment_mismatch');
  });
  test('malformed keys', () => {
    const t = sign();
    expect(verify(t, { keys: { 'test-a': 'not-a-key' } }).reason).toBe('bad_key');
    expect(verify(t, { keys: { 'test-a': 'AAAA' } }).reason).toBe('bad_key');
    expect(verify(t, { keys: { 'test-a': '' } }).reason).toBe('bad_key');
    expect(parsePublicKeyOverride('{nope')).toEqual({});
    expect(parsePublicKeyOverride('[1]')).toEqual({});
    expect(parsePublicKeyOverride(JSON.stringify({ k: KEY_A, n: 5 }))).toEqual({ k: KEY_A });
  });
});

describe('verify: time window, skew, grace', () => {
  const exp = T0 + 365 * DAY;
  test('not yet valid, within skew accepted', () => {
    expect(verify(sign(), { now: T0 - 3600 }).status).toBe('not_yet_valid');
    expect(verify(sign(), { now: T0 - 300 }).status).toBe('active');
  });
  test('exp boundary respects skew', () => {
    expect(verify(sign(), { now: exp + 599 }).status).toBe('active');
    expect(verify(sign(), { now: exp + 601 }).status).toBe('grace');
  });
  test('default 30-day grace then expired', () => {
    const t = sign();
    expect(verify(t, { now: exp + 29 * DAY }).status).toBe('grace');
    const s = verify(t, { now: exp + 31 * DAY });
    expect(s.status).toBe('expired');
    expect(s.claims).toBeDefined();
  });
  test('grace is a configurable policy, 0 disables', () => {
    expect(verify(sign(), { now: exp + DAY, policy: { graceDays: 0 } }).status).toBe('expired');
  });
  test('token graceDays cannot exceed server max', () => {
    const t = sign({ graceDays: 90 });
    expect(verify(t, { now: exp + 40 * DAY }).status).toBe('expired');
    expect(verify(t, { now: exp + 40 * DAY, policy: { maxGraceDays: 90 } }).status).toBe('grace');
  });
  test('policy is clamped', () => {
    expect(clampPolicy({ clockSkewSeconds: 1e9, graceDays: 1e9, maxGraceDays: 1e9 })).toEqual({
      clockSkewSeconds: 3600, graceDays: 90, maxGraceDays: 90,
    });
    expect(clampPolicy({ graceDays: NaN, clockSkewSeconds: -5 })).toEqual(DEFAULT_LICENSE_POLICY);
  });
});

describe('env resolution, airgap, redaction', () => {
  test('no license configured is absent; shipped keyset has no keys', () => {
    expect(resolveLicenseStatus({}).status).toBe('absent');
    expect(Object.keys(BUILT_IN_PUBLIC_KEYS)).toEqual([]);
  });
  test('built-in keyset alone trusts nothing', () => {
    expect(resolveLicenseStatus({ BUILDD_LICENSE: sign() }, { now: NOW })).toMatchObject({ status: 'invalid', reason: 'unknown_key_id' });
  });
  test('BUILDD_LICENSE with operator pubkeys; no network used', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls++; throw new Error('network'); }) as unknown as typeof fetch;
    try {
      const env = { BUILDD_LICENSE: sign(), BUILDD_LICENSE_PUBKEYS: JSON.stringify(KEYS) };
      expect(resolveLicenseStatus(env, { now: NOW }).status).toBe('active');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });
  test('BUILDD_LICENSE_FILE and unreadable file', () => {
    const f = join(import.meta.dir, 'fixtures', 'license-vector.txt');
    expect(existsSync(f)).toBe(true);
    const env = { BUILDD_LICENSE_PUBKEYS: JSON.stringify({ 'test-a': VECTOR_KEY }) };
    expect(resolveLicenseStatus({ ...env, BUILDD_LICENSE_FILE: f }, { now: NOW }).status).toBe('active');
    expect(resolveLicenseStatus({ BUILDD_LICENSE_FILE: '/nonexistent/x' })).toMatchObject({ status: 'invalid', reason: 'read_failed' });
  });
  test('deployment id from env, grace days from env', () => {
    const t = sign({ deployment: { id: 'dep_9' } });
    const base = { BUILDD_LICENSE: t, BUILDD_LICENSE_PUBKEYS: JSON.stringify(KEYS) };
    expect(resolveLicenseStatus(base, { now: NOW }).reason).toBe('deployment_mismatch');
    expect(resolveLicenseStatus({ ...base, BUILDD_DEPLOYMENT_ID: 'dep_9' }, { now: NOW }).status).toBe('active');
    const late = T0 + 365 * DAY + DAY;
    expect(resolveLicenseStatus({ ...base, BUILDD_DEPLOYMENT_ID: 'dep_9', BUILDD_LICENSE_GRACE_DAYS: '0' }, { now: late }).status).toBe('expired');
  });
  test('summary and reasons never contain token material', () => {
    const t = sign();
    const [h, p, s] = t.split('.');
    const results = [
      verify(t), verify(t.slice(0, -3)), verify(sign({}, TEST_SEED_B)), verify(sign({ edition: 'x' })),
      resolveLicenseStatus({ BUILDD_LICENSE: t }),
    ];
    for (const r of results) {
      const json = JSON.stringify(redactedLicenseSummary(r)) + JSON.stringify(r.reason ?? '');
      for (const seg of [h, p, s]) expect(json).not.toContain(seg);
      expect(json).not.toContain(KEY_A);
    }
    const sum = redactedLicenseSummary(verify(t));
    expect(sum).toMatchObject({ status: 'active', edition: 'team', licenseId: 'lic_test_001', keyId: 'test-a', maxSeats: 25 });
    expect(Object.keys(sum).sort()).not.toContain('token');
  });
});

describe('checkCommercialCapability', () => {
  const selfhost = (over: Record<string, unknown>, features?: string[]) =>
    ({ deployment: 'selfhost' as const, license: verify(sign({ ...(features ? { features } : {}), ...over })) });
  test('selfhost: licensed claim allowed, others denied with reason', () => {
    const scope = selfhost({}, ['sso']);
    expect(checkCommercialCapability('sso', scope)).toEqual({ allowed: true, claim: 'sso', source: 'license' });
    expect(checkCommercialCapability('scim', scope)).toMatchObject({ allowed: false, reason: 'capability_not_licensed', source: 'license' });
  });
  test('selfhost: gates on claims, not edition', () => {
    expect(checkCommercialCapability('sso', selfhost({ edition: 'enterprise' }, ['collab'])).allowed).toBe(false);
  });
  test('selfhost: missing, invalid, expired, grace', () => {
    expect(checkCommercialCapability('collab', { deployment: 'selfhost', env: {} })).toMatchObject({ allowed: false, reason: 'license_required' });
    expect(checkCommercialCapability('collab', { deployment: 'selfhost', license: verify('junk') })).toMatchObject({ reason: 'license_invalid' });
    const exp = T0 + 365 * DAY;
    expect(checkCommercialCapability('collab', { deployment: 'selfhost', license: verify(sign(), { now: exp + 40 * DAY }) })).toMatchObject({ reason: 'license_expired' });
    expect(checkCommercialCapability('collab', { deployment: 'selfhost', license: verify(sign(), { now: exp + 5 * DAY }) })).toEqual({
      allowed: true, claim: 'collab', source: 'license', inGrace: true,
    });
    expect(checkCommercialCapability('collab', { deployment: 'selfhost', license: verify(sign(), { now: T0 - 7200 }) })).toMatchObject({ reason: 'license_not_yet_valid' });
  });
  test('hosted: not enforced is allowed (dark rollout, existing behaviour)', () => {
    expect(checkCommercialCapability('sso', { deployment: 'hosted', plan: 'free', billingEnforced: false })).toEqual({ allowed: true, claim: 'sso', source: 'default' });
  });
  test('hosted: enforced follows plan', () => {
    expect(checkCommercialCapability('collab', { deployment: 'hosted', plan: 'team', billingEnforced: true })).toMatchObject({ allowed: true, source: 'stripe' });
    expect(checkCommercialCapability('collab', { deployment: 'hosted', plan: 'free', billingEnforced: true })).toMatchObject({ allowed: false, reason: 'not_in_plan', source: 'stripe' });
    expect(checkCommercialCapability('collab', { deployment: 'hosted', plan: undefined, billingEnforced: true }).allowed).toBe(false);
    expect(checkCommercialCapability('collab', { deployment: 'hosted', plan: 'constructor', billingEnforced: true }).allowed).toBe(false);
  });
  test('denials carry a message and no token', () => {
    const d = checkCommercialCapability('sso', { deployment: 'selfhost', env: {} });
    expect(d.allowed === false && d.message).toContain('unaffected');
  });
  test('a hosted license is irrelevant: license env cannot unlock hosted plans', () => {
    expect(checkCommercialCapability('sso', { deployment: 'hosted', plan: 'free', billingEnforced: true }).allowed).toBe(false);
  });
});

describe('existing defaults untouched', () => {
  test('current entitlements unchanged when no license configured', async () => {
    const { entitlements } = await import('../entitlements');
    expect(entitlements({ plan: 'free' }, { env: {} })).toMatchObject({ enforced: false, maxMembers: null, knowledgeBaseCap: null });
    expect(entitlements({ plan: 'free' }, { env: { BILLING_ENFORCED: '1' } })).toMatchObject({ maxMembers: 1, knowledgeBaseCap: 50 });
  });
  test('license module is not wired into existing entitlement or runner code', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    for (const f of ['packages/core/entitlements.ts', 'apps/web/src/lib/entitlements/plans.ts', 'apps/web/src/lib/entitlements/managed-runner.ts']) {
      expect(readFileSync(join(root, f), 'utf8')).not.toMatch(/license/i);
    }
  });
  test('license files: root FSL and Apache packages untouched', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('FSL-1.1-ALv2');
    for (const p of ['apps/runner', 'packages/shared', 'packages/ai-kit']) {
      expect(readFileSync(join(root, p, 'LICENSE'), 'utf8')).toMatch(/Apache License/);
    }
    // No signing code or private key material in the public license module.
    const dir = join(import.meta.dir, '..', 'license');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/createPrivateKey|PRIVATE KEY|generateKeyPair|crypto\.sign\b|\bsign\(/);
    }
  });
});
