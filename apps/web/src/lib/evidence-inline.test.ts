import { describe, it, expect, beforeEach, mock } from 'bun:test';

let rows: any[];
let boom: boolean;
let findArgs: any;

mock.module('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  desc: (c: unknown) => ({ desc: c }),
}));
mock.module('@buildd/core/db/schema', () => ({
  evidenceObjects: new Proxy({}, { get: (_t, p) => `evidenceObjects.${String(p)}` }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      evidenceObjects: {
        findMany: async (args: any) => {
          findArgs = args;
          if (boom) throw new Error('db down');
          return rows;
        },
      },
    },
  },
}));

const audits: any[] = [];
mock.module('@/lib/evidence-audit', () => ({ auditEvidenceRead: (e: any) => { audits.push(e); } }));

const CTX = { surface: 'get_task' as const, actor: { accountId: 'acct-1' } };

const { loadInlineEvidence, INLINE_EVIDENCE_LIMIT } = await import('./evidence-inline');

beforeEach(() => {
  rows = [];
  boom = false;
  findArgs = undefined;
  audits.length = 0;
});

describe('loadInlineEvidence', () => {
  it('maps rows to pointers with no bucket detail', async () => {
    rows = [{ id: 'e1', taskId: 't1', kind: 'command_output', bytes: 10, uploadState: 'stored', createdAt: new Date('2026-09-01T00:00:00Z') }];
    expect(await loadInlineEvidence('ws', 't1', CTX)).toEqual([
      { id: 'e1', taskId: 't1', kind: 'command_output', bytes: 10, uploadState: 'stored', createdAt: '2026-09-01T00:00:00.000Z' },
    ]);
  });

  it('scopes to the workspace and the task lineage, newest first, capped', async () => {
    await loadInlineEvidence('ws', 't1', CTX);
    expect(findArgs.limit).toBe(INLINE_EVIDENCE_LIMIT);
    expect(findArgs.orderBy).toEqual([{ desc: 'evidenceObjects.createdAt' }]);
    expect(findArgs.where).toEqual({
      and: [
        { eq: ['evidenceObjects.workspaceId', 'ws'] },
        { or: [{ eq: ['evidenceObjects.taskId', 't1'] }, { eq: ['evidenceObjects.rootTaskId', 't1'] }] },
      ],
    });
  });

  it('a database failure costs the list, never the caller', async () => {
    boom = true;
    expect(await loadInlineEvidence('ws', 't1', CTX)).toEqual([]);
  });
});

describe('loadInlineEvidence — read audit', () => {
  it('writes one audit line per non-empty list, naming the surface, actor and ids', async () => {
    rows = [
      { id: 'e1', taskId: 't1', kind: 'command_output', bytes: 10, uploadState: 'stored', createdAt: new Date() },
      { id: 'e2', taskId: 't2', kind: 'transcript', bytes: 20, uploadState: 'stored', createdAt: new Date() },
    ];
    await loadInlineEvidence('ws', 't1', { surface: 'explain', actor: { userId: 'u-1' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      surface: 'explain', op: 'list', workspaceId: 'ws', taskId: 't1',
      evidenceIds: ['e1', 'e2'], actor: { userId: 'u-1' },
    });
  });

  it('writes no audit line for an empty list', async () => {
    await loadInlineEvidence('ws', 't1', CTX);
    expect(audits).toHaveLength(0);
  });

  it('writes no audit line when the lookup fails', async () => {
    boom = true;
    await loadInlineEvidence('ws', 't1', CTX);
    expect(audits).toHaveLength(0);
  });
});
