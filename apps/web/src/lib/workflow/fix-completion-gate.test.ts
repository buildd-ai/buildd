/**
 * fixCompletionGate: a fix attempt may not complete while the PR head is still
 * the head it was bound to — except a ci_fix whose CI on that unchanged head
 * is green now (the failure was a PR-body check fixed by editing the body).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Exec } from './kernel';
import { fixCompletionGate } from './seam';

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;

const exec: Exec = async (q) => {
  const t = text(q);
  if (t.includes('workflow:resolve_authority')) return { rows: [{ delivery_id: 'd1', authority: 'kernel', released: false }] };
  if (t.includes('workflow:load_view')) {
    return {
      rows: [{
        delivery: {
          id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/widgets', pr_number: 7, base_ref: 'dev',
          state: 'AWAITING_PUSH', version: 4, current_head_sha: 'H1', current_round: 1, max_rounds: 3, authority: 'kernel',
        },
        rounds: [],
        attempts: [{ id: 'a1', family: 'ci', attempt_no: 1, mode: 'agent', bound_head_sha: 'H1', task_id: 't9', status: 'running', max_attempts: 3 }],
      }],
    };
  }
  return { rows: [] };
};

const live = { state: 'open', merged: false, headSha: 'H1' };
const run = (role: string, ciGreen: boolean | null | undefined) =>
  fixCompletionGate(
    { task: { id: 't9', workspaceId: 'w1', deliveryId: 'd1', deliveryRole: role, context: { workflowAttemptId: 'a1' } }, localHeadSha: 'H1' },
    {
      exec,
      repoFor: async () => ({ installationId: 1, repoFullName: 'acme/widgets', gitConfig: null }),
      reader: () => ({ readPr: async () => live, ...(ciGreen === undefined ? {} : { ciGreen: async () => ciGreen }) }) as never,
    },
  );

describe('fixCompletionGate unchanged head', () => {
  test('ci_fix with green CI on the unchanged head is allowed', async () => {
    expect(await run('ci_fix', true)).toBeNull();
  });

  test.each([[false], [null], [undefined]])('ci_fix with CI %p on the unchanged head is refused', async (green) => {
    expect((await run('ci_fix', green))?.code).toBe('delivery_not_advanced');
  });

  test('a review fix (role fix) gets no green-CI exemption', async () => {
    expect((await run('fix', true))?.code).toBe('delivery_not_advanced');
  });
});
