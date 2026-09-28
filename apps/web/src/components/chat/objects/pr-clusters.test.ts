import { describe, expect, it } from 'bun:test';
import type { BuilddObjectRef } from '../chat-contract';
import { prClusters } from './pr-clusters';

const pr = (n: number, over: Partial<Extract<BuilddObjectRef, { kind: 'pr' }>> = {}): BuilddObjectRef => ({
  kind: 'pr', id: `acme/web#${n}`, workspaceId: 'ws', repo: 'acme/web', prNumber: n, url: '', fallbackText: `#${n}`, ...over,
});

describe('prClusters', () => {
  it('groups by mission, then area, then Other; biggest first, Other last', () => {
    const c = prClusters([
      pr(1, { area: 'deps' }),
      pr(2, { missionId: 'm1', missionTitle: 'Multi-currency' }),
      pr(3),
      pr(4, { missionId: 'm1', missionTitle: 'Multi-currency' }),
      pr(5, { area: 'deps' }),
      pr(6, { missionId: 'm1', missionTitle: 'Multi-currency', area: 'fx' }),
    ]);
    expect(c.map(x => [x.label, x.refs.map(r => (r as { prNumber: number }).prNumber)])).toEqual([
      ['Multi-currency', [2, 4, 6]],
      ['deps', [1, 5]],
      ['Other', [3]],
    ]);
  });

  it('outside a mission, the task category groups before the area', () => {
    const c = prClusters([pr(1, { category: 'bug', area: 'fx' }), pr(2, { category: 'bug' }), pr(3, { area: 'fx' })]);
    expect(c.map(x => [x.label, x.refs.length])).toEqual([['Fixes', 2], ['fx', 1]]);
  });

  it('two missions with the same title stay apart by id', () => {
    const c = prClusters([pr(1, { missionId: 'a', missionTitle: 'Cleanup' }), pr(2, { missionId: 'b', missionTitle: 'Cleanup' })]);
    expect(c).toHaveLength(2);
  });

  it('nothing to group by: one Other group', () => {
    expect(prClusters([pr(1), pr(2)]).map(x => x.label)).toEqual(['Other']);
  });
});
