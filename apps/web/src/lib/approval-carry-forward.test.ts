import { describe, it, expect, mock } from 'bun:test';
import { carryForwardApprovalIfUnchanged } from './approval-carry-forward';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function run(over: {
  state?: string;
  reviewHeadSha?: string | null;
  equivalents?: string[];
  equivalent?: boolean;
  headSha?: string;
} = {}) {
  const record = mock(async () => {});
  const isEquivalent = mock(async () => ({ equivalent: over.equivalent ?? true, reason: over.equivalent === false ? 'PR diff changed' : 'PR diff unchanged' }));
  const promise = carryForwardApprovalIfUnchanged({
    installationId: 1,
    repoFullName: 'acme/app',
    workspaceId: 'ws-1',
    prNumber: 7,
    baseRef: 'dev',
    headSha: over.headSha ?? B,
    deps: {
      readStatus: async () => ({
        state: (over.state ?? 'approved') as any,
        reviewTaskId: 'review-1',
        reviewHeadSha: over.reviewHeadSha === undefined ? A : over.reviewHeadSha,
        reviewEquivalentHeadShas: over.equivalents ?? [],
      }),
      isEquivalent,
      record,
    },
  });
  return { promise, record, isEquivalent };
}

describe('carryForwardApprovalIfUnchanged', () => {
  it('records the new head on the approving review when the PR diff is unchanged', async () => {
    const { promise, record, isEquivalent } = run();
    expect(await promise).toEqual({ carried: true, reason: 'PR diff unchanged' });
    expect(isEquivalent).toHaveBeenCalledWith(expect.objectContaining({ fromSha: A, toSha: B, baseRef: 'dev' }));
    expect(record).toHaveBeenCalledWith({ reviewTaskId: 'review-1', headSha: B });
  });

  it('does not carry forward when the push changed the PR content', async () => {
    const { promise, record } = run({ equivalent: false });
    expect((await promise).carried).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('never carries forward a verdict other than approve', async () => {
    for (const state of ['changes_requested', 'escalated', 'reviewing', 'review_failed', 'not_requested']) {
      const { promise, record, isEquivalent } = run({ state });
      expect((await promise).carried).toBe(false);
      expect(isEquivalent).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('does nothing without a recorded review SHA to compare against', async () => {
    const { promise, isEquivalent } = run({ reviewHeadSha: null });
    expect((await promise).carried).toBe(false);
    expect(isEquivalent).not.toHaveBeenCalled();
  });

  it('is a no-op when the head is already covered', async () => {
    for (const over of [{ headSha: A }, { equivalents: [B] }]) {
      const { promise, record, isEquivalent } = run(over);
      expect((await promise).carried).toBe(true);
      expect(isEquivalent).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    }
  });
});
