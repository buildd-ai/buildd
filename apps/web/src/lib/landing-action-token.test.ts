import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  LANDING_ACTION_TTL_MS,
  signLandingActionToken,
  verifyLandingActionToken,
  type LandingActionPayload,
} from './landing-action-token';

const input = {
  workspaceId: 'ws-1',
  prNumber: 42,
  headSha: 'abc1234',
  action: 'ci_fix' as const,
  reason: 'fix_stuck:ci_fix',
};

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY };
  process.env.AUTH_SECRET = 'test-secret';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('landing action token', () => {
  it('round-trips the payload and stamps an expiry and a nonce', () => {
    const now = 1_000_000;
    const token = signLandingActionToken(input, now)!;
    const res = verifyLandingActionToken(token, now + 1000);
    expect(res.ok).toBe(true);
    const p = (res as { ok: true; payload: LandingActionPayload }).payload;
    expect(p).toMatchObject(input);
    expect(p.exp).toBe(now + LANDING_ACTION_TTL_MS);
    expect(p.nonce.length).toBeGreaterThanOrEqual(16);
  });

  it('mints a distinct nonce per token', () => {
    const a = verifyLandingActionToken(signLandingActionToken(input)!);
    const b = verifyLandingActionToken(signLandingActionToken(input)!);
    expect((a as any).payload.nonce).not.toBe((b as any).payload.nonce);
  });

  it('rejects an expired token', () => {
    const now = 5_000;
    const token = signLandingActionToken(input, now)!;
    expect(verifyLandingActionToken(token, now + LANDING_ACTION_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLandingActionToken(token, now + LANDING_ACTION_TTL_MS - 1).ok).toBe(true);
  });

  it('rejects a tampered payload (a token for another workspace cannot be forged)', () => {
    const token = signLandingActionToken(input)!;
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), workspaceId: 'ws-other' }),
    ).toString('base64url');
    expect(verifyLandingActionToken(`${forged}.${sig}`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token signed with another secret', () => {
    const token = signLandingActionToken(input)!;
    process.env.AUTH_SECRET = 'rotated';
    expect(verifyLandingActionToken(token)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects garbage and an unsigned body', () => {
    expect(verifyLandingActionToken('')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyLandingActionToken('not-a-token')).toEqual({ ok: false, reason: 'malformed' });
    const body = Buffer.from(JSON.stringify({ ...input, exp: Date.now() + 1000, nonce: 'n' })).toString('base64url');
    expect(verifyLandingActionToken(body)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('does not accept a GitHub install state signed with the same secret', async () => {
    const { signInstallState } = await import('./github-install-state');
    expect(verifyLandingActionToken(signInstallState({ userId: 'u-1' })).ok).toBe(false);
  });

  it('cannot sign, and verifies nothing, without a secret', () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    expect(signLandingActionToken(input)).toBeNull();
    expect(verifyLandingActionToken('a.b')).toEqual({ ok: false, reason: 'unsigned' });
  });
});
