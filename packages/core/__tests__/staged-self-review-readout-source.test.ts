/**
 * AC-8 end to end: the readout over stored worker rows. The runner stores the
 * full stage records in `workers.resultMeta.stagedSelfReview`; milestones only
 * carry short labels. A run with no tool calls and no change must read as a
 * rubber stamp. Only the db client is stubbed; the query result rows are the
 * stored shapes, and the real classifier runs over them.
 */
import { describe, test, expect, mock } from 'bun:test';

let call = 0;
let tasks: unknown[] = [];
let workerRows: unknown[] = [];
const chain = (rows: () => unknown[]) => {
  const c: any = new Proxy({}, {
    get: (_t, p) => (p === 'then' ? (res: (v: unknown) => void) => res(rows()) : () => c),
  });
  return c;
};
mock.module('../db/client', () => ({
  db: { select: () => (call++ % 2 === 0 ? chain(() => tasks) : chain(() => workerRows)) },
}));

const { runStagedSelfReviewReadout } = await import('../staged-self-review-readout-source');

const stored = (answered: object) => ({
  milestones: [{ type: 'status', label: 'Self-review: answered (treatment, acting)' }],
  resultMeta: { stagedSelfReview: [{ outcome: 'denied', ts: 1 }, { outcome: 'answered', ts: 2, ...answered }] },
});

describe('runStagedSelfReviewReadout over stored worker rows (AC-8)', () => {
  test('no tool calls and no change: high touch rate, ~zero flip rate, rubberStamped', async () => {
    call = 0;
    tasks = [{ taskId: 't0' }, { taskId: 't1' }, { taskId: 't2' }];
    workerRows = tasks.map((t: any) => ({
      taskId: t.taskId,
      ...stored({ answers: [{ id: 'a', answer: 'met' }], toolCallsBetween: [], workChangedAfterDenial: false }),
    }));
    const r = await runStagedSelfReviewReadout({ id: 'e1', policyVersion: 1 });
    expect(r.n).toBe(3);
    expect(r.touchRate).toBeGreaterThanOrEqual(0.8);
    expect(r.flipRate).toBeLessThanOrEqual(0.05);
    expect(r.rubberStamped).toBe(true);
    expect(r.skipped).toBe(0);
  });

  test('edits after the denial are not a rubber stamp', async () => {
    call = 0;
    tasks = [{ taskId: 't0' }];
    workerRows = [{ taskId: 't0', ...stored({ answers: [{ answer: 'unmet' }], toolCallsBetween: ['Edit'], workChangedAfterDenial: true }) }];
    const r = await runStagedSelfReviewReadout({ id: 'e1', policyVersion: 1 });
    expect(r.flipRate).toBe(1);
    expect(r.rubberStamped).toBe(false);
  });
});
