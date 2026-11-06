/**
 * AC-8 end to end: stored worker milestones -> runStagedSelfReviewReadout ->
 * rubberStamped label. Only the db is faked; the query builders, record
 * parsing and classifier are the real ones.
 */
import { describe, test, expect, mock } from 'bun:test';

const results: unknown[][] = [];
const chain: any = {
  from: () => chain,
  where: () => chain,
  limit: () => Promise.resolve(results.shift() ?? []),
  then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej),
};
mock.module('../db/client', () => ({ db: { select: () => chain } }));

const { runStagedSelfReviewReadout } = await import('../staged-self-review-readout-source');

const label = (o: object) => ({ type: 'status', label: `Self-review: ${JSON.stringify(o)}` });
const answered = (calls: string[], changed: boolean) =>
  label({ outcome: 'answered', answers: [{ id: 'a', answer: 'met' }], toolCallsBetween: calls, workChangedAfterDenial: changed });

describe('AC-8: readout invokes the classifier over stored records', () => {
  test('high touch rate and ~zero flip rate is labelled rubberStamped', async () => {
    results.push(
      [{ taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }],
      [
        { taskId: 't1', milestones: [answered([], false)] },
        { taskId: 't2', milestones: [answered([], false)] },
        { taskId: 't3', milestones: [answered([], false)] },
      ],
    );
    const out = await runStagedSelfReviewReadout({ id: 'e', policyVersion: 1 });
    expect(out.n).toBe(3);
    expect(out.flipRate).toBe(0);
    expect(out.rubberStamped).toBe(true);
  });

  test('agents that act on the stage are not labelled rubberStamped', async () => {
    results.push(
      [{ taskId: 't1' }, { taskId: 't2' }],
      [
        { taskId: 't1', milestones: [answered(['Edit'], true)] },
        { taskId: 't2', milestones: [answered(['Edit'], true)] },
      ],
    );
    const out = await runStagedSelfReviewReadout({ id: 'e', policyVersion: 1 });
    expect(out.flipRate).toBe(1);
    expect(out.rubberStamped).toBe(false);
  });

  test('no assigned tasks reads as empty, not rubber-stamped', async () => {
    results.push([]);
    const out = await runStagedSelfReviewReadout({ id: 'e', policyVersion: 1 });
    expect(out).toMatchObject({ n: 0, rubberStamped: false, skipped: 0 });
  });
});
