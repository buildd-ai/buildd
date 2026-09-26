import { describe, it, expect, beforeEach, mock } from 'bun:test';

let rows: any[] = [];
let fail = false;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findMany: async () => { if (fail) throw new Error('down'); return rows; } },
      tasks: { findFirst: async () => { throw new Error('not a uuid'); } },
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => { throw new Error('down'); } }) }) }),
  },
}));

const { isStandardWorkspace, loadChatReach } = await import('./reach');

beforeEach(() => { rows = []; fail = false; });

describe('isStandardWorkspace', () => {
  it('is standard only when neither marker says sensitive', () => {
    expect(isStandardWorkspace({ dataClass: 'standard', gitConfig: null })).toBe(true);
    expect(isStandardWorkspace({ dataClass: 'sensitive', gitConfig: null })).toBe(false);
    expect(isStandardWorkspace({ dataClass: 'standard', gitConfig: { dataClass: 'sensitive' } })).toBe(false);
    expect(isStandardWorkspace({ dataClass: null })).toBe(false);
  });
});

describe('loadChatReach', () => {
  it('keeps the team\'s standard workspaces only', async () => {
    rows = [
      { id: 'a', dataClass: 'standard', gitConfig: null },
      { id: 'b', dataClass: 'sensitive', gitConfig: null },
      { id: 'c', dataClass: 'standard', gitConfig: { dataClass: 'sensitive' } },
    ];
    const reach = await loadChatReach('t-1');
    expect(reach.teamId).toBe('t-1');
    expect([...reach.workspaceIds]).toEqual(['a']);
  });

  it('fails closed: a lookup error reaches no workspace, and an owner lookup error is unknown', async () => {
    fail = true;
    const reach = await loadChatReach('t-1');
    expect(reach.workspaceIds.size).toBe(0);
    expect(await reach.ownerOf('task', 'x')).toBeNull();
    expect(await reach.ownerOf('mission', 'x')).toBeNull();
  });
});
