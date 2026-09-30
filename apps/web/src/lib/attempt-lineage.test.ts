import { describe, it, expect } from 'bun:test';
import { collectLineage, lineageStamp, LINEAGE_MAX_TASKS } from './attempt-lineage';

describe('lineageStamp', () => {
  it('roots a chain at the task that opened the PR', () => {
    expect(lineageStamp({ id: 'root', context: { prNumber: 4 } }, [4])).toEqual({ rootTaskId: 'root', lineagePrNumbers: [4] });
  });

  it('carries the root and every PR forward, including a new-branch PR', () => {
    const first = lineageStamp({ id: 'root', context: {} }, [4]);
    const second = lineageStamp({ id: 'att1', context: { ...first, prNumber: 9 } }, [9]);
    expect(second.rootTaskId).toBe('root');
    expect(second.lineagePrNumbers).toEqual([4, 9]);
  });

  it('ignores missing PR numbers and does not duplicate', () => {
    expect(lineageStamp({ id: 'r', context: null }, [null, undefined, 3, 3]).lineagePrNumbers).toEqual([3]);
  });
});

type Row = { id: string; parentTaskId: string | null; taskClass: string | null };
const io = (rows: Row[]) => ({
  fetchTask: async (id: string) => rows.find(r => r.id === id) ?? null,
  fetchChildren: async (ids: string[]) => rows.filter(r => r.parentTaskId && ids.includes(r.parentTaskId)),
});

describe('collectLineage', () => {
  const rows: Row[] = [
    { id: 'root', parentTaskId: null, taskClass: null },
    { id: 'a1', parentTaskId: 'root', taskClass: 'attempt' },
    { id: 'a2', parentTaskId: 'a1', taskClass: 'attempt' },
    { id: 'sib', parentTaskId: 'root', taskClass: 'attempt' },
    { id: 'sub', parentTaskId: 'root', taskClass: null },
  ];

  it('reaches the whole chain from any member', async () => {
    for (const start of ['root', 'a1', 'a2', 'sib']) {
      const ids = (await collectLineage(start, io(rows))).map(r => r.id).sort();
      expect(ids).toEqual(['a1', 'a2', 'root', 'sib']);
    }
  });

  it('leaves out non-attempt children', async () => {
    expect((await collectLineage('root', io(rows))).map(r => r.id)).not.toContain('sub');
  });

  it('is empty for an unknown task', async () => {
    expect(await collectLineage('nope', io(rows))).toEqual([]);
  });

  it('terminates on a cycle and holds the size cap', async () => {
    const cyc: Row[] = [
      { id: 'x', parentTaskId: 'y', taskClass: 'attempt' },
      { id: 'y', parentTaskId: 'x', taskClass: 'attempt' },
    ];
    expect((await collectLineage('x', io(cyc))).length).toBeLessThanOrEqual(2);
    const wide: Row[] = [{ id: 'r', parentTaskId: null, taskClass: null }];
    for (let i = 0; i < LINEAGE_MAX_TASKS * 2; i++) wide.push({ id: `c${i}`, parentTaskId: 'r', taskClass: 'attempt' });
    expect((await collectLineage('r', io(wide))).length).toBeLessThanOrEqual(LINEAGE_MAX_TASKS);
  });
});
