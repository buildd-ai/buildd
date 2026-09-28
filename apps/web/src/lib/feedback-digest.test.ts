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

// ── MemoryStore mock ──────────────────────────────────────────────────────────

const savedMemories: Array<{ type: string; [k: string]: unknown }> = [];

const mockMemClient = {
  search: mock(() => Promise.resolve({ results: [], total: 0 })),
  save: mock((input: { type: string; [k: string]: unknown }) => {
    savedMemories.push(input);
    return Promise.resolve({ memory: { id: 'mem-1', teamId: 'team-1', tags: [], files: [], ...input } as any });
  }),
  batch: mock(() => Promise.resolve({ memories: [] })),
  update: mock(() => Promise.resolve({ memory: { id: 'mem-1', teamId: 'team-1', type: 'pattern', title: 'T', content: 'C', tags: [], files: [], project: null } as any })),
};

// Index the digest's writes mirror into (recall reads this, not the table).
const indexUpserts: Array<{ ns: string; chunks: Array<{ id: string; metadata?: Record<string, unknown> }> }> = [];
const mockIndex = {
  upsert: mock(async (ns: string, chunks: any[]) => {
    indexUpserts.push({ ns, chunks });
    return { inserted: chunks.length, updated: 0, superseded: 0 };
  }),
  query: async () => [],
  delete: async () => {},
  listNamespaces: async () => [],
};

mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: mock(() => Promise.resolve(mockMemClient)),
  getMemoryClientForTeam: mock(() => Promise.resolve(mockMemClient)),
  getMemoryIndexStore: () => mockIndex,
}));

// ── DB mock ───────────────────────────────────────────────────────────────────

const mockFeedbackFindMany = mock(() => Promise.resolve([] as any[]));
const mockTeamsFindFirst = mock(() => Promise.resolve(null as any));

// Feedback rows carry only a team; the workspace comes from the rated entity.
const TASK_ID = '11111111-1111-4111-8111-111111111111';
type WsRow = { id: string; teamId: string; repo: string | null; name: string; dataClass: string };
let workspaceRows: WsRow[] = [];
let taskRows: Array<{ id: string; workspaceId: string }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      userFeedback: { findMany: mockFeedbackFindMany },
      teams: { findFirst: mockTeamsFindFirst },
      missionNotes: { findMany: mock(() => Promise.resolve([])) },
      artifacts: { findMany: mock(() => Promise.resolve([])) },
      missions: { findMany: mock(() => Promise.resolve([])) },
      tasks: { findMany: mock(() => Promise.resolve(taskRows)) },
      workspaces: { findMany: mock(() => Promise.resolve(workspaceRows)) },
    },
  },
}));

// ── Subject ───────────────────────────────────────────────────────────────────

const { runFeedbackDigest } = await import('./feedback-digest');

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
    entityType: 'summary',  // resolves to its task's workspace
    entityId: `task-${TASK_ID}-summary`,
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
    indexUpserts.length = 0;
    workspaceRows = [{ id: 'ws-1', teamId: 'team-1', repo: 'https://github.com/acme/widgets', name: 'widgets', dataClass: 'standard' }];
    taskRows = [{ id: TASK_ID, workspaceId: 'ws-1' }];
    mockMemClient.search.mockResolvedValue({ results: [], total: 0 });
    mockMemClient.save.mockImplementation((input: { type: string; [k: string]: unknown }) => {
      savedMemories.push(input);
      return Promise.resolve({ memory: { id: 'mem-1', teamId: 'team-1', tags: [], files: [], ...input } as any });
    });
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

  it('files the memory under the rated workspace project key, so project-scoped reads see it', async () => {
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1' }),
      makeFeedbackRow({ id: 'f2' }),
    ]);

    await runFeedbackDigest(24);

    expect(savedMemories).toHaveLength(1);
    expect(savedMemories[0].project).toBe('acme/widgets');
  });

  it('mirrors the saved memory into the team memory index', async () => {
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1' }),
      makeFeedbackRow({ id: 'f2' }),
    ]);

    await runFeedbackDigest(24);

    expect(indexUpserts).toHaveLength(1);
    expect(indexUpserts[0].ns).toBe('team-1:memory');
    expect(indexUpserts[0].chunks[0].metadata?.project).toBe('acme/widgets');
  });

  it('writes nothing for feedback whose workspace cannot be resolved (no projectless memory)', async () => {
    taskRows = [];
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1' }),
      makeFeedbackRow({ id: 'f2' }),
    ]);

    await runFeedbackDigest(24);

    expect(savedMemories).toHaveLength(0);
  });

  it('writes nothing for a key shared with a sensitive workspace (same rule as memoryProjectKey)', async () => {
    workspaceRows = [
      ...workspaceRows,
      { id: 'ws-s', teamId: 'team-1', repo: 'https://github.com/acme/widgets', name: 'widgets-s', dataClass: 'sensitive' },
    ];
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1' }),
      makeFeedbackRow({ id: 'f2' }),
    ]);

    await runFeedbackDigest(24);

    expect(savedMemories).toHaveLength(0);
  });

  it('keeps separate patterns per project', async () => {
    const OTHER_TASK = '22222222-2222-4222-8222-222222222222';
    workspaceRows = [
      ...workspaceRows,
      { id: 'ws-2', teamId: 'team-1', repo: 'https://github.com/acme/gadgets', name: 'gadgets', dataClass: 'standard' },
    ];
    taskRows = [...taskRows, { id: OTHER_TASK, workspaceId: 'ws-2' }];
    mockFeedbackFindMany.mockResolvedValueOnce([
      makeFeedbackRow({ id: 'f1' }),
      makeFeedbackRow({ id: 'f2' }),
      makeFeedbackRow({ id: 'f3', entityId: `task-${OTHER_TASK}-summary` }),
      makeFeedbackRow({ id: 'f4', entityId: `task-${OTHER_TASK}-suggestion` }),
    ]);

    await runFeedbackDigest(24);

    expect(savedMemories.map(m => m.project).sort()).toEqual(['acme/gadgets', 'acme/widgets']);
  });
});
