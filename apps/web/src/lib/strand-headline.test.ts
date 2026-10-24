import { describe, it, expect } from 'bun:test';
import { strandHeadline, withoutRunnerServedStrands, STRAND_FIX } from './strand-headline';

const NOW = '2026-10-19T10:00:00.000Z';
const blocked = { state: 'blocked', kind: 'credential_unavailable', reason: 'provider_unavailable', phrase: 'x', evaluatedAt: NOW } as const;
const stale = { ...blocked, state: 'stale' } as const;
const unknown = { state: 'unknown', kind: null, reason: null, phrase: null, evaluatedAt: null } as const;
const capacity = { ...blocked, kind: 'capacity_exhausted', reason: 'workspace_cap' } as const;
const row = (claims: Array<any>, opts: { pinned?: boolean; enabledForTeam?: boolean } = {}) => ({
  label: 'Codex', strandedPending: claims.length, enabledForTeam: opts.enabledForTeam ?? true,
  sampleTasks: claims.map((claim, i) => ({
    id: `t${i}`, title: `T${i}`, workspaceName: null, claim,
    route: { requested: 'codex', effective: 'codex', pinned: opts.pinned ?? false },
  })),
});

describe('strandHeadline (spec R-10)', () => {
  it('says "blocked" only on a fresh scheduler credential refusal', () => {
    const h = strandHeadline(row([blocked, unknown]));
    expect(h.confirmed).toBe(true);
    expect(h.title).toBe('No Codex sign-in');
    expect(h.tag).toBe('2 tasks blocked');
  });
  it('does not assert a block when every sample is unknown', () => {
    const h = strandHeadline(row([unknown]));
    expect(h.confirmed).toBe(false);
    expect(h.tag).toBe('1 task waiting');
    expect(h.detail).toContain('Not confirmed by the scheduler');
  });
  it('does not assert a block when the refusal is stale', () => {
    const h = strandHeadline(row([stale]));
    expect(h.confirmed).toBe(false);
    expect(h.detail).toContain('stale');
  });
  it('a capacity refusal is not a credential block', () => {
    expect(strandHeadline(row([capacity])).confirmed).toBe(false);
  });
  it('samples absent entirely read as unconfirmed', () => {
    expect(strandHeadline(row([])).confirmed).toBe(false);
  });
  it('a task pinned to the backend is named as pinned, with no advice to reroute it', () => {
    const h = strandHeadline(row([blocked], { pinned: true }));
    expect(h.detail).toBe('Pinned to Codex. Sign in to Codex on a runner or add a key in Models.');
  });
  it('unpinned work may be rerouted by turning the backend off, only while it is on', () => {
    expect(strandHeadline(row([blocked])).detail)
      .toBe('Sign in to Codex on a runner, add a key in Models, or turn Codex off to reroute.');
    expect(strandHeadline(row([blocked], { enabledForTeam: false })).detail)
      .toBe('Sign in to Codex on a runner or add a key in Models.');
  });
  it('the fix goes to Models, where model sign-ins and keys live', () => {
    expect(STRAND_FIX).toEqual({ href: '/app/settings/models', label: 'Connect in Models' });
  });
});

describe('withoutRunnerServedStrands', () => {
  const now = Date.parse(NOW);
  const strands = [{ backend: 'codex' }, { backend: 'gemini' }];
  const beat = (codexAuthSource: string | null, ageMs = 30_000) =>
    ({ lastHeartbeatAt: new Date(now - ageMs).toISOString(), codexAuthSource }) as any;

  it('drops Codex when an online runner reports its own Codex login, as the claim route accepts one', () => {
    expect(withoutRunnerServedStrands(strands, [beat('machine_login')], now)).toEqual([{ backend: 'gemini' }]);
    expect(withoutRunnerServedStrands(strands, [beat('api_key')], now)).toEqual([{ backend: 'gemini' }]);
  });
  it('keeps Codex when no runner has a Codex login, or the one that has is offline', () => {
    expect(withoutRunnerServedStrands(strands, [beat('none'), beat(null)], now)).toEqual(strands);
    expect(withoutRunnerServedStrands(strands, [beat('machine_login', 24 * 3600_000)], now)).toEqual(strands);
  });
});
