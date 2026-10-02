/**
 * escalateCiRedHead is the "escalate once per PR + head" half of the red-PR
 * sweep. The once-ness lives in the UPDATE's WHERE, so the predicate is
 * rendered through PgDialect rather than trusted to a mocked db.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let lastSet: any = null;
let lastWhere: any = null;
let updatedRows: Array<{ id: string }> = [{ id: 't1' }];
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (values: any) => {
        lastSet = values;
        return {
          where: (where: any) => {
            lastWhere = where;
            return { returning: async () => updatedRows };
          },
        };
      },
    }),
  },
}));

const mockNotify = mock(async (_missionId: string, _opts: any) => {});
mock.module('@/lib/mission-notifications', () => ({ notifyMissionPrReady: mockNotify }));
const mockAppend = mock(async (_p: any) => {});
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppend, taskActivityUrl: (id: string) => `/t/${id}` }));

const { escalateCiRedHead } = await import('./ci-failure-retry');
const { CI_RED_ESCALATED_KEY } = await import('./ci-red-queue');

const input = {
  installationId: 1,
  repoFullName: 'o/r',
  prNumber: 7,
  headSha: 'h1',
  task: { id: 't1', title: 'Do it', workspaceId: 'ws1', missionId: 'm1', result: { nextSuggestion: 'keep me' } },
  detail: 'pushed nothing',
  missionTitle: 'CI failing',
  missionMessage: 'Needs a human.',
};

describe('escalateCiRedHead', () => {
  beforeEach(() => {
    lastSet = null;
    lastWhere = null;
    updatedRows = [{ id: 't1' }];
    mockNotify.mockClear();
    mockAppend.mockClear();
  });

  it('only updates an owner whose escalated head is a different one', async () => {
    await escalateCiRedHead(input);
    const q = new PgDialect().sqlToQuery(lastWhere);
    expect(q.sql).toContain('"tasks"."id" = $');
    expect(q.sql).toMatch(/coalesce\("tasks"\."context"->>\$\d+, ''\) <> \$\d+/);
    expect(q.params).toContain(CI_RED_ESCALATED_KEY);
    expect(q.params).toContain('h1');
  });

  it('stamps the head, fails the owner, keeps the agent handoff, and tells the mission and the PR', async () => {
    expect(await escalateCiRedHead(input)).toBe(true);
    expect(lastSet.status).toBe('failed');
    expect(lastSet.result.nextSuggestion).toBe('keep me');
    expect(lastSet.result.summary).toContain('pushed nothing');
    const ctx = new PgDialect().sqlToQuery(lastSet.context);
    expect(ctx.sql).toContain('jsonb_set');
    expect(ctx.params).toContain(`{${CI_RED_ESCALATED_KEY}}`);
    expect(ctx.params).toContain('h1');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][0].entry.kind).toBe('ci_exhausted');
  });

  it('an already-escalated head notifies nobody and reports false', async () => {
    updatedRows = [];
    expect(await escalateCiRedHead(input)).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
