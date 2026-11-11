process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';

type Row = Record<string, any>;
let workspaceRows: Row[] = [];
let selectCount = 0;
let updateCalls: Row[] = [];
let updateReturning: Row[] = [{ id: 'job-1' }];
let executeSql: string[] = [];
let executeRows: Row[] = [{ n: 7 }];

mock.module('@buildd/core/db', () => ({
  db: {
    select: (_cols: any) => ({
      from: (_t: any) => ({
        where: (_c: any) => {
          selectCount++;
          return Promise.resolve(workspaceRows);
        },
      }),
    }),
    update: (_t: any) => ({
      set: (set: Row) => ({
        where: (_c: any) => ({
          returning: () => {
            updateCalls.push(set);
            return Promise.resolve(updateReturning);
          },
        }),
      }),
    }),
    execute: async (q: any) => {
      const chunks = (q?.queryChunks ?? []) as any[];
      executeSql.push(
        chunks
          .map(c => (Array.isArray(c?.value) ? c.value.join('') : typeof c === 'string' ? c : ''))
          .join(''),
      );
      return { rows: executeRows };
    },
  },
}));

import {
  isKnowledgeIngestEnabled,
  knowledgeIngestDisabledAmong,
  closeIngestJobAsSkipped,
  purgeWorkspaceRepoKnowledge,
  INGEST_DISABLED,
} from './knowledge-ingest-switch';

beforeEach(() => {
  workspaceRows = [];
  selectCount = 0;
  updateCalls = [];
  updateReturning = [{ id: 'job-1' }];
  executeSql = [];
  executeRows = [{ n: 7 }];
});

describe('isKnowledgeIngestEnabled', () => {
  it('is true for a workspace with the switch on (the default)', async () => {
    workspaceRows = [{ id: 'ws-1', knowledgeIngest: true }];
    expect(await isKnowledgeIngestEnabled('ws-1')).toBe(true);
  });

  it('is false for a workspace with the switch off', async () => {
    workspaceRows = [{ id: 'ws-1', knowledgeIngest: false }];
    expect(await isKnowledgeIngestEnabled('ws-1')).toBe(false);
  });

  it('treats a missing row as enabled (nothing to ingest either way)', async () => {
    workspaceRows = [];
    expect(await isKnowledgeIngestEnabled('ws-gone')).toBe(true);
  });

  it('does not read dataClass: a sensitive workspace with the switch on stays enabled', async () => {
    workspaceRows = [{ id: 'ws-1', knowledgeIngest: true, dataClass: 'sensitive' }];
    expect(await isKnowledgeIngestEnabled('ws-1')).toBe(true);
  });
});

describe('knowledgeIngestDisabledAmong', () => {
  it('returns only the disabled ids, in one query', async () => {
    workspaceRows = [
      { id: 'ws-1', knowledgeIngest: true },
      { id: 'ws-2', knowledgeIngest: false },
    ];
    const out = await knowledgeIngestDisabledAmong(['ws-1', 'ws-2', 'ws-2']);
    expect([...out]).toEqual(['ws-2']);
    expect(selectCount).toBe(1);
  });

  it('skips the query for an empty list', async () => {
    expect((await knowledgeIngestDisabledAmong([])).size).toBe(0);
    expect(selectCount).toBe(0);
  });
});

describe('closeIngestJobAsSkipped', () => {
  it('closes the job as error/ingest_disabled with stats.skipped and clears the lease', async () => {
    const closed = await closeIngestJobAsSkipped({ id: 'job-1', workspaceId: 'ws-1', repo: 'o/r' }, 'claim');
    expect(closed).toBe(true);
    expect(updateCalls[0]).toMatchObject({
      status: 'error',
      error: INGEST_DISABLED,
      stats: { skipped: INGEST_DISABLED },
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(updateCalls[0].finishedAt).toBeInstanceOf(Date);
  });

  it('reports false when another executor already moved the job', async () => {
    updateReturning = [];
    expect(await closeIngestJobAsSkipped({ id: 'job-1', workspaceId: 'ws-1' }, 'claim')).toBe(false);
  });
});

describe('purgeWorkspaceRepoKnowledge', () => {
  it('deletes code, docs and pr chunks only, and returns the count', async () => {
    const n = await purgeWorkspaceRepoKnowledge('ws-1');
    expect(n).toBe(7);
    expect(executeSql[0]).toContain('DELETE FROM knowledge_chunks');
  });
});
