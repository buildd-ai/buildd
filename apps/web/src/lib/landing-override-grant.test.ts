import { describe, expect, test } from 'bun:test';
import { grantAllows, readLandingOverrideGrant, stampLandingOverrideGrant, withoutLandingOverrideGrant } from './landing-override-grant';

const NOW = new Date('2026-10-08T12:00:00Z');

describe('stampLandingOverrideGrant', () => {
  test('a context without a grant passes through untouched, whoever creates it', () => {
    const ctx = { baseBranch: 'dev' };
    expect(stampLandingOverrideGrant(ctx, null)).toEqual({ ok: true, context: ctx });
    expect(stampLandingOverrideGrant(undefined, null)).toEqual({ ok: true, context: undefined });
  });

  test('only a person may set it: an API key or task token is refused', () => {
    const out = stampLandingOverrideGrant({ landingOverride: { prNumbers: [42], overrides: ['freshness'] } }, null);
    expect(out).toMatchObject({ ok: false, status: 403 });
  });

  test('a person\'s grant is stamped with that person; a caller-supplied grantedBy is ignored', () => {
    const out = stampLandingOverrideGrant({ x: 1, landingOverride: { prNumbers: [42, 42], overrides: ['freshness'], grantedBy: 'human:someone-else' } }, 'u-1', NOW);
    expect(out).toEqual({ ok: true, context: { x: 1, landingOverride: { prNumbers: [42], overrides: ['freshness'], grantedBy: 'human:u-1', grantedAt: NOW.toISOString() } } });
  });

  test('a verdict override is never grantable; shapes are checked', () => {
    expect(stampLandingOverrideGrant({ landingOverride: { prNumbers: [42], overrides: ['verdict'] } }, 'u-1')).toMatchObject({ ok: false, status: 400 });
    expect(stampLandingOverrideGrant({ landingOverride: { prNumbers: [], overrides: ['size'] } }, 'u-1')).toMatchObject({ ok: false, status: 400 });
    expect(stampLandingOverrideGrant({ landingOverride: { prNumbers: ['42'], overrides: ['size'] } }, 'u-1')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('withoutLandingOverrideGrant', () => {
  test('a template-spawned context never carries a grant', () => {
    expect(withoutLandingOverrideGrant({ a: 1, landingOverride: { prNumbers: [1] } })).toEqual({ a: 1 });
    expect(withoutLandingOverrideGrant({ a: 1 })).toEqual({ a: 1 });
    expect(withoutLandingOverrideGrant(undefined)).toBeUndefined();
  });
});

describe('grantAllows', () => {
  const ctx = { landingOverride: { prNumbers: [42], overrides: ['freshness'], grantedBy: 'human:u-1', grantedAt: NOW.toISOString() } };

  test('allows exactly the PRs and kinds a person granted', () => {
    expect(grantAllows(ctx, 42, ['freshness'])).toMatchObject({ ok: true, grant: { grantedBy: 'human:u-1' } });
    expect(grantAllows(ctx, 43, ['freshness'])).toMatchObject({ ok: false, reason: expect.stringContaining('not #43') });
    expect(grantAllows(ctx, 42, ['size'])).toMatchObject({ ok: false, reason: expect.stringContaining('size') });
  });

  test('no grant, or one no person stamped, is no authority', () => {
    expect(grantAllows({}, 42, ['freshness'])).toMatchObject({ ok: false });
    expect(readLandingOverrideGrant({ landingOverride: { prNumbers: [42], overrides: ['freshness'], grantedBy: 'agent:w-1' } })).toBeNull();
    expect(readLandingOverrideGrant({ landingOverride: { prNumbers: [42], overrides: ['freshness'] } })).toBeNull();
  });
});
