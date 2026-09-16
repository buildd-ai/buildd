import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * `tasks.kind` is written at most once, by whichever of filer → worker → PR-open
 * reaches it first (Rule K2-20). The guard is a single atomic
 * `UPDATE ... WHERE id = $1 AND kind IS NULL`, not a read-then-write, so the
 * invariant holds across the three sources without a clobber rule between them.
 */

/** Rows the fake UPDATE reports as changed — empty means the guard matched nothing. */
let updateReturns: Array<{ id: string }> = [];
/** Every WHERE predicate the update was built with, so the guard itself is assertable. */
let whereCalls: any[] = [];
let setCalls: any[] = [];

mock.module('drizzle-orm', () => ({
  eq: (col: any, val: any) => ({ _op: 'eq', col, val }),
  and: (...args: any[]) => ({ _op: 'and', args }),
  isNull: (col: any) => ({ _op: 'isNull', col }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'tasks.id', kind: 'tasks.kind' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (data: any) => {
        setCalls.push(data);
        return {
          where: (w: any) => {
            whereCalls.push(w);
            return { returning: () => Promise.resolve(updateReturns) };
          },
        };
      },
    }),
  },
}));

import { stampTaskKindIfAbsent, isTaskKind, TASK_KINDS } from './task-kind';

beforeEach(() => {
  updateReturns = [{ id: 'task-1' }];
  whereCalls = [];
  setCalls = [];
});

describe('stampTaskKindIfAbsent', () => {
  it('guards the write on kind IS NULL in SQL, not in application code', () => {
    // A read-then-write would let two late signals interleave between the read
    // and the write; the guard has to be in the statement.
    return stampTaskKindIfAbsent('task-1', 'engineering').then(wrote => {
      expect(wrote).toBe(true);
      expect(setCalls[0].kind).toBe('engineering');
      const predicate = JSON.stringify(whereCalls[0]);
      expect(predicate).toContain('isNull');
      expect(predicate).toContain('tasks.kind');
    });
  });

  it('AC-12 (rejection): a no-op is success, not an error, when the row already had a kind', async () => {
    updateReturns = [];
    expect(await stampTaskKindIfAbsent('task-1', 'engineering')).toBe(false);
  });

  it('AC-13: only the FIRST reporter wins; the second call returns success', async () => {
    expect(await stampTaskKindIfAbsent('task-1', 'analysis')).toBe(true);
    updateReturns = [];  // the row is no longer NULL
    expect(await stampTaskKindIfAbsent('task-1', 'engineering')).toBe(false);
    // Nothing threw, and nothing set kind to 'engineering' on a matched row.
    expect(setCalls.map(s => s.kind)).toEqual(['analysis', 'engineering']);
  });

  it('does nothing at all without a task id', async () => {
    expect(await stampTaskKindIfAbsent(null, 'engineering')).toBe(false);
    expect(await stampTaskKindIfAbsent(undefined, 'engineering')).toBe(false);
    expect(setCalls).toHaveLength(0);
  });
});

describe('isTaskKind', () => {
  it('accepts exactly the seven values and nothing else', () => {
    expect(TASK_KINDS).toHaveLength(7);
    for (const k of TASK_KINDS) expect(isTaskKind(k)).toBe(true);
    for (const bad of ['refactor', 'Engineering', '', null, undefined, 7, {}]) {
      expect(isTaskKind(bad)).toBe(false);
    }
  });
});

describe('stampTaskKindIfAbsent — failure containment', () => {
  it('never throws into the caller: the PR is already open by the time this fires', async () => {
    // A legibility column must not be able to fail a request whose real
    // contract is something else. Same property recordGateEvent holds.
    mock.module('@buildd/core/db', () => ({
      db: { update: () => { throw new Error('connection reset'); } },
    }));
    const { stampTaskKindIfAbsent: stamp } = await import('./task-kind');
    expect(await stamp('task-1', 'engineering')).toBe(false);
  });
});
