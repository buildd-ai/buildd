/**
 * The shared rule behind every read of the team-wide `{teamId}:memory`
 * namespace: keep a hit only when its memories row carries the caller's
 * project. See packages/core/memory-hit-scope.ts.
 */
import { describe, it, expect } from 'bun:test';
import {
  keepOwnProjectMemoryHits,
  memoryIdOfHit,
  memoryOverfetchTopK,
  queryOwnProjectMemory,
  memoryScopeFor,
  type MemoryHitScope,
} from '../memory-hit-scope';

const OWN = 'acme/widgets';
const FOREIGN = 'acme/other-thing';

function scope(rows: Record<string, string | null>, project: string | null = OWN) {
  const lookups: string[][] = [];
  const s: MemoryHitScope = {
    project,
    lookup: async (ids) => {
      lookups.push(ids);
      return { memories: ids.filter(id => id in rows).map(id => ({ id, project: rows[id] })) };
    },
  };
  return { s, lookups };
}

describe('keepOwnProjectMemoryHits', () => {
  const hits = [
    { id: 'own-1' },
    { id: 'foreign-1' },
    { id: 'digest-1' },
    { id: 'orphan-1' },
    { id: 'chunk-x', metadata: { memoryId: 'own-2' } },
  ];

  it('keeps own-project rows only, preserving order', async () => {
    const { s } = scope({ 'own-1': OWN, 'foreign-1': FOREIGN, 'digest-1': null, 'own-2': OWN });
    const kept = await keepOwnProjectMemoryHits(hits, s);
    expect(kept.map(h => h.id)).toEqual(['own-1', 'chunk-x']);
  });

  it('compares canonical project keys', async () => {
    const { s } = scope({ 'own-1': 'https://github.com/Acme/Widgets.git' });
    expect((await keepOwnProjectMemoryHits([{ id: 'own-1' }], s)).length).toBe(1);
  });

  it('returns nothing, without a lookup, when there is no project', async () => {
    const { s, lookups } = scope({ 'own-1': OWN }, null);
    expect(await keepOwnProjectMemoryHits(hits, s)).toEqual([]);
    expect(await keepOwnProjectMemoryHits(hits, null)).toEqual([]);
    expect(lookups).toHaveLength(0);
  });

  it('resolves the memory id from metadata.memoryId, else the chunk id', () => {
    expect(memoryIdOfHit({ id: 'c', metadata: { memoryId: 'm' } })).toBe('m');
    expect(memoryIdOfHit({ id: 'c' })).toBe('c');
  });
});

describe('queryOwnProjectMemory', () => {
  it('over-fetches the team namespace, narrows, and trims to topK', async () => {
    const asked: Array<{ ns: string; topK?: number }> = [];
    const store = {
      query: async (ns: string, p: { text: string; topK?: number }) => {
        asked.push({ ns, topK: p.topK });
        return ['f1', 'o1', 'f2', 'o2', 'o3'].map(id => ({ id } as any));
      },
    };
    const { s } = scope({ o1: OWN, o2: OWN, o3: OWN, f1: FOREIGN, f2: FOREIGN });
    const out = await queryOwnProjectMemory(store, 'team-1', s, { text: 'q', topK: 2 });
    expect(asked).toEqual([{ ns: 'team-1:memory', topK: memoryOverfetchTopK(2) }]);
    expect(out.map(r => r.id)).toEqual(['o1', 'o2']);
  });

  it('does not query at all without a scope', async () => {
    let called = false;
    const store = { query: async () => { called = true; return []; } };
    expect(await queryOwnProjectMemory(store, 'team-1', null, { text: 'q', topK: 3 })).toEqual([]);
    expect(called).toBe(false);
  });

  it('returns [] when the store or the lookup throws', async () => {
    const bad = { query: async () => { throw new Error('down'); } };
    const { s } = scope({});
    expect(await queryOwnProjectMemory(bad, 'team-1', s, { text: 'q', topK: 3 })).toEqual([]);
    const ok = { query: async () => [{ id: 'o1' } as any] };
    const throwing: MemoryHitScope = { project: OWN, lookup: async () => { throw new Error('db'); } };
    expect(await queryOwnProjectMemory(ok, 'team-1', throwing, { text: 'q', topK: 3 })).toEqual([]);
  });
});

describe('memoryScopeFor', () => {
  it('returns an explicit scope or explicit null untouched', async () => {
    const { s } = scope({});
    expect(await memoryScopeFor(s, 'ws', 'team')).toBe(s);
    expect(await memoryScopeFor(null, 'ws', 'team')).toBeNull();
  });

  it('resolves to null when there is no workspace or team to resolve', async () => {
    expect(await memoryScopeFor(undefined, null, 'team')).toBeNull();
    expect(await memoryScopeFor(undefined, 'ws', null)).toBeNull();
  });
});

describe('memoryOverfetchTopK', () => {
  it('over-fetches 5x, capped at 100', () => {
    expect(memoryOverfetchTopK(3)).toBe(15);
    expect(memoryOverfetchTopK(50)).toBe(100);
  });
});
