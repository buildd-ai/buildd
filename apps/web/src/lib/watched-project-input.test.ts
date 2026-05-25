import { describe, it, expect } from 'bun:test';
import { parseCreateInput, parseUpdateInput } from './watched-project-input';

describe('parseCreateInput', () => {
  it('accepts a minimal valid payload', () => {
    const out = parseCreateInput({ repo: 'buildd-ai/buildd' });
    expect(out.repo).toBe('buildd-ai/buildd');
    expect(out.enabled).toBe(true);
    expect(out.inFlightWindowMin).toBe(60);
    expect(out.prodGraceMin).toBe(60);
    expect(out.roleSlug).toBe('ops');
    expect(out.pushoverApp).toBe('alerts');
    expect(out.releasePrFilter).toEqual({ base: 'main' });
    expect(out.vercelProjectId).toBeNull();
  });

  it('passes through all overrides', () => {
    const secretId = '11111111-1111-4111-8111-111111111111';
    const out = parseCreateInput({
      repo: 'acme/web',
      enabled: false,
      vercelProjectId: 'prj_abc',
      vercelTokenSecretId: secretId,
      inFlightWindowMin: 30,
      prodGraceMin: 120,
      roleSlug: 'firefighter',
      pushoverApp: 'tasks',
      releasePrFilter: { base: 'release', label: 'rc' },
      notes: 'flaky CI',
    });
    expect(out.enabled).toBe(false);
    expect(out.vercelProjectId).toBe('prj_abc');
    expect(out.vercelTokenSecretId).toBe(secretId);
    expect(out.inFlightWindowMin).toBe(30);
    expect(out.prodGraceMin).toBe(120);
    expect(out.roleSlug).toBe('firefighter');
    expect(out.pushoverApp).toBe('tasks');
    expect(out.releasePrFilter).toEqual({ base: 'release', label: 'rc' });
    expect(out.notes).toBe('flaky CI');
  });

  it('defaults vercelTokenSecretId to null when unset', () => {
    const out = parseCreateInput({ repo: 'a/b' });
    expect(out.vercelTokenSecretId).toBeNull();
  });

  it('rejects a non-UUID vercelTokenSecretId', () => {
    expect(() => parseCreateInput({ repo: 'a/b', vercelTokenSecretId: 'not-a-uuid' })).toThrow(/vercelTokenSecretId/);
  });

  it('rejects missing repo', () => {
    expect(() => parseCreateInput({})).toThrow(/repo/);
  });

  it('rejects malformed repo string', () => {
    expect(() => parseCreateInput({ repo: 'no-slash' })).toThrow(/owner\/name/);
    expect(() => parseCreateInput({ repo: 'too/many/slashes' })).toThrow(/owner\/name/);
  });

  it('rejects negative windows', () => {
    expect(() => parseCreateInput({ repo: 'a/b', inFlightWindowMin: -1 })).toThrow(/inFlightWindowMin/);
    expect(() => parseCreateInput({ repo: 'a/b', prodGraceMin: 0 })).toThrow(/prodGraceMin/);
  });

  it('rejects an invalid pushoverApp', () => {
    expect(() => parseCreateInput({ repo: 'a/b', pushoverApp: 'nope' })).toThrow(/pushoverApp/);
  });
});

describe('parseUpdateInput', () => {
  it('returns only the fields present', () => {
    const out = parseUpdateInput({ enabled: false, notes: 'paused' });
    expect(out).toEqual({ enabled: false, notes: 'paused' });
  });

  it('rejects empty patch', () => {
    expect(() => parseUpdateInput({})).toThrow(/at least one/i);
  });

  it('validates types on the fields it does receive', () => {
    expect(() => parseUpdateInput({ prodGraceMin: -5 })).toThrow(/prodGraceMin/);
    expect(() => parseUpdateInput({ repo: 'bad' })).toThrow(/owner\/name/);
    expect(() => parseUpdateInput({ vercelTokenSecretId: 'not-a-uuid' })).toThrow(/vercelTokenSecretId/);
  });

  it('accepts null to clear vercelTokenSecretId', () => {
    const out = parseUpdateInput({ vercelTokenSecretId: null });
    expect(out.vercelTokenSecretId).toBeNull();
  });

  it('does not silently coerce unknown fields', () => {
    const out = parseUpdateInput({ enabled: true, mystery: 'value' } as Record<string, unknown>);
    expect((out as Record<string, unknown>).mystery).toBeUndefined();
  });
});
