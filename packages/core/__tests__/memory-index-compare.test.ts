/**
 * The flag on/off comparison over the golden queries (task caa30c0f): the
 * index must not lose a relevant memory at the default budget, and must cost
 * fewer bytes than the bodies it replaces.
 */
import { describe, it, expect } from 'bun:test';
import { compareMemoryIndex, compareQuery, synthesizeMemories, formatComparison } from '../scripts/memory-index-compare';
import { loadGoldenQueries } from '../scripts/eval-memory-index';

describe('memory index comparison', () => {
  const queries = loadGoldenQueries();

  it('loads the golden query set', () => {
    expect(queries.length).toBeGreaterThan(5);
  });

  it('is deterministic', () => {
    expect(synthesizeMemories(queries[0])).toEqual(synthesizeMemories(queries[0]));
    expect(compareQuery(queries[0])).toEqual(compareQuery(queries[0]));
  });

  it('recall@k is unchanged at the default budget', () => {
    const r = compareMemoryIndex(queries);
    expect(r.totals.meanRecallOn).toBe(r.totals.meanRecallOff);
    expect(r.queries.every(q => q.recallOn === q.recallOff)).toBe(true);
  });

  it('saves prompt bytes on both surfaces, pulls included', () => {
    const { totals } = compareMemoryIndex(queries);
    expect(totals.runnerBytesOn).toBeLessThan(totals.runnerBytesOff);
    expect(totals.replyBytesOn).toBeLessThan(totals.replyBytesOff);
    expect(totals.runnerBytesOnWithPulls).toBeGreaterThan(totals.runnerBytesOn);
    expect(formatComparison(compareMemoryIndex(queries))).toContain('recall@k');
  });

  it('a starved budget shows up as lost recall, not as a silent win', () => {
    const { totals } = compareMemoryIndex(queries, 40);
    expect(totals.meanRecallOn).toBeLessThan(totals.meanRecallOff);
  });
});
