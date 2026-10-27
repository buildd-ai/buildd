/**
 * The binding a passkey challenge is stored with (Living Spec b7fc9316 R-20):
 * one person, one act, and every field of the act's pin. The real-Postgres
 * suite (tests/db/spec-passkey-presence.test.ts) proves the refusals end to
 * end; this pins the function they rest on.
 */
import { describe, expect, it } from 'bun:test';
import { challengeOf, parsePresencePin, presenceBinding, type PresencePin } from './binding';

const SPEC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';
const U2 = '44444444-4444-4444-8444-444444444444';
const H = 'a'.repeat(64);
const approve: PresencePin = { op: 'approve', specId: SPEC, revision: 3, version: 5, contentHash: H };

describe('presenceBinding', () => {
  it('differs when any field of an approve pin differs: revision, version, hash, spec, person, purpose', () => {
    const b = presenceBinding(U1, 'presence', approve);
    const variants = [
      presenceBinding(U1, 'presence', { ...approve, revision: 4 }),
      presenceBinding(U1, 'presence', { ...approve, version: 6 }),
      presenceBinding(U1, 'presence', { ...approve, contentHash: 'b'.repeat(64) }),
      presenceBinding(U1, 'presence', { ...approve, specId: OTHER }),
      presenceBinding(U2, 'presence', approve),
      presenceBinding(U1, 'register', approve),
    ];
    for (const v of variants) expect(v).not.toBe(b);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('a retire pin is not a restore pin over the same spec, version and status', () => {
    const retire = presenceBinding(U1, 'presence', { op: 'retire', specId: SPEC, version: 2, status: 'approved', supersededBy: null });
    const restore = presenceBinding(U1, 'presence', { op: 'restore', specId: SPEC, version: 2, status: 'approved' });
    expect(retire).not.toBe(restore);
  });

  it('is the same however the browser ordered the keys or the batch', () => {
    const shuffled = parsePresencePin({ contentHash: H, version: 5, revision: 3, specId: SPEC, op: 'approve' })!;
    expect(presenceBinding(U1, 'presence', shuffled)).toBe(presenceBinding(U1, 'presence', approve));
    const a = presenceBinding(U1, 'presence', { op: 'confirm_import', workspaceId: OTHER, specIds: [SPEC, U1] });
    const b = presenceBinding(U1, 'presence', { op: 'confirm_import', workspaceId: OTHER, specIds: [U1, SPEC, U1] });
    expect(a).toBe(b);
  });
});

describe('parsePresencePin', () => {
  it('keeps only the fields of a known act', () => {
    expect(parsePresencePin({ ...approve, extra: 'x' })).toEqual(approve);
    expect(parsePresencePin({ op: 'team_passkey', teamId: SPEC, required: false })).toEqual({ op: 'team_passkey', teamId: SPEC, required: false });
  });

  it('refuses anything else', () => {
    for (const bad of [
      null, 'approve', [], { op: 'delete_everything' },
      { ...approve, revision: 0 }, { ...approve, version: 1.5 }, { ...approve, contentHash: 'xyz' }, { ...approve, specId: 'not-a-uuid' },
      { op: 'retire', specId: SPEC, version: 1, status: 'Approved; DROP', supersededBy: null },
      { op: 'retire', specId: SPEC, version: 1, status: 'approved' },
      { op: 'confirm_import', workspaceId: SPEC, specIds: [] },
      { op: 'team_passkey', teamId: SPEC, required: 'yes' },
    ]) expect(parsePresencePin(bad)).toBeNull();
  });
});

describe('challengeOf', () => {
  const wrap = (data: unknown) => ({ response: { clientDataJSON: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64url') } });
  it('reads the challenge the browser signed over', () => {
    expect(challengeOf(wrap({ type: 'webauthn.get', challenge: 'abcdefghijklmnopqrstuv' }))).toBe('abcdefghijklmnopqrstuv');
  });
  it('is null for anything unreadable', () => {
    for (const bad of [null, {}, wrap('not json'), wrap({ challenge: 'short' }), wrap({ challenge: 'has spaces in it, many many' }), { response: { clientDataJSON: 'x'.repeat(5000) } }]) {
      expect(challengeOf(bad)).toBeNull();
    }
  });
});
