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
});

// e07ee9cf: approved PRs parked in the landing lane read as "a repair is running" with no worker or repair.
describe('deriveLandingBlocker — a behind refresh is not a repair', () => {
  const base = { taskId: 'task-1', prNumber: 5660, prUrl: 'https://github.com/org/repo/pull/5660' };
  const behind = (o: Record<string, unknown> = {}) => ({
    state: 'REPAIRING' as const, stateReason: 'behind', headline: 'Updating branch', prState: 'awaiting_ci' as const,
    headSha: 'abc123def456', detail: null, currentAttempt: { taskId: 'task-1', role: 'owner', status: 'completed', createdAt: '2026-10-24T15:00:00Z' }, owner: 'landing' as const, ...o,
  });

  it('parked in the lane: queued behind the PR landing first, owned by the platform', () => {
    const b = deriveLandingBlocker({ ...base, delivery: behind({ laneWait: { behindPr: 5657, position: 2 } }) });
    expect(b).toMatchObject({ cause: 'lane_queued', owner: 'platform', label: 'PR #5660 is queued to land behind PR #5657, position 2' });
    expect(`${b?.label} ${b?.nextAction}`).not.toMatch(/repair/i);
  });

  it('refreshing: the platform updates the branch, never "a repair is running"', () => {
    const b = deriveLandingBlocker({ ...base, delivery: behind() });
    expect(b).toMatchObject({ cause: 'branch_updating', owner: 'platform' });
    expect(b?.label).not.toMatch(/repair/i);
  });
});
