/**
 * Guards the write/read type contract for the feedback-digest pipeline.
 *
 * feedback-digest.ts saves memories with type='pattern'.
 * apps/runner/src/buildd.ts reads them filtering type=pattern.
 *
 * If either side drifts, feedback patterns are written but never surfaced to
 * workers. A unit test on EITHER side alone won't catch this; both sides must
 * assert the same string.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── MemoryClient mock ─────────────────────────────────────────────────────────

const savedMemories: Array<{ type: string; [k: string]: unknown }> = [];

const mockMemClient = {
  search: mock(() => Promise.resolve({ results: [] })),
  save: mock((input: { type: string; [k: string]: unknown }) => {
    savedMemories.push(input);
    return Promise.resolve({ id: 'mem-1', ...input });
  }),
  batch: mock(() => Promise.resolve({ memories: [] })),
  update: mock(() => Promise.resolve({ id: 'mem-1' })),
};

mock.module('@buildd/core/memory-client', () => ({
  MemoryClient: mock(() => mockMemClient),
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

const mockFeedbackFindMany = mock(() => Promise.resolve([] as any[]));
const mockTeamsFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      userFeedback: { findMany: mockFeedbackFindMany },
      teams: { findFirst: mockTeamsFindFirst },
      missionNotes: { findMany: mock(() => Promise.resolve([])) },
      artifacts: { findMany: mock(() => Promise.resolve([])) },
    },
  },
}));

// ── Subject ───────────────────────────────────────────────────────────────────

const { runFeedbackDigest } = await import('./feedback-digest');

// Needed for getMemoryClientForTeam to construct a MemoryClient
process.env.MEMORY_API_URL = 'http://memory-api.test';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFeedbackRow(overrides: Partial<{
  id: string; teamId: string; userId: string;
  entityType: string; entityId: string; signal: string;
  comment: string | null; createdAt: Date;
}> = {}) {
  return {
    id: 'f1',
    teamId: 'team-1',
    userId: 'u1',
    entityType: 'summary',  // no db lookup needed for summary type
    entityId: 'e1',
    signal: 'down',
    comment: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runFeedbackDigest — write type', () => {
  beforeEach(() => {
    savedMemories.length = 0;
    mockMemClient.search.mockResolvedValue({ results: [] });
    mockMemClient.save.mockImplementation((input: { type: string; [k: string]: unknown }) => {
      savedMemories.push(input);
      return Promise.resolve({ id: 'mem-1', ...input });
    });
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'test-key' });
  });

  it('writes memories with type=pattern (not decision)', async () => {
    // MIN_SIGNALS_FOR_PATTERN = 2, so two rows for the same bucket
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1', signal: 'down' }),
      makeFeedbackRow({ id: 'f2', signal: 'down' }),
    ]);

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(2);
    expect(savedMemories.length).toBeGreaterThan(0);
    for (const m of savedMemories) {
      expect(m.type).toBe('pattern');
    }
  });

  it('skips buckets with fewer than 2 signals — no spurious saves', async () => {
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1', signal: 'down' }),  // only 1 signal
    ]);

    await runFeedbackDigest(24);

    expect(savedMemories.length).toBe(0);
  });

  it('returns early with no results when there is no feedback', async () => {
    mockFeedbackFindMany.mockResolvedValueOnce([]);

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(savedMemories.length).toBe(0);
  });
});
