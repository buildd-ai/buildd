import { describe, expect, it } from 'bun:test';
import {
  checkBackendAllowed,
  chooseSource,
  normalizeTeamCodingPolicy,
  parseCodingPolicyLayer,
  resolveCodingPolicy,
} from '../coding-policy';

describe('resolveCodingPolicy', () => {
  it('no layers: unrestricted, everything allowed', () => {
    const p = resolveCodingPolicy({});
    expect(p.restricted).toBe(false);
    expect(p.allowedBackends).toEqual(['claude', 'codex']);
    expect(p.allowedSources).toEqual(['runner_native', 'metered']);
  });

  it('team Claude-only denies Codex without redirecting it', () => {
    const p = resolveCodingPolicy({ team: { allowedBackends: ['claude'] } });
    expect(checkBackendAllowed(p, 'claude').ok).toBe(true);
    const d = checkBackendAllowed(p, 'codex');
    expect(d.ok).toBe(false);
    if (!d.ok) { expect(d.denied.code).toBe('provider_not_allowed'); expect(d.denied.narrowedBy).toEqual(['team']); }
  });

  it('an empty list denies everything (fails closed)', () => {
    const p = resolveCodingPolicy({ team: { allowedBackends: [] } });
    expect(p.restricted).toBe(true);
    expect(checkBackendAllowed(p, 'claude').ok).toBe(false);
    expect(checkBackendAllowed(p, 'codex').ok).toBe(false);
  });

  it('a member layer narrows but never widens the team', () => {
    const p = resolveCodingPolicy({
      team: { allowedBackends: ['claude'] },
      member: { allowedBackends: ['claude', 'codex'] },
      requesterKnown: true,
    });
    expect(p.allowedBackends).toEqual(['claude']);
    const q = resolveCodingPolicy({ team: { allowedSources: ['runner_native', 'metered'] }, member: { allowedSources: ['runner_native'] } });
    expect(q.allowedSources).toEqual(['runner_native']);
    expect(q.narrowedBy.sources).toEqual(['member']);
  });

  it('personal limits are not applied to a task with no identifiable requester', () => {
    const p = resolveCodingPolicy({ member: { allowedSources: ['runner_native'] }, requesterKnown: false });
    expect(p.restricted).toBe(false);
    expect(p.allowedSources).toEqual(['runner_native', 'metered']);
    expect(p.requesterUnknown).toBe(true);
  });

  it('team rules still apply when the requester is unknown', () => {
    const p = resolveCodingPolicy({ team: { allowedBackends: ['claude'] }, member: { allowedBackends: ['codex'] }, requesterKnown: false });
    expect(p.allowedBackends).toEqual(['claude']);
  });

  it('workspace narrows the team', () => {
    const p = resolveCodingPolicy({ team: { allowedBackends: ['claude', 'codex'] }, workspace: { allowedBackends: ['codex'] } });
    expect(p.allowedBackends).toEqual(['codex']);
    expect(p.narrowedBy.backends).toEqual(['workspace']);
  });
});

describe('parseCodingPolicyLayer (stored read)', () => {
  it('a malformed list denies rather than allows', () => {
    expect(parseCodingPolicyLayer({ allowedBackends: 'claude' })).toEqual({ allowedBackends: [] });
    expect(parseCodingPolicyLayer({ allowedBackends: ['gemini'] })).toEqual({ allowedBackends: [] });
  });
  it('non-objects and empty layers are no layer', () => {
    expect(parseCodingPolicyLayer(null)).toBeNull();
    expect(parseCodingPolicyLayer({})).toBeNull();
    expect(parseCodingPolicyLayer([])).toBeNull();
  });
});

describe('chooseSource', () => {
  const noMetered = resolveCodingPolicy({ team: { allowedSources: ['runner_native'] } });
  const meteredOnly = resolveCodingPolicy({ team: { allowedSources: ['metered'] } });
  const open = resolveCodingPolicy({});

  it('self-host with a stored key but metered not authorized runs on the runner login', () => {
    expect(chooseSource(noMetered, 'claude', { meteredConfigured: true, runnerNativeCapable: true }))
      .toEqual({ ok: true, source: 'runner_native' });
  });

  it('no metered provider configured, self-host runner: runnable natively', () => {
    expect(chooseSource(open, 'claude', { meteredConfigured: false, runnerNativeCapable: true }))
      .toEqual({ ok: true, source: 'runner_native' });
  });

  it('hosted runner with nothing configured waits: no_model_credential', () => {
    const r = chooseSource(open, 'claude', { meteredConfigured: false, runnerNativeCapable: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denied.code).toBe('no_model_credential');
  });

  it('hosted runner under a native-only policy is refused as payment_source_not_allowed', () => {
    const r = chooseSource(noMetered, 'claude', { meteredConfigured: true, runnerNativeCapable: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denied.code).toBe('payment_source_not_allowed');
  });

  it('metered-only policy uses the paid route and never the runner login', () => {
    expect(chooseSource(meteredOnly, 'claude', { meteredConfigured: true, runnerNativeCapable: true }))
      .toEqual({ ok: true, source: 'metered' });
    const r = chooseSource(meteredOnly, 'claude', { meteredConfigured: false, runnerNativeCapable: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denied.source).toBe('runner_native');
  });

  it('an explicitly selected paid route is used within policy', () => {
    expect(chooseSource(open, 'claude', { meteredConfigured: true, runnerNativeCapable: true, preferMetered: true }))
      .toEqual({ ok: true, source: 'metered' });
    expect(chooseSource(noMetered, 'claude', { meteredConfigured: true, runnerNativeCapable: true, preferMetered: true }))
      .toEqual({ ok: true, source: 'runner_native' });
  });
});

describe('normalizeTeamCodingPolicy (admin write)', () => {
  it('rejects typos instead of saving a deny-all', () => {
    expect('error' in normalizeTeamCodingPolicy({ team: { allowedBackends: ['claud'] } })).toBe(true);
    expect('error' in normalizeTeamCodingPolicy({ team: { allowedSources: 'metered' } })).toBe(true);
  });
  it('rejects a workspace outside the team', () => {
    expect('error' in normalizeTeamCodingPolicy({ workspaces: { w9: { allowedBackends: ['claude'] } } }, new Set(['w1']))).toBe(true);
  });
  it('null clears; valid input normalizes', () => {
    expect(normalizeTeamCodingPolicy(null)).toEqual({ value: null });
    expect(normalizeTeamCodingPolicy({ team: { allowedBackends: ['claude', 'claude'] } })).toEqual({ value: { team: { allowedBackends: ['claude'] } } });
  });
});
