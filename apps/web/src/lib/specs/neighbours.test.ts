import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { MAX_SIMILAR, neighbourReason, pickSimilar, sharedFileNeighbours } = await import('./neighbours');

describe('pickSimilar', () => {
  it('drops itself and its relatives, at most MAX_SIMILAR, strongest first (the floor is the knowledge store\'s)', () => {
    const hits = [
      { specId: 'self', score: 0.99, source: 'vector' as const },
      { specId: 'parent', score: 0.9, source: 'vector' as const },
      ...Array.from({ length: 7 }, (_, i) => ({ specId: `s${i}`, score: 0.6 + i / 100, source: 'vector' as const })),
    ];
    const rows = pickSimilar(hits, new Set(['self', 'parent']));
    expect(rows).toHaveLength(MAX_SIMILAR);
    expect(rows.map((r) => r.neighborSpecId)).toEqual(['s6', 's5', 's4', 's3', 's2']);
    expect(rows.every((r) => r.source === 'vector')).toBe(true);
  });

  it('keeps the criterion pair and the chunks it matched (R-102, AC-138)', () => {
    expect(pickSimilar([{ specId: 'a', score: 0.8, source: 'vector', pair: { here: 'AC-3', there: 'R-7' }, chunkIds: ['c1'] }], new Set())).toEqual([
      { neighborSpecId: 'a', score: 0.8, source: 'vector', detail: { pair: { here: 'AC-3', there: 'R-7' }, chunks: ['c1'] } },
    ]);
  });
});

describe('sharedFileNeighbours', () => {
  it('scores by the shared share of the smaller set, names a sample, and is pr_files only when both sides are', () => {
    const rows = sharedFileNeighbours(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], source: 'pr_files' },
      [
        { specId: 'x', files: ['a.ts', 'b.ts'], source: 'pr_files' },
        { specId: 'y', files: ['c.ts', 'z.ts', 'q.ts', 'r.ts'], source: 'path_manifest' },
        { specId: 'none', files: ['zz.ts'], source: 'pr_files' },
      ],
    );
    expect(rows.map((r) => [r.neighborSpecId, r.score, r.source, r.detail])).toEqual([
      ['x', 1, 'pr_files', { files: 2, sample: ['a.ts', 'b.ts'] }],
      ['y', 0.25, 'path_manifest', { files: 1, sample: ['c.ts'] }],
    ]);
  });

  it('a spec whose work changed nothing has no file neighbours', () => {
    expect(sharedFileNeighbours({ files: [], source: 'path_manifest' }, [{ specId: 'x', files: ['a.ts'], source: 'pr_files' }])).toEqual([]);
  });
});

describe('neighbourReason', () => {
  it('says why in words', () => {
    expect(neighbourReason('similar', null)).toBe('Similar in what it asks for');
    // AC-139: a criterion-level match is the reason.
    expect(neighbourReason('similar', { pair: { here: 'AC-3', there: 'R-7' } })).toBe('AC-3 here reads like R-7 there');
    expect(neighbourReason('shares_files', { files: 1 })).toBe("Changes a file this spec's work changed");
    expect(neighbourReason('shares_files', { files: 3 })).toBe("Changes 3 files this spec's work changed");
    expect(neighbourReason('overlaps', { pairs: [{ here: 'AC-2', there: 'AC-4' }] })).toBe('AC-2 here matches AC-4 there');
    expect(neighbourReason('overlaps', { pairs: [{ here: 'AC-2', there: 'AC-4' }, { here: 'R-1', there: 'R-3' }] })).toBe('AC-2 here matches AC-4 there, and 1 more');
    expect(neighbourReason('overlaps', {})).toBe('Shares some of what it asks for');
    expect(neighbourReason('overlaps', { relation: 'duplicate' })).toBe('Asks for the same things');
  });
});
