import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Spec 75217f55 R-4 / AC-7: the maintenance cron strips the overlap edges the
// platform guessed (pathDeclaration.inferredDependsOn) off pending tasks and
// wakes them; declared edges stay. The SQL itself is pinned on real Postgres in
// apps/web/tests/db/guessed-edge-strip.test.ts.

type Row = { id: string; status: string; taskClass: string | null; conflictRetryPrNumber: number | null; dependsOn: string[] | null; pathDeclaration: any };
let pending: Row[] = [];
// Rows whose stored state changed after the sweep read them: their CAS misses.
let editedUnderneath = new Set<string>();
const writes: Array<{ id: string; set: any }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => pending }) }) }),
    update: () => ({
      set: (set: any) => ({
        where: (w: { id: string }) => ({
          returning: async () => {
            if (editedUnderneath.has(w.id)) return [];
            writes.push({ id: w.id, set });
            return [{ id: w.id }];
          },
        }),
      }),
    }),
  },
}));
mock.module('drizzle-orm', () => ({
  and: (...c: any[]) => c.find((x: any) => x?.id) ?? { c },
  eq: (_a: any, b: any) => ({ id: b }),
  sql: Object.assign((..._a: any[]) => ({}), { raw: () => ({}) }),
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', taskClass: 'taskClass', conflictRetryPrNumber: 'conflictRetryPrNumber', dependsOn: 'dependsOn', pathDeclaration: 'pathDeclaration' },
}));
const woken: Array<{ ids: readonly string[]; cause: string }> = [];
mock.module('@/lib/dispatch-authority', () => ({
  wakeTasks: async (ids: readonly string[], cause: string) => { woken.push({ ids, cause }); },
}));

const { stripGuessedEdges, sweepGuessedEdges } = await import('./guessed-edges');

const base = (over: Partial<Row>): Row => ({ id: 't', status: 'pending', taskClass: 'work', conflictRetryPrNumber: null, dependsOn: [], pathDeclaration: null, ...over });

beforeEach(() => {
  pending = [];
  editedUnderneath = new Set();
  writes.length = 0;
  woken.length = 0;
});

