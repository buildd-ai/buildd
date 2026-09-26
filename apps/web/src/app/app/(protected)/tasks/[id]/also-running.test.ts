import { describe, it, expect } from 'bun:test';
import { isInTaskLineage, unresolvedParentIds, sidePanelPeers } from './also-running';

// Regression: the task page's "Also running" list named the task's own CI-fix
// attempt as a peer. An attempt (or the task it is fixing) is this task's own
// work, not something else running alongside it.
describe('isInTaskLineage', () => {
  // root ← task ← ciFix ← ciFixOfFix ;  root ← sibling
  const parentOf = new Map<string, string | null>([
    ['root', null],
    ['task', 'root'],
    ['ciFix', 'task'],
    ['ciFixOfFix', 'ciFix'],
    ['sibling', 'root'],
    ['stranger', null],
  ]);

  it("excludes the task's own CI-fix attempt (a child)", () => {
    expect(isInTaskLineage('ciFix', 'task', parentOf)).toBe(true);
  });

  it('excludes deeper descendants (a fix of the fix)', () => {
    expect(isInTaskLineage('ciFixOfFix', 'task', parentOf)).toBe(true);
  });

  it('excludes ancestors (the task a fix attempt is fixing)', () => {
    expect(isInTaskLineage('task', 'ciFix', parentOf)).toBe(true);
    expect(isInTaskLineage('root', 'ciFixOfFix', parentOf)).toBe(true);
  });

  it('excludes the task itself', () => {
    expect(isInTaskLineage('task', 'task', parentOf)).toBe(true);
  });

  it('keeps siblings and unrelated tasks — those are genuine peers', () => {
    expect(isInTaskLineage('sibling', 'task', parentOf)).toBe(false);
    expect(isInTaskLineage('stranger', 'task', parentOf)).toBe(false);
  });

  it('terminates on a parent cycle', () => {
    const cyclic = new Map<string, string | null>([['a', 'b'], ['b', 'a'], ['c', null]]);
    expect(isInTaskLineage('c', 'a', cyclic)).toBe(false);
  });
});

describe('sidePanelPeers', () => {
  const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    status: 'running',
    milestones: [{ type: 'status', progress: 40 }],
    task: { id, title, label: null, missionId: 'm1' },
    ...extra,
  });

  // Regression (demo reshoot, merged step): a dependent that had been claimed
  // was listed under both "Also running" and "Unblocked by this". The rule: a
  // task that depends on this one is shown once, under "Unblocked by this",
  // the more specific relation, which also carries the claim status.
  it('drops tasks already listed as unblocked by this one', () => {
    const peers = sidePanelPeers([row('email', 'feat(email): receipts'), row('checkout', 'feat(checkout): pay')], {
      missionId: 'm1',
      excludeTaskIds: new Set(['email']),
    });
    expect(peers.map(p => p.taskId)).toEqual(['checkout']);
  });

  // Regression: one peer read "RESEARCH: FX rate providers…" in raw caps
  // while the rest read "feat(...)…". Every peer is drawn with the same
  // scope + short label the Board uses.
  it('names every peer by its display label, not its raw title', () => {
    const peers = sidePanelPeers([
      row('fx', 'RESEARCH: FX rate providers and caching'),
      row('checkout', 'x', { task: { id: 'checkout', title: 'feat(checkout): pay in the customer currency', label: 'Stripe in currency', missionId: 'm1' } }),
    ], { missionId: 'm1', excludeTaskIds: new Set() });
    expect(peers.find(p => p.taskId === 'checkout')).toMatchObject({ scope: 'checkout', title: 'Stripe in currency' });
    const fx = peers.find(p => p.taskId === 'fx')!;
    expect(fx.title).not.toMatch(/^RESEARCH/);
    expect(fx.title).not.toContain(':');
  });

  it('keeps only the same mission, one row per task, with the latest progress', () => {
    const peers = sidePanelPeers([
      row('a', 'feat(a): one', { milestones: [{ type: 'status', progress: 10 }, { type: 'status', progress: 55 }] }),
      row('a', 'feat(a): one'),
      row('other', 'x', { task: { id: 'other', title: 'feat(b): two', label: null, missionId: 'm2' } }),
    ], { missionId: 'm1', excludeTaskIds: new Set() });
    expect(peers.map(p => [p.taskId, p.pct])).toEqual([['a', 55]]);
  });
});

describe('unresolvedParentIds', () => {
  it('lists parents referenced but not yet loaded', () => {
    const parentOf = new Map<string, string | null>([['a', 'b'], ['c', 'a'], ['d', null]]);
    expect(unresolvedParentIds(parentOf)).toEqual(['b']);
  });
});
