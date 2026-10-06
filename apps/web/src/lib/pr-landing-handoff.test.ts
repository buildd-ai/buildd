import { describe, it, expect } from 'bun:test';
import { resolveLandingOwnership, policyLandsAutomatically } from './pr-landing-handoff';

const HEAD = 'a'.repeat(40);
const marker = { prNumber: 7, pendingHeadSha: 'b'.repeat(40), refreshCount: 1, lastOutcome: 'updating_branch' };
const base = {
  policy: { tier: 'agent-review' as const, agentReview: { gateCondition: 'approve-and-merge' as const } },
  landingMode: 'enforce' as const,
  landing: null as unknown,
  handoff: null as unknown,
  prNumber: 7,
  currentHeadSha: HEAD,
};

describe('resolveLandingOwnership', () => {
  it('A: approve-and-merge under enforce is platform-owned before any refresh', () => {
    expect(resolveLandingOwnership(base)).toMatchObject({ owner: 'platform', state: 'landing' });
  });
  it('A: a refresh marker keeps it platform-owned on the new head', () => {
    expect(resolveLandingOwnership({ ...base, landing: marker, currentHeadSha: 'b'.repeat(40) }))
      .toMatchObject({ owner: 'platform', state: 'refreshing' });
  });
  it('B: a handoff bound to the current head is the human\'s, with its reason', () => {
    const handoff = { prNumber: 7, headSha: HEAD, cause: 'branch_protection', reason: 'Branch protection needs a reviewer' };
    expect(resolveLandingOwnership({ ...base, handoff })).toEqual({ owner: 'human', reason: 'Branch protection needs a reviewer' });
  });
  it('a handoff for an older head is invalidated by a base refresh', () => {
    const handoff = { prNumber: 7, headSha: 'c'.repeat(40), cause: 'size_cap', reason: 'x' };
    expect(resolveLandingOwnership({ ...base, handoff }).owner).toBe('platform');
  });
  it('C/E: human tier, approve-only and auto-threshold are not reinterpreted', () => {
    expect(resolveLandingOwnership({ ...base, policy: { tier: 'human' } }).owner).toBe('unmanaged');
    expect(resolveLandingOwnership({ ...base, policy: { tier: 'agent-review', agentReview: { gateCondition: 'approve-only' } } }).owner).toBe('unmanaged');
    expect(resolveLandingOwnership({ ...base, policy: { tier: 'auto-threshold' } }).owner).toBe('unmanaged');
  });
  it('shadow and off leave the legacy reading in charge', () => {
    expect(resolveLandingOwnership({ ...base, landingMode: 'shadow' }).owner).toBe('unmanaged');
    expect(resolveLandingOwnership({ ...base, landingMode: 'off' }).owner).toBe('unmanaged');
  });
  it('policyLandsAutomatically defaults gateCondition to approve-and-merge', () => {
    expect(policyLandsAutomatically({ tier: 'agent-review' })).toBe(true);
  });
});
