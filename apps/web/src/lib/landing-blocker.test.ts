import { describe, it, expect } from 'bun:test';
import { deriveLandingBlocker } from './landing-blocker';

describe('deriveLandingBlocker — conflict takes precedence over review states', () => {
  const base = { taskId: 'task-1', prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' };

  it('a conflicted head with pending review shows conflict, not review_pending', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'AWAITING_REVIEW',
        headline: 'Awaiting review',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: null,
        owner: 'platform',
      },
      repairs: [],
    });

    expect(blocker?.cause).toBe('conflicted');
    expect(blocker?.owner).toBe('platform');
    expect(blocker?.label).toContain('conflicts with its base');
    expect(blocker?.label).not.toContain('review');
  });

  it('a conflicted head with repairs spent shows repair_exhausted with person owner', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'AWAITING_REVIEW',
        headline: 'Awaiting review',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: null,
        owner: 'platform',
      },
      repairs: [
        { status: 'completed', claimed: false, completedAt: '2026-01-01T00:00:00Z' },
        { status: 'completed', claimed: false, completedAt: '2026-01-02T00:00:00Z' },
      ],
    });

    expect(blocker?.cause).toBe('repair_exhausted');
    expect(blocker?.owner).toBe('person');
    expect(blocker?.label).toContain('conflicts with its base');
    expect(blocker?.label).toContain('2 repair attempts');
  });

  it('a conflicted head with an open repair shows repair_running when claimed', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'AWAITING_REVIEW',
        headline: 'Awaiting review',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: { status: 'in_progress' },
        owner: 'platform',
      },
      repairs: [{ status: 'in_progress', claimed: true }],
    });

    expect(blocker?.cause).toBe('repair_running');
    expect(blocker?.owner).toBe('platform');
    expect(blocker?.label).toContain('conflicts with its base');
    expect(blocker?.label).toContain('repair is running');
  });

  it('a conflicted head with a queued repair shows repair_queued when not yet claimed', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'AWAITING_REVIEW',
        headline: 'Awaiting review',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: null,
        owner: 'platform',
      },
      repairs: [{ status: 'pending', claimed: false }],
    });

    expect(blocker?.cause).toBe('repair_queued');
    expect(blocker?.owner).toBe('platform');
    expect(blocker?.label).toContain('conflicts with its base');
    expect(blocker?.label).toContain('repair is queued');
  });

  it('does not treat a non-conflicted PR in AWAITING_REVIEW as conflicted', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'AWAITING_REVIEW',
        headline: 'Awaiting review',
        prState: 'open' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: null,
        owner: 'platform',
      },
      repairs: [],
    });

    expect(blocker?.cause).toBe('review_pending');
    expect(blocker?.label).toContain('waiting for its review');
  });

  it('REPAIRING delivery with conflict and currentAttempt (empty repairs) reads as repair_running', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'REPAIRING',
        headline: 'Repairing conflict',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: { status: 'in_progress' },
        owner: 'platform',
      },
      repairs: [],
    });

    expect(blocker?.cause).toBe('repair_running');
    expect(blocker?.owner).toBe('platform');
    expect(blocker?.label).toContain('repair is running');
  });

  it('REPAIRING delivery with conflict and currentAttempt (empty repairs) reads as repair_queued when pending', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'REPAIRING',
        headline: 'Repairing conflict',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: { status: 'pending' },
        owner: 'platform',
      },
      repairs: [],
    });

    expect(blocker?.cause).toBe('repair_queued');
    expect(blocker?.owner).toBe('platform');
    expect(blocker?.label).toContain('repair is queued');
  });

  it('REPAIRING delivery with conflict and only ended repairs reads as repair_running via currentAttempt', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'REPAIRING',
        headline: 'Repairing conflict',
        prState: 'conflict' as const,
        headSha: 'abc123def456',
        detail: null,
        currentAttempt: { status: 'in_progress' },
        owner: 'platform',
      },
      repairs: [
        { status: 'completed', claimed: false, completedAt: '2026-01-01T00:00:00Z' },
        { status: 'completed', claimed: false, completedAt: '2026-01-02T00:00:00Z' },
      ],
    });

    expect(blocker?.cause).toBe('repair_running');
    expect(blocker?.owner).toBe('platform');
    expect(blocker?.label).toContain('repair is running');
  });

  it('210caad3: a behind refresh waiting for its lane slot names the wait, not "a repair is running"', () => {
    const blocker = deriveLandingBlocker({
      ...base,
      delivery: {
        state: 'REPAIRING',
        stateReason: 'behind',
        headline: 'Waiting to update branch',
        prState: 'open' as const,
        headSha: 'abc123def456',
        detail: 'PR #41 is merging into dev first',
        // The newest attempt task is the finished reviewer, not anything working on the branch.
        currentAttempt: { status: 'completed' },
        owner: 'platform',
      },
      repairs: [],
    });

    expect(blocker?.cause).toBe('repair_queued');
    expect(blocker?.label).toBe('PR #42: Waiting to update branch (PR #41 is merging into dev first)');
    expect(blocker?.label).not.toContain('running');
  });
});
