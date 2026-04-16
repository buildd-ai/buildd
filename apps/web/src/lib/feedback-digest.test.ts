import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Mock functions ──────────────────────────────────────────────────────────

const mockFeedbackFindMany = mock(() => [] as any[]);
const mockNotesFindMany = mock(() => [] as any[]);
const mockArtifactsFindMany = mock(() => [] as any[]);
const mockTeamsFindFirst = mock(() => null as any);

const mockMemorySave = mock(() => Promise.resolve({ memory: { id: 'mem-1' } }));
const mockMemoryUpdate = mock(() => Promise.resolve({ memory: { id: 'mem-1' } }));
const mockMemorySearch = mock(() => Promise.resolve({ results: [], total: 0, limit: 10, offset: 0 }));
const mockMemoryBatch = mock(() => Promise.resolve({ memories: [] }));

// ── Register mocks ─────────────────────────────────────────────────────────

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      userFeedback: { findMany: mockFeedbackFindMany },
      missionNotes: { findMany: mockNotesFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
      teams: { findFirst: mockTeamsFindFirst },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  userFeedback: {
    createdAt: 'created_at',
    signal: 'signal',
    userId: 'user_id',
    entityType: 'entity_type',
    entityId: 'entity_id',
    teamId: 'team_id',
  },
  teams: { id: 'id', memoryApiKey: 'memory_api_key' },
  missionNotes: { id: 'id' },
  artifacts: { id: 'id' },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  sql: () => ({}),
}));

mock.module('@buildd/core/memory-client', () => ({
  MemoryClient: class MockMemoryClient {
    constructor(public baseUrl: string, public apiKey: string) {}
    save = mockMemorySave;
    update = mockMemoryUpdate;
    search = mockMemorySearch;
    batch = mockMemoryBatch;
  },
}));

