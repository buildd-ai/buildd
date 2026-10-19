import { describe, it, expect } from 'bun:test';
import { strandHeadline } from './strand-headline';

const NOW = '2026-10-19T10:00:00.000Z';
const blocked = { state: 'blocked', kind: 'credential_unavailable', reason: 'provider_unavailable', phrase: 'x', evaluatedAt: NOW } as const;
const stale = { ...blocked, state: 'stale' } as const;
const unknown = { state: 'unknown', kind: null, reason: null, phrase: null, evaluatedAt: null } as const;
const capacity = { ...blocked, kind: 'capacity_exhausted', reason: 'workspace_cap' } as const;
const row = (claims: Array<any>) => ({
  label: 'Codex', strandedPending: claims.length,
  sampleTasks: claims.map((claim, i) => ({ id: `t${i}`, title: `T${i}`, workspaceName: null, claim })),
});

describe('strandHeadline (spec R-10)', () => {
  it('says "has no credential / unclaimable" only on a fresh scheduler credential refusal', () => {
    const h = strandHeadline(row([blocked, unknown]));
    expect(h.confirmed).toBe(true);
    expect(h.title).toBe('Codex has no credential');
    expect(h.tag).toContain('unclaimable');
  });
  it('does not assert a block when every sample is unknown', () => {
    const h = strandHeadline(row([unknown, unknown]));
    expect(h.confirmed).toBe(false);
    expect(h.title).not.toContain('has no credential');
    expect(h.tag).not.toContain('unclaimable');
    expect(h.detail).not.toContain('no runner can claim');
    expect(h.detail).toContain('not confirmed');
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
});
