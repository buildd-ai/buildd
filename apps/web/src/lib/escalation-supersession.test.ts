import { describe, expect, it, mock } from 'bun:test';

mock.module('drizzle-orm', () => ({
  eq: (field: unknown, value: unknown) => ({ type: 'eq', field, value }),
  inArray: (field: unknown, values: unknown[]) => ({ type: 'inArray', field, values }),
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
}));

import { supersedeAncestorEscalations } from './escalation-supersession';

function makeDb(parents: Record<string, string | null>, parentResponses = Object.values(parents)) {
  const updates: Array<{ values: Record<string, unknown>; condition: unknown }> = [];
  let responseIndex = 0;
  const findTask = mock(() => {
    const parentTaskId = parentResponses[responseIndex++] ?? null;
    return Promise.resolve({ parentTaskId });
  });
  return {
    updates,
    findTask,
    db: {
      query: {
        tasks: {
          findFirst: findTask,
        },
      },
      update: mock(() => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            updates.push({ values, condition });
            return Promise.resolve();
          },
        }),
      })),
    },
  };
}

describe('supersedeAncestorEscalations', () => {
  it('supersedes the immediate parent hold with the replacement PR pointer', async () => {
    const { db, updates } = makeDb({ parent: null });

    await supersedeAncestorEscalations(db as any, 'parent', 1437);

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      status: 'superseded',
      supersededByPrNumber: 1437,
    });
  });

  it('is generation-safe across a two-retry chain', async () => {
    const { db, updates, findTask } = makeDb(
      { retry1: 'original', original: null },
      [null, 'original', null],
    );

    // Retry #1 supersedes the original. Retry #2 then walks retry #1 -> original,
    // but the status=open predicate means the original pointer is never rewritten.
    await supersedeAncestorEscalations(db as any, 'original', 1437);
    await supersedeAncestorEscalations(db as any, 'retry1', 1444);

    expect(updates).toHaveLength(2);
    expect(updates[0].values.supersededByPrNumber).toBe(1437);
    expect(updates[1].values.supersededByPrNumber).toBe(1444);
    expect(findTask).toHaveBeenCalledTimes(3);
  });

  it('does nothing when there is no parent task edge', async () => {
    const { db, updates } = makeDb({});
    await supersedeAncestorEscalations(db as any, null, 1437);
    expect(updates).toHaveLength(0);
  });
});
