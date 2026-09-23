import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mutable state controlled per-test
let mockWorkerRows: any[] = [];
let mockEpisodeRows: any[] = [];
let mockLiveCountRows: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(mockWorkerRows),
        }),
        where: () => Promise.resolve(mockLiveCountRows),
      }),
    }),
    query: {
      oauthBudgetEpisodes: {
        findMany: () => Promise.resolve(mockEpisodeRows),
      },
    },
  },
}));

const { loadOauthEpisodes, measureOauthWindow, countLiveSeatWorkers, OAUTH_EPISODE_HORIZON_DAYS } =
  await import('./oauth-budget-window');
const { learnOauthCapacity } = await import('@buildd/core/oauth-budget');

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-01-01T12:00:00Z');

beforeEach(() => {
  mockWorkerRows = [];
  mockEpisodeRows = [];
  mockLiveCountRows = [];
});

describe('loadOauthEpisodes', () => {
  it('returns episodes from all sibling accountIds combined', async () => {
    const exhaustedAt1 = new Date('2025-12-31T10:00:00Z');
    const exhaustedAt2 = new Date('2025-12-31T08:00:00Z');
    mockEpisodeRows = [
      {
        exhaustedAt: exhaustedAt1,
        resetsAt: null,
        workerCount: 3,
        turns: 50,
        inputTokens: 1000,
        outputTokens: 0,
        weightedTurns: 50,
        weightedTokens: 1000,
      },
      {
        exhaustedAt: exhaustedAt2,
        resetsAt: null,
        workerCount: 2,
        turns: 30,
        inputTokens: 500,
        outputTokens: 0,
        weightedTurns: 30,
        weightedTokens: 500,
      },
    ];

    const result = await loadOauthEpisodes(['acc1', 'acc2'], undefined, NOW);
    expect(result).toHaveLength(2);
    expect(result[0].turns).toBe(50);
    expect(result[1].turns).toBe(30);
  });

  it('accepts a single-element array (backwards-compatible shape)', async () => {
    mockEpisodeRows = [
      {
        exhaustedAt: new Date('2025-12-31T10:00:00Z'),
        resetsAt: null,
        workerCount: 1,
        turns: 10,
        inputTokens: 200,
        outputTokens: 0,
        weightedTurns: 10,
        weightedTokens: 200,
      },
    ];
    const result = await loadOauthEpisodes(['acc1'], undefined, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].turns).toBe(10);
  });

  // Every recorded episode is, by the time anyone reads it, from a window that
  // has already reset — that is what an episode IS. Dropping elapsed ones left
  // at most one survivor, below MIN_SAMPLES, so learning never switched on.
  it('keeps elapsed episodes — a past reset is what makes an episode a sample', async () => {
    mockEpisodeRows = [1, 2, 3].map(daysAgo => ({
      exhaustedAt: new Date(NOW.getTime() - daysAgo * 24 * HOUR),
      resetsAt: new Date(NOW.getTime() - daysAgo * 24 * HOUR + 2 * HOUR),
      workerCount: 5,
      turns: 100,
      inputTokens: 2000,
      outputTokens: 0,
      weightedTurns: 100,
      weightedTokens: 2000,
    }));

    const result = await loadOauthEpisodes(['acc1'], undefined, NOW);
    expect(result).toHaveLength(3);
    // The newest reset is still reported, so the live window can be anchored on it.
    expect(result[0].resetsAt).toEqual(new Date(NOW.getTime() - 22 * HOUR));
    expect(learnOauthCapacity(result).confidence).not.toBe('none');
  });

  it('drops episodes older than the learning horizon (plan sizes change)', async () => {
    const row = (daysAgo: number, turns: number) => ({
      exhaustedAt: new Date(NOW.getTime() - daysAgo * 24 * HOUR),
      resetsAt: new Date(NOW.getTime() - daysAgo * 24 * HOUR + HOUR),
      workerCount: 5,
      turns,
      inputTokens: 0,
      outputTokens: 0,
      weightedTurns: turns,
      weightedTokens: 0,
    });
    mockEpisodeRows = [row(1, 100), row(OAUTH_EPISODE_HORIZON_DAYS + 1, 20)];

    const result = await loadOauthEpisodes(['acc1'], undefined, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].turns).toBe(100);
  });
});

describe('countLiveSeatWorkers', () => {
  it('counts live workers across every account on the seat', async () => {
    mockLiveCountRows = [{ count: 4 }];
    expect(await countLiveSeatWorkers(['acc1', 'acc2'])).toBe(4);
  });

  it('reads an empty result as zero', async () => {
    mockLiveCountRows = [];
    expect(await countLiveSeatWorkers(['acc1'])).toBe(0);
  });
});

describe('measureOauthWindow', () => {
  it('sums worker turns from all sibling accountIds in the window', async () => {
    // Two workers for acc1, one for acc2, all within last hour → same window
    const recentTime = new Date(NOW.getTime() - 30 * 60 * 1000); // 30 min ago
    mockWorkerRows = [
      { createdAt: recentTime, turns: 5, inputTokens: 100, outputTokens: 0, model: null },
      { createdAt: recentTime, turns: 3, inputTokens: 60, outputTokens: 0, model: null },
      { createdAt: recentTime, turns: 2, inputTokens: 40, outputTokens: 0, model: null },
    ];

    const result = await measureOauthWindow({
      accountIds: ['acc1', 'acc2'],
      now: NOW,
      lastResetsAt: null,
    });

    // All 3 workers are in the window, turns must sum to 10
    expect(result.usage.turns).toBe(10);
    expect(result.usage.workerCount).toBe(3);
  });

  it('works with a single-element array', async () => {
    const recentTime = new Date(NOW.getTime() - HOUR / 2);
    mockWorkerRows = [
      { createdAt: recentTime, turns: 7, inputTokens: 70, outputTokens: 0, model: null },
    ];

    const result = await measureOauthWindow({
      accountIds: ['acc1'],
      now: NOW,
      lastResetsAt: null,
    });

    expect(result.usage.turns).toBe(7);
  });
});