import { runFeedbackDigest, getFeedbackStats } from './feedback-digest';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFeedbackRow(overrides: Partial<{
  id: string;
  teamId: string;
  userId: string;
  entityType: string;
  entityId: string;
  signal: string;
  comment: string | null;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id || `fb-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId || 'team-1',
    userId: overrides.userId || 'user-1',
    entityType: overrides.entityType || 'artifact',
    entityId: overrides.entityId || `art-${Math.random().toString(36).slice(2, 8)}`,
    signal: overrides.signal || 'dismiss',
    comment: overrides.comment ?? null,
    createdAt: overrides.createdAt || new Date(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runFeedbackDigest', () => {
  beforeEach(() => {
    mockFeedbackFindMany.mockReset();
    mockTeamsFindFirst.mockReset();
    mockMemorySave.mockReset();
    mockMemoryUpdate.mockReset();
    mockMemorySearch.mockReset();
    mockMemoryBatch.mockReset();
    mockNotesFindMany.mockReset();
    mockArtifactsFindMany.mockReset();

    // Default: memory API available
    process.env.MEMORY_API_URL = 'http://memory.test';
  });

  it('returns empty results when no feedback exists', async () => {
    mockFeedbackFindMany.mockResolvedValue([]);

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('groups feedback by team and creates memory per pattern', async () => {
    // 3 dismiss signals on artifacts for team-1 (above MIN_SIGNALS_FOR_PATTERN)
    const rows = [
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss', entityId: 'art-1' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss', entityId: 'art-2' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss', entityId: 'art-3' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'key-123' });
    mockMemorySearch.mockResolvedValue({ results: [], total: 0, limit: 10, offset: 0 });
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'art-1', type: 'content', title: 'Summary Report', content: 'Some content here...' },
      { id: 'art-2', type: 'data', title: 'Analytics', content: 'Numbers...' },
    ]);

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(3);
    expect(result.results.length).toBe(1);
    expect(result.results[0].teamId).toBe('team-1');
    expect(result.results[0].memoriesSaved).toBe(1);
    expect(result.results[0].feedbackProcessed).toBe(3);
    expect(mockMemorySave).toHaveBeenCalledTimes(1);
  });

  it('skips patterns with fewer than MIN_SIGNALS_FOR_PATTERN (2) signals', async () => {
    // Only 1 dismiss signal — should be skipped
    const rows = [
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'key-123' });

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(1);
    expect(result.results[0].memoriesSaved).toBe(0);
    expect(mockMemorySave).not.toHaveBeenCalled();
  });

  it('updates existing memory when matching digest memory found', async () => {
    const rows = [
      makeFeedbackRow({ teamId: 'team-1', entityType: 'note', signal: 'down' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'note', signal: 'down' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'key-123' });

    // Simulate existing matching memory
    mockMemorySearch.mockResolvedValue({
      results: [{ id: 'existing-mem', title: 'User feedback: note content frequently downvoted', type: 'pattern', createdAt: new Date().toISOString() }],
      total: 1,
      limit: 10,
      offset: 0,
    });
    mockMemoryBatch.mockResolvedValue({
      memories: [{
        id: 'existing-mem',
        teamId: 'team-1',
        type: 'pattern',
        title: 'User feedback: note content frequently downvoted',
        content: 'old content',
        project: null,
        tags: ['feedback-digest', 'user-preference', 'note', 'down'],
        files: [],
        source: 'feedback-digest-cron',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });
    mockNotesFindMany.mockResolvedValue([]);

    const result = await runFeedbackDigest(24);

    expect(result.results[0].memoriesUpdated).toBe(1);
    expect(result.results[0].memoriesSaved).toBe(0);
    expect(mockMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(mockMemorySave).not.toHaveBeenCalled();
  });

  it('handles multiple teams independently', async () => {
    const rows = [
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
      makeFeedbackRow({ teamId: 'team-2', entityType: 'note', signal: 'down' }),
      makeFeedbackRow({ teamId: 'team-2', entityType: 'note', signal: 'down' }),
      makeFeedbackRow({ teamId: 'team-2', entityType: 'note', signal: 'down' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'key-123' });
    mockMemorySearch.mockResolvedValue({ results: [], total: 0, limit: 10, offset: 0 });
    mockArtifactsFindMany.mockResolvedValue([]);
    mockNotesFindMany.mockResolvedValue([]);

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(5);
    expect(result.results.length).toBe(2);
    // Both teams should have 1 memory saved each
    const team1 = result.results.find(r => r.teamId === 'team-1');
    const team2 = result.results.find(r => r.teamId === 'team-2');
    expect(team1?.memoriesSaved).toBe(1);
    expect(team2?.memoriesSaved).toBe(1);
  });

  it('skips team when no memory API key is configured', async () => {
    const rows = [
      makeFeedbackRow({ teamId: 'team-no-key', entityType: 'artifact', signal: 'dismiss' }),
      makeFeedbackRow({ teamId: 'team-no-key', entityType: 'artifact', signal: 'dismiss' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: null });

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(2);
    expect(result.results.length).toBe(0); // skipped — no memory client
    expect(mockMemorySave).not.toHaveBeenCalled();
  });

  it('skips team when MEMORY_API_URL is not set', async () => {
    delete process.env.MEMORY_API_URL;

    const rows = [
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(2);
    expect(result.results.length).toBe(0);
    expect(mockMemorySave).not.toHaveBeenCalled();
  });

  it('handles mixed signal types creating separate patterns', async () => {
    const rows = [
      // 2 dismissals on artifacts
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss' }),
      // 2 downvotes on artifacts (different pattern)
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'down' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'down' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'key-123' });
    mockMemorySearch.mockResolvedValue({ results: [], total: 0, limit: 10, offset: 0 });
    mockArtifactsFindMany.mockResolvedValue([]);

    const result = await runFeedbackDigest(24);

    // Should create 2 separate memories: artifact::dismiss and artifact::down
    expect(result.results[0].memoriesSaved).toBe(2);
    expect(mockMemorySave).toHaveBeenCalledTimes(2);
  });

  it('includes user comments in memory content', async () => {
    const rows = [
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss', comment: 'Too verbose' }),
      makeFeedbackRow({ teamId: 'team-1', entityType: 'artifact', signal: 'dismiss', comment: 'Not relevant' }),
    ];
    mockFeedbackFindMany.mockResolvedValue(rows);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'key-123' });
    mockMemorySearch.mockResolvedValue({ results: [], total: 0, limit: 10, offset: 0 });
    mockArtifactsFindMany.mockResolvedValue([]);

    const result = await runFeedbackDigest(24);

    expect(result.results[0].memoriesSaved).toBe(1);

    // Verify the save call includes comments in content
    const saveCall = mockMemorySave.mock.calls[0][0] as any;
    expect(saveCall.content).toContain('Too verbose');
    expect(saveCall.content).toContain('Not relevant');
    expect(saveCall.tags).toContain('feedback-digest');
    expect(saveCall.tags).toContain('user-preference');
    expect(saveCall.source).toBe('feedback-digest-cron');
  });
});

describe('getFeedbackStats', () => {
  beforeEach(() => {
    mockFeedbackFindMany.mockReset();
  });

  it('returns empty stats when no feedback exists', async () => {
    mockFeedbackFindMany.mockResolvedValue([]);

    const stats = await getFeedbackStats(24);

    expect(stats.total).toBe(0);
    expect(stats.bySignal).toEqual({});
    expect(stats.byEntityType).toEqual({});
  });

  it('correctly aggregates stats by signal and entity type', async () => {
    mockFeedbackFindMany.mockResolvedValue([
      { signal: 'up', entityType: 'artifact' },
      { signal: 'up', entityType: 'artifact' },
      { signal: 'down', entityType: 'note' },
      { signal: 'dismiss', entityType: 'artifact' },
      { signal: 'dismiss', entityType: 'summary' },
    ]);

    const stats = await getFeedbackStats(24);

    expect(stats.total).toBe(5);
    expect(stats.bySignal).toEqual({ up: 2, down: 1, dismiss: 2 });
    expect(stats.byEntityType).toEqual({ artifact: 3, note: 1, summary: 1 });
  });
});
