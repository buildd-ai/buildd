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

describe('fixCompletionGate for a review fix (workflow-state-kernel.md §13.13 rule 4, AC-19)', () => {
  const finding = (o: Record<string, unknown> = {}) => ({
    id: 'r1:0', origin_round_id: 'r1', origin_round: 1, origin_head_sha: 'H1', ordinal: 0, path: 'src/a.ts', line: 3,
    title: 'rename the flag', required: true, status: 'open', last_round: 1, ...o,
  });
  const execWith = (findings: unknown[]): Exec => async (q) => {
    const t = text(q);
    if (t.includes('workflow:resolve_authority')) return { rows: [{ delivery_id: 'd1', authority: 'kernel', released: false }] };
    if (t.includes('workflow:load_view')) {
      return { rows: [{
        delivery: { id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/widgets', pr_number: 7, base_ref: 'dev', state: 'FIXING', version: 4, current_head_sha: 'H1', current_round: 1, max_rounds: 3, authority: 'kernel' },
        rounds: [], findings,
        attempts: [{ id: 'a1', family: 'review_fix', attempt_no: 1, mode: 'agent', bound_head_sha: 'H1', task_id: 't9', status: 'running', max_attempts: 3 }],
      }] };
    }
    return { rows: [] };
  };
  const gate = (o: { head: string; changed?: string[] | null; findings?: unknown[]; noop?: { findingIds: string[]; evidence: string } | null }) =>
    fixCompletionGate(
      { task: { id: 't9', workspaceId: 'w1', deliveryId: 'd1', deliveryRole: 'fix', context: { workflowAttemptId: 'a1' } }, localHeadSha: o.head, noopEvidence: o.noop ?? null },
      {
        exec: execWith(o.findings ?? [finding()]),
        repoFor: async () => ({ installationId: 1, repoFullName: 'acme/widgets', gitConfig: null }),
        reader: () => ({ readPr: async () => ({ state: 'open', merged: false, headSha: o.head }), changedPaths: async () => o.changed ?? null }) as never,
      },
    );

  test('a push that touches a finding\'s file completes', async () => {
    expect(await gate({ head: 'H2', changed: ['src/a.ts', 'README.md'] })).toBeNull();
  });
  test('a push that touches none of the findings\' files is refused, naming them', async () => {
    const r = await gate({ head: 'H2', changed: ['packages/core/drizzle/x/migration.sql'] });
    expect(r?.code).toBe('repair_unrelated_diff');
    expect(r?.error).toContain('src/a.ts');
  });
  test('an unread diff is not evidence either way: it completes, and the re-review decides', async () => {
    expect(await gate({ head: 'H2', changed: null })).toBeNull();
  });
  test('a zero diff is refused unless the fix claims, with evidence, that a named open finding is already fixed', async () => {
    expect((await gate({ head: 'H1' }))?.code).toBe('delivery_not_advanced');
    expect(await gate({ head: 'H1', noop: { findingIds: ['r1:0'], evidence: 'src/a.ts:3 already reads the flag' } })).toBeNull();
    expect((await gate({ head: 'H1', noop: { findingIds: ['someone-else:0'], evidence: 'x' } }))?.code).toBe('delivery_not_advanced');
  });
});
