import { describe, it, expect, beforeEach, mock } from 'bun:test';

let selectRows: any[][] = [];
let inserted: any[] = [];
let insertCalls = 0;

function chain(): any {
  const p: any = {
    from: () => p,
    where: () => p,
    values: (v: any) => { inserted.push(...v); return p; },
    onConflictDoNothing: () => p,
    returning: () => Promise.resolve(inserted.map((_, i) => ({ id: `r${i}` }))),
    then: (res: any, rej: any) => Promise.resolve(selectRows.shift() ?? []).then(res, rej),
  };
  return p;
}

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => chain(),
    insert: () => { insertCalls++; return chain(); },
  },
}));

const { recordPrReverts } = await import('./pr-reverts');

beforeEach(() => { selectRows = []; inserted = []; insertCalls = 0; });

describe('recordPrReverts', () => {
  it('text with no revert reference touches nothing', async () => {
    expect(await recordPrReverts({ repoFullName: 'acme/widgets', revertedBy: 'pr#2', text: 'feat: things (#1)' })).toBe(0);
    expect(insertCalls).toBe(0);
  });

  it('writes one row per reference for every workspace bound to the repo', async () => {
    selectRows = [[{ id: 'repo-1' }], [{ id: 'ws-a' }, { id: 'ws-b' }]];
    const n = await recordPrReverts({ repoFullName: 'acme/widgets', revertedBy: 'pr#9', revertingPrNumber: 9, text: 'Reverts acme/widgets#5' });
    expect(n).toBe(2);
    expect(inserted.map(r => [r.workspaceId, r.revertedPrNumber, r.dedupeKey])).toEqual([
      ['ws-a', 5, 'pr#9>pr#5'],
      ['ws-b', 5, 'pr#9>pr#5'],
    ]);
  });

  it('an unlinked repo writes nothing', async () => {
    selectRows = [[]];
    expect(await recordPrReverts({ repoFullName: 'acme/widgets', revertedBy: 'c1', text: 'This reverts commit abcdef1.' })).toBe(0);
    expect(insertCalls).toBe(0);
  });
});
