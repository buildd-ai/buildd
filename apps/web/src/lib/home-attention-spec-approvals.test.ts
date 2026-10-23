/**
 * Home's Needs you card for spec revisions waiting on the person (Living Spec
 * b7fc9316 R-9, AC-7): one card with the count while it is above zero, none
 * at zero, and it counts as one approval in the headline. Which specs count
 * is real-Postgres tested in tests/db/spec-approval-inbox.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { deriveHomeNeedsYou } from './home-needs-you';
import { SPEC_APPROVALS_HREF, specApprovalsAttention } from './home-attention';

const needsYou = (count: number) => {
  const card = specApprovalsAttention(count);
  return deriveHomeNeedsYou({ queue: [], missions: [], questions: [], held: [], isActionable: () => true, status: card ? [card] : [] });
};

describe('specApprovalsAttention (AC-7)', () => {
  it('one or more waiting: one card with the count, linking to the inbox', () => {
    const three = needsYou(3);
    expect(three.items).toHaveLength(1);
    expect(three.items[0]).toMatchObject({ title: '3 spec revisions wait for your approval', href: SPEC_APPROVALS_HREF, actionType: 'approve', primary: { href: SPEC_APPROVALS_HREF } });
    expect(three.subline).toBe('1 approval');
    expect(needsYou(1).items[0].title).toBe('1 spec revision waits for your approval');
  });

  it('none waiting: no card', () => {
    expect(specApprovalsAttention(0)).toBeNull();
    expect(needsYou(0).items).toEqual([]);
  });
});