describe('stripGuessedEdges', () => {
  it('AC-7: one declared and two guessed edges leave only the declared one', () => {
    const decl = { declared: ['apps/web/src/x.ts'], inferredDependsOn: ['g1', 'g2'], overlapPolicy: 'v2', softOverlaps: [{ taskId: 's', paths: ['apps'], kind: 'prefix' }] };
    const next = stripGuessedEdges(base({ dependsOn: ['declared', 'g1', 'g2'], pathDeclaration: decl }));
    expect(next).toEqual({
      dependsOn: ['declared'],
      pathDeclaration: { declared: ['apps/web/src/x.ts'], inferredDependsOn: [], overlapPolicy: 'v2' },
    });
  });

  it('a stripped row has nothing left to strip', () => {
    const next = stripGuessedEdges(base({ dependsOn: ['d', 'g'], pathDeclaration: { inferredDependsOn: ['g'], softOverlaps: [] } }))!;
    expect(stripGuessedEdges(base(next))).toBeNull();
  });

  it('never touches declared edges, even with no declaration at all', () => {
    expect(stripGuessedEdges(base({ dependsOn: ['d1', 'd2'] }))).toBeNull();
    expect(stripGuessedEdges(base({ dependsOn: ['d1'], pathDeclaration: { overlapPolicy: 'v2', inferredDependsOn: [] } }))).toBeNull();
  });

  it('clears soft overlaps on their own', () => {
    expect(stripGuessedEdges(base({ dependsOn: ['d'], pathDeclaration: { overlapPolicy: 'v2', softOverlaps: [{ taskId: 'h', paths: [], kind: 'legacy_inferred' }] } })))
      .toEqual({ dependsOn: ['d'], pathDeclaration: { overlapPolicy: 'v2', inferredDependsOn: [] } });
  });

  it('a recorded guess already gone from dependsOn is still cleared from the record', () => {
    expect(stripGuessedEdges(base({ dependsOn: ['d'], pathDeclaration: { inferredDependsOn: ['g'] } })))
      .toEqual({ dependsOn: ['d'], pathDeclaration: { inferredDependsOn: [] } });
  });

  it('legacy conflict attempts (no overlapPolicy) have only guessed edges, by the 0276 rule', () => {
    const legacy = base({ taskClass: 'attempt', conflictRetryPrNumber: 42, dependsOn: ['h1', 'h2'] });
    expect(stripGuessedEdges(legacy)).toEqual({ dependsOn: [], pathDeclaration: { overlapPolicy: 'v2', inferredDependsOn: [] } });
    // Even when the declaration recorded only some of them.
    expect(stripGuessedEdges({ ...legacy, pathDeclaration: { inferredDependsOn: ['h1'] } }))
      .toEqual({ dependsOn: [], pathDeclaration: { overlapPolicy: 'v2', inferredDependsOn: [] } });
  });

  it('v2 attempts and non-conflict attempts keep their untagged edges', () => {
    expect(stripGuessedEdges(base({ taskClass: 'attempt', conflictRetryPrNumber: 42, dependsOn: ['d'], pathDeclaration: { overlapPolicy: 'v2' } }))).toBeNull();
    expect(stripGuessedEdges(base({ taskClass: 'attempt', dependsOn: ['d'] }))).toBeNull();
    expect(stripGuessedEdges(base({ taskClass: 'work', conflictRetryPrNumber: 42, dependsOn: ['d'] }))).toBeNull();
  });

  it('leaves non-pending rows alone', () => {
    expect(stripGuessedEdges(base({ status: 'in_progress', dependsOn: ['g'], pathDeclaration: { inferredDependsOn: ['g'] } }))).toBeNull();
  });
});

describe('sweepGuessedEdges', () => {
  it('AC-7: writes the stripped row, wakes it with dependency.satisfied, and a second run writes nothing', async () => {
    const row = base({ id: 'a', dependsOn: ['declared', 'g1', 'g2'], pathDeclaration: { inferredDependsOn: ['g1', 'g2'] } });
    pending = [row];
    expect(await sweepGuessedEdges()).toBe(1);
    expect(writes).toEqual([{ id: 'a', set: { dependsOn: ['declared'], pathDeclaration: { inferredDependsOn: [] } } }]);
    expect(woken).toEqual([{ ids: ['a'], cause: 'dependency.satisfied' }]);

    // The next run reads the row as written.
    pending = [{ ...row, ...writes[0].set }];
    writes.length = 0;
    woken.length = 0;
    expect(await sweepGuessedEdges()).toBe(0);
    expect(writes).toEqual([]);
    expect(woken).toEqual([]);
  });

  it('a concurrent edit wins: the CAS misses, nothing is counted or woken, and the row is retried next run', async () => {
    pending = [
      base({ id: 'raced', dependsOn: ['g'], pathDeclaration: { inferredDependsOn: ['g'] } }),
      base({ id: 'clean', dependsOn: ['g'], pathDeclaration: { inferredDependsOn: ['g'] } }),
    ];
    editedUnderneath = new Set(['raced']);
    expect(await sweepGuessedEdges()).toBe(1);
    expect(woken).toEqual([{ ids: ['clean'], cause: 'dependency.satisfied' }]);

    editedUnderneath = new Set();
    pending = [pending[0]];
    expect(await sweepGuessedEdges()).toBe(1);
    expect(woken.at(-1)).toEqual({ ids: ['raced'], cause: 'dependency.satisfied' });
  });

  it('a failing read is logged and reads as nothing changed', async () => {
    pending = null as never; // the stubbed select hands back something unusable
    expect(await sweepGuessedEdges()).toBe(0);
  });
});
