/**
 * `stamp_pr_rows` (T17/T18's fact-cache projection): the merge or close the
 * kernel recorded reaches every worker row of the PR through recordPrFact,
 * with the delivery's GitHub merged_at; a stale close never closes a reopened
 * PR. The funnel's own ordering rules are tests/db/pr-facts.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { PrFact, PrFactTarget } from '@buildd/core/pr-facts';
import type { Exec } from './kernel';
import { prUrlOf, stampPrRowsHandler, withPrFactEffects } from './pr-fact-effects';
import type { ClaimedEffect } from './effects';

function deliveryRow(over: Record<string, unknown>) {
  return {
    id: 'd1', workspace_id: 'ws1', owner_task_id: 't1', repo_full_name: 'acme/app', pr_number: 7, base_ref: 'dev',
    state: 'MERGED', state_reason: null, version: 5, current_head_sha: 'H1', current_round: 1, max_rounds: 3,
    bound_attempt_id: null, resume_state: null, trunk_incident_id: null, approved_heads: ['H1'], approval_basis: 'verdict',
    composition_heads: [], ci: null, ci_head_sha: null, mergeable: null, mergeable_head_sha: null,
    merged_at: '2026-10-01T10:00:00.000Z', merge_commit_sha: 'M1', superseded_by_pr: null, authority: 'kernel', ...over,
  };
}

/** A kernel loadView over one delivery row and no rounds/attempts. */
const execFor = (row: Record<string, unknown>): Exec => async () => ({ rows: [{ delivery: row, rounds: [], attempts: [] }] });

const effect = { id: 'e1', deliveryId: 'd1', transitionId: 'tr1', kind: 'stamp_pr_rows', dedupeKey: 'k', payload: {}, attemptCount: 1, delivery: null, transition: null } as ClaimedEffect;

describe('stamp_pr_rows', () => {
  test('a merged delivery stamps every row of the PR with its GitHub merged_at', async () => {
    const calls: Array<{ target: PrFactTarget; fact: PrFact }> = [];
    const h = stampPrRowsHandler({ exec: execFor(deliveryRow({})), record: (async (target: PrFactTarget, fact: PrFact) => { calls.push({ target, fact }); return [{ id: 'w1' }, { id: 'w2' }]; }) as never });
    expect(await h(effect)).toEqual({ outcome: 'ok:merged_2' });
    expect(calls).toEqual([{ target: { prUrl: prUrlOf('acme/app', 7), prNumber: 7 }, fact: { kind: 'merged', mergedAt: '2026-10-01T10:00:00.000Z' } }]);
  });

  test('a closed delivery stamps every row closed; a reopened one is left alone', async () => {
    const calls: PrFact[] = [];
    const record = (async (_t: PrFactTarget, fact: PrFact) => { calls.push(fact); return []; }) as never;
    expect(await stampPrRowsHandler({ exec: execFor(deliveryRow({ state: 'CLOSED_UNMERGED', merged_at: null })), record })(effect)).toEqual({ outcome: 'ok:closed_0' });
    expect(calls).toEqual([{ kind: 'closed' }]);
    expect(await stampPrRowsHandler({ exec: execFor(deliveryRow({ state: 'AWAITING_REVIEW', merged_at: null })), record })(effect)).toEqual({ outcome: 'skipped:state_AWAITING_REVIEW' });
    expect(calls.length).toBe(1);
  });

  test('the composition root registers it beside the module handlers', () => {
    const composed = withPrFactEffects({ notify: async () => ({ outcome: 'ok' }) });
    expect(typeof composed.stamp_pr_rows).toBe('function');
    expect(typeof composed.notify).toBe('function');
  });
});
