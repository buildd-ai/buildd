import { describe, it, expect } from 'bun:test';
import { selectReviewerEvidence, RECOMMENDATION_MARKER, approvedAwaitingMergeTitle } from './reviewer-evidence';

function note(partial: Partial<Parameters<typeof selectReviewerEvidence>[0][number]> = {}) {
  return {
    taskId: 'task-1',
    type: 'reviewer_escalated',
    title: 'PR #2054 escalated: touches auth',
    body: 'This PR changes the token refresh path and needs a human.',
    status: 'open',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    ...partial,
  };
}

describe('selectReviewerEvidence recommendations', () => {
  it('splits the reviewer recommendation out of the escalation reason', () => {
    const { escalationMap } = selectReviewerEvidence([note({
      body: `Touches the token refresh path.${RECOMMENDATION_MARKER}Verify the refresh lock manually, then merge.`,
    })]);
    const evidence = escalationMap.get('task-1')!;
    expect(evidence.reason).toBe('Touches the token refresh path.');
    expect(evidence.recommendation).toBe('Verify the refresh lock manually, then merge.');
  });

  it('leaves recommendation null when the reviewer gave none', () => {
    const { escalationMap } = selectReviewerEvidence([note()]);
    expect(escalationMap.get('task-1')!.recommendation).toBeNull();
    expect(escalationMap.get('task-1')!.reason).toBe('This PR changes the token refresh path and needs a human.');
  });

  it('keeps the newest escalation and its recommendation', () => {
    const { escalationMap } = selectReviewerEvidence([
      note({ body: `Old reason.${RECOMMENDATION_MARKER}Old advice.`, createdAt: new Date('2026-08-01T10:00:00Z') }),
      note({ body: `New reason.${RECOMMENDATION_MARKER}New advice.`, createdAt: new Date('2026-09-02T10:00:00Z') }),
    ]);
    expect(escalationMap.get('task-1')!.recommendation).toBe('New advice.');
  });
});

describe('approve-only gate note title', () => {
  const plain = (createdAt: string) => note({
    type: 'reviewer_approved',
    title: 'PR #42 approved by reviewer',
    body: 'Reviewer approved (confidence 0.95): Looks good!',
    createdAt: new Date(createdAt),
  });

  it('writes the title in plain active voice with no em dash', () => {
    const title = approvedAwaitingMergeTitle(42);
    expect(title).toContain('#42');
    expect(title).not.toContain('\u2014');
    expect(title).not.toMatch(/awaiting/i);
  });

  it('treats a note carrying the new title as gate evidence', () => {
    const { approvalMap } = selectReviewerEvidence([
      note({ type: 'reviewer_approved', title: approvedAwaitingMergeTitle(42), body: null, createdAt: new Date('2026-07-20T10:00:00Z') }),
      plain('2026-07-20T10:05:00Z'),
    ]);
    expect(approvalMap.get('task-1')!.summary).toBe(approvedAwaitingMergeTitle(42));
  });

  it('still treats a legacy "awaiting human merge" title as gate evidence', () => {
    const legacy = 'PR #42 approved \u2014 awaiting human merge';
    const { approvalMap } = selectReviewerEvidence([
      note({ type: 'reviewer_approved', title: legacy, body: null, createdAt: new Date('2026-07-20T10:00:00Z') }),
      plain('2026-07-20T10:05:00Z'),
    ]);
    expect(approvalMap.get('task-1')!.summary).toBe(legacy);
  });
});
