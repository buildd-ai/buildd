import { expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withDeferredEffectDrains } from './effect-drain-context';
import { requestReview, recordReviewVerdict } from './seam';

const scheduledHeals: Array<[string, number | undefined]> = [];
mock.module('./kernel-heal', () => ({ scheduleKernelHeal: async (id: string, delay?: number) => { scheduledHeals.push([id, delay]); } }));

const dialect = new PgDialect();
const row = { id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/widgets', pr_number: 7, base_ref: 'dev', state: 'WORKING', version: 1, current_head_sha: 'H1', current_round: 0, max_rounds: 3, authority: 'kernel' };

for (const op of ['request_review', 'record_review_verdict'] as const) {
  test(`${op} commits before a five-second GitHub effect`, async () => {
    const writes: string[] = [];
    const exec = async (q: any) => {
      const rendered = dialect.sqlToQuery(q);
      if (rendered.sql.includes('workflow:resolve_authority')) return { rows: [{ delivery_id: 'd1', authority: 'kernel' }] };
      if (rendered.sql.includes('workflow:find_transition')) return { rows: [] };
      if (rendered.sql.includes('workflow:load_view')) return { rows: [{ delivery: op === 'request_review' ? row : { ...row, state: 'AWAITING_REVIEW', current_round: 1 }, rounds: op === 'request_review' ? [] : [{ id: 'r1', round: 1, head_sha: 'H1', kind: 'full', status: 'reviewing', reviewer_task_id: 'reviewer' }], attempts: [] }] };
      if (rendered.sql.includes('workflow:transition')) { writes.push(JSON.stringify(rendered.params)); return { rows: [{ transition_id: 'tr1', delivery_id: 'd1', version: 2 }] }; }
      throw new Error(rendered.sql);
    };
    const github = mock(async () => { await new Promise(r => setTimeout(r, 5000)); return null; });
    const drain = mock(async () => { await github(); return null; });
    const started = Date.now();
    const deferred = await withDeferredEffectDrains(() => op === 'request_review'
      ? requestReview({ workspaceId: 'w1', repoFullName: 'acme/widgets', prNumber: 7, installationId: 1, forced: false, actor: 'agent:test' }, { exec, reader: () => ({ readPr: github }), drain })
      : recordReviewVerdict({ reviewerTask: { id: 'reviewer', deliveryId: 'd1', context: { workflowRoundId: 'r1' } }, verdict: 'approve', effectiveVerdict: 'approve', headSha: 'H1', confidence: 1 }, { exec, drain }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(deferred.value).toMatchObject({ handled: true, result: { result: 'applied' } });
    expect(writes.join()).toContain(op === 'request_review' ? 'dispatch_review' : 'post_review');
    if (op === 'request_review') expect(writes.join()).toContain('revalidate');
    expect(github).not.toHaveBeenCalled();
    expect(deferred.drains.size).toBe(1);
    await Promise.all([...deferred.drains.values()].map(run => run()));
    expect(github).toHaveBeenCalledTimes(1);
  }, 7000);
}

// A missed push must be caught up even when the recorded head already has a verdict.
test('an already reviewed recorded head schedules live catchup without a GitHub read', async () => {
  const exec = async (q: any) => {
    const text = dialect.sqlToQuery(q).sql;
    if (text.includes('workflow:resolve_authority')) return { rows: [{ delivery_id: 'd2', authority: 'kernel' }] };
    if (text.includes('workflow:find_transition')) return { rows: [] };
    if (text.includes('workflow:load_view')) return { rows: [{ delivery: { ...row, id: 'd2', state: 'APPROVED', current_round: 1 }, rounds: [{ id: 'r1', round: 1, head_sha: 'H1', kind: 'full', status: 'decided', verdict: 'approve', effective_verdict: 'approve', reviewer_task_id: 'reviewer' }], attempts: [] }] };
    throw new Error(text);
  };
  const github = mock(async () => { throw new Error('GitHub must be deferred'); });
  const { value } = await withDeferredEffectDrains(() => requestReview({ workspaceId: 'w1', repoFullName: 'acme/widgets', prNumber: 7, installationId: 1, forced: false, actor: 'agent:test' }, { exec, reader: () => ({ readPr: github }), drain: async () => null }));
  expect(value).toMatchObject({ result: { result: 'rejected', reason: 'head_already_reviewed' } });
  expect(scheduledHeals).toContainEqual(['d2', 0]);
  expect(github).not.toHaveBeenCalled();
});
