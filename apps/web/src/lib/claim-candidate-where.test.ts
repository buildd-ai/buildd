import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { claimCandidateWhere } from './claim-candidate-where';
import { taskNotReserved } from '@/app/api/workers/claim/held-gate';

const dialect = new PgDialect();
const render = (s: SQL | undefined) => (s ? dialect.sqlToQuery(s) : null);

const base = {
  workspaceIds: ['ws-1'], now: new Date('2026-11-22T00:00:00Z'), accountType: 'user',
  runner: 'runner-a', availableSkills: [], executor: 'host' as const, accountId: 'acct-1',
};

describe('claimCandidateWhere: the reservation gate (spec claim-gate-legibility CG-7)', () => {
  it("passes the reserving account's explicit claim of the named task, interactive or not", () => {
    // A runner that filed a task reserved (the ACP bridge, for a T3 thread)
    // claims it by id with its own key, no interactive-session marker.
    for (const interactiveSession of [true, false]) {
      const { gates } = claimCandidateWhere({ ...base, interactiveSession, taskId: 't-1' });
      expect(render(gates.taskReserved)).toEqual(render(taskNotReserved('acct-1')));
    }
  });

  it('holds a reserved task from every polling claim, the reserving account included', () => {
    for (const interactiveSession of [true, false]) {
      const { gates } = claimCandidateWhere({ ...base, interactiveSession, taskId: null });
      expect(render(gates.taskReserved)).toEqual(render(taskNotReserved()));
    }
  });
});
