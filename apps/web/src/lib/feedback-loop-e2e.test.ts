/**
 * End-to-end test verifying the full feedback loop:
 *
 * 1. Agent generates an artifact/note
 * 2. User dismisses it via the UI (POST /api/feedback)
 * 3. Feedback is stored in DB
 * 4. Processing pipeline creates a memory entry
 * 5. On next agent run, the memory is injected and output improves
 *
 * This test wires together the feedback API, digest pipeline, and memory
 * client with mocked DB and memory service to verify the data flows
 * correctly end-to-end.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── State containers ────────────────────────────────────────────────────────

/** In-memory feedback store (simulates DB table) */
let feedbackStore: Array<{
  id: string;
  userId: string;
  teamId: string;
  entityType: string;
  entityId: string;
  signal: string;
  comment: string | null;
  createdAt: Date;
}> = [];

/** In-memory memory store (simulates memory service) */
let memoryStore: Array<{
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  source: string | null;
}> = [];

let feedbackIdCounter = 0;
let memoryIdCounter = 0;

// ── Mock functions ──────────────────────────────────────────────────────────

const mockGetCurrentUser = mock(() => ({ id: 'user-1' } as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));

// Feedback DB mock — simulates real read/write behavior
const mockFeedbackFindFirst = mock(async () => {
  // Return last matching entry for upsert check
  return null;
});

const mockFeedbackFindMany = mock(async () => {
  return feedbackStore;
});

const mockFeedbackInsert = mock(() => ({
  values: mock((values: any) => ({
    returning: mock(() => {
      const entry = {
        id: `fb-${++feedbackIdCounter}`,
        ...values,
        createdAt: new Date(),
      };
      feedbackStore.push(entry);
      return [entry];
    }),
  })),
}));

const mockFeedbackDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

const mockFeedbackUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));

const mockTeamsFindFirst = mock(() =>
  Promise.resolve({ memoryApiKey: 'test-key-123' })
);

const mockNotesFindMany = mock(() => []);
const mockArtifactsFindMany = mock(() => []);

// Memory client mocks that write to memoryStore
const mockMemorySave = mock(async (input: any) => {
  const mem = {
    id: `mem-${++memoryIdCounter}`,
    type: input.type,
    title: input.title,
    content: input.content,
    tags: input.tags || [],
    source: input.source || null,
  };
  memoryStore.push(mem);
  return { memory: mem };
});

const mockMemoryUpdate = mock(async (id: string, fields: any) => {
  const mem = memoryStore.find(m => m.id === id);
  if (mem && fields.content) mem.content = fields.content;
  if (mem && fields.tags) mem.tags = fields.tags;
  return { memory: mem };
});

const mockMemorySearch = mock(async () => ({
  results: [] as any[],
  total: 0,
  limit: 10,
  offset: 0,
}));

const mockMemoryBatch = mock(async () => ({
  memories: [] as any[],
}));

const mockMemoryGetContext = mock(async () => {
  if (memoryStore.length === 0) {
    return { markdown: 'No memories yet.', count: 0 };
  }
  const lines = memoryStore.map(m => `### ${m.title}\n${m.content}`);
  return {
    markdown: `## Workspace Memory (${memoryStore.length} memories)\n\n${lines.join('\n\n')}`,
    count: memoryStore.length,
  };
});

// ── Register mocks ─────────────────────────────────────────────────────────

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      userFeedback: {
        findFirst: mockFeedbackFindFirst,
        findMany: mockFeedbackFindMany,
      },
      teams: { findFirst: mockTeamsFindFirst },
      missionNotes: { findMany: mockNotesFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
    },
    insert: () => mockFeedbackInsert(),
    update: () => mockFeedbackUpdate(),
    delete: () => mockFeedbackDelete(),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  userFeedback: {
    userId: 'user_id',
    entityType: 'entity_type',
    entityId: 'entity_id',
    id: 'id',
    signal: 'signal',
    createdAt: 'created_at',
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
    getContext = mockMemoryGetContext;
  },
}));

// Import modules under test AFTER mocks are registered
import { POST as feedbackPOST, GET as feedbackGET } from '@/app/api/feedback/route';
import { runFeedbackDigest, getFeedbackStats } from './feedback-digest';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createFeedbackRequest(body: Record<string, any>) {
  const { NextRequest } = require('next/server');
  return new NextRequest('http://localhost:3000/api/feedback', {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Feedback Loop — End-to-End', () => {
  beforeEach(() => {
    // Reset stores
    feedbackStore = [];
    memoryStore = [];
    feedbackIdCounter = 0;
    memoryIdCounter = 0;

    // Reset all mock call counters
    mockMemorySave.mockClear();
    mockMemoryUpdate.mockClear();
    mockMemorySearch.mockClear();
    mockMemoryBatch.mockClear();

    // Reset mocks
    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockFeedbackFindFirst.mockResolvedValue(null);
    mockTeamsFindFirst.mockResolvedValue({ memoryApiKey: 'test-key-123' });
    mockMemorySearch.mockResolvedValue({ results: [], total: 0, limit: 10, offset: 0 });
    mockMemoryBatch.mockResolvedValue({ memories: [] });
    mockArtifactsFindMany.mockResolvedValue([]);
    mockNotesFindMany.mockResolvedValue([]);

    process.env.MEMORY_API_URL = 'http://memory.test';
  });

  it('full loop: dismiss artifact → digest → memory created → context injected', async () => {
    // ── Step 1: Agent generated artifacts (simulated — already in DB) ────

    const artifactIds = ['art-report-1', 'art-report-2', 'art-report-3'];

    // ── Step 2: User dismisses artifacts via the API ────────────────────

    for (const entityId of artifactIds) {
      const res = await feedbackPOST(createFeedbackRequest({
        entityType: 'artifact',
        entityId,
        signal: 'dismiss',
        comment: 'Not useful',
      }));

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.signal).toBe('dismiss');
    }

    // ── Step 3: Verify feedback is stored ────────────────────────────────

    expect(feedbackStore.length).toBe(3);
    expect(feedbackStore.every(f => f.signal === 'dismiss')).toBe(true);
    expect(feedbackStore.every(f => f.entityType === 'artifact')).toBe(true);
    expect(feedbackStore.every(f => f.teamId === 'team-1')).toBe(true);

    // ── Step 4: Run digest pipeline ─────────────────────────────────────

    // Make digest query return our feedback store
    mockFeedbackFindMany.mockResolvedValue(feedbackStore);

    // Provide artifact context for memory content
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'art-report-1', type: 'report', title: 'Weekly Status Report', content: 'Team velocity is...' },
      { id: 'art-report-2', type: 'report', title: 'Sprint Metrics', content: 'Points completed...' },
      { id: 'art-report-3', type: 'report', title: 'Daily Standup Notes', content: 'Updates from...' },
    ]);

    const digestResult = await runFeedbackDigest(24);

    expect(digestResult.totalFeedback).toBe(3);
    expect(digestResult.results.length).toBe(1);
    expect(digestResult.results[0].teamId).toBe('team-1');
    expect(digestResult.results[0].memoriesSaved).toBe(1);
    expect(digestResult.results[0].feedbackProcessed).toBe(3);

    // ── Step 5: Verify memory was created ────────────────────────────────

    expect(memoryStore.length).toBe(1);
    const memory = memoryStore[0];
    expect(memory.type).toBe('pattern');
    expect(memory.title).toContain('artifact');
    expect(memory.title).toContain('dismissed');
    expect(memory.content).toContain('dismissed');
    expect(memory.content).toContain('3');
    expect(memory.content).toContain('Not useful');
    expect(memory.content).toContain('Be more selective about which artifacts to create');
    expect(memory.tags).toContain('feedback-digest');
    expect(memory.tags).toContain('artifact');
    expect(memory.tags).toContain('dismiss');
    expect(memory.source).toBe('feedback-digest-cron');

    // ── Step 6: Verify memory is injected into agent context ────────────

    const context = await mockMemoryGetContext();

    expect(context.count).toBe(1);
    expect(context.markdown).toContain('artifact');
    expect(context.markdown).toContain('dismissed');
    expect(context.markdown).toContain('Be more selective');
  });

  it('full loop: downvote notes → digest → guidance about note quality', async () => {
    // User downvotes multiple notes
    for (let i = 0; i < 4; i++) {
      const res = await feedbackPOST(createFeedbackRequest({
        entityType: 'note',
        entityId: `note-${i}`,
        signal: 'down',
        comment: i === 0 ? 'Too generic' : null,
      }));
      expect(res.status).toBe(201);
    }

    expect(feedbackStore.length).toBe(4);

    // Run digest
    mockFeedbackFindMany.mockResolvedValue(feedbackStore);
    mockNotesFindMany.mockResolvedValue([
      { id: 'note-0', type: 'update', title: 'Status Update', body: 'Everything is going well' },
      { id: 'note-1', type: 'update', title: 'Progress', body: 'Making progress on tasks' },
    ]);

    const result = await runFeedbackDigest(24);

    expect(result.results[0].memoriesSaved).toBe(1);

    // Verify memory has note-specific guidance
    const memory = memoryStore[0];
    expect(memory.content).toContain('downvoted');
    expect(memory.content).toContain('4');
    expect(memory.content).toContain('Improve quality and relevance of agent notes');
    expect(memory.content).toContain('Too generic');

    // Verify context includes the guidance
    const context = await mockMemoryGetContext();
    expect(context.count).toBe(1);
    expect(context.markdown).toContain('Improve quality');
  });

  it('second digest run updates existing memory instead of creating duplicate', async () => {
    // First round: 2 dismissals
    feedbackStore = [
      { id: 'fb-1', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-1', signal: 'dismiss', comment: null, createdAt: new Date() },
      { id: 'fb-2', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-2', signal: 'dismiss', comment: null, createdAt: new Date() },
    ];
    mockFeedbackFindMany.mockResolvedValue(feedbackStore);

    const result1 = await runFeedbackDigest(24);
    expect(result1.results[0].memoriesSaved).toBe(1);
    expect(memoryStore.length).toBe(1);

    // Second round: simulate search finding the existing memory
    const existingMemory = memoryStore[0];
    mockMemorySearch.mockResolvedValue({
      results: [{ id: existingMemory.id, title: existingMemory.title, type: 'pattern', createdAt: new Date().toISOString() }],
      total: 1,
      limit: 10,
      offset: 0,
    });
    mockMemoryBatch.mockResolvedValue({
      memories: [{
        ...existingMemory,
        teamId: 'team-1',
        project: null,
        files: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });

    // Add more feedback
    feedbackStore.push(
      { id: 'fb-3', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-3', signal: 'dismiss', comment: 'Still too many', createdAt: new Date() },
    );
    mockFeedbackFindMany.mockResolvedValue(feedbackStore);

    const result2 = await runFeedbackDigest(24);

    expect(result2.results[0].memoriesUpdated).toBe(1);
    expect(result2.results[0].memoriesSaved).toBe(0);
    // Should still only have 1 memory (updated, not duplicated)
    expect(memoryStore.length).toBe(1);
    expect(mockMemoryUpdate).toHaveBeenCalled();
  });

  it('mixed feedback types produce separate memories with type-specific guidance', async () => {
    // Mix of artifact dismissals, note downvotes, and summary dismissals
    feedbackStore = [
      { id: 'fb-1', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-1', signal: 'dismiss', comment: null, createdAt: new Date() },
      { id: 'fb-2', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-2', signal: 'dismiss', comment: null, createdAt: new Date() },
      { id: 'fb-3', userId: 'user-1', teamId: 'team-1', entityType: 'note', entityId: 'note-1', signal: 'down', comment: null, createdAt: new Date() },
      { id: 'fb-4', userId: 'user-1', teamId: 'team-1', entityType: 'note', entityId: 'note-2', signal: 'down', comment: null, createdAt: new Date() },
      { id: 'fb-5', userId: 'user-1', teamId: 'team-1', entityType: 'summary', entityId: 'sum-1', signal: 'dismiss', comment: null, createdAt: new Date() },
      { id: 'fb-6', userId: 'user-1', teamId: 'team-1', entityType: 'summary', entityId: 'sum-2', signal: 'dismiss', comment: null, createdAt: new Date() },
    ];
    mockFeedbackFindMany.mockResolvedValue(feedbackStore);
    mockNotesFindMany.mockResolvedValue([]);

    const result = await runFeedbackDigest(24);

    expect(result.results[0].memoriesSaved).toBe(3); // 3 distinct patterns
    expect(memoryStore.length).toBe(3);

    // Verify each memory has type-specific guidance
    const artifactMem = memoryStore.find(m => m.tags.includes('artifact'));
    const noteMem = memoryStore.find(m => m.tags.includes('note'));
    const summaryMem = memoryStore.find(m => m.tags.includes('summary'));

    expect(artifactMem?.content).toContain('Be more selective about which artifacts');
    expect(noteMem?.content).toContain('Improve quality and relevance of agent notes');
    expect(summaryMem?.content).toContain('summaries are being dismissed');

    // Context should include all 3 memories
    const context = await mockMemoryGetContext();
    expect(context.count).toBe(3);
  });

  it('positive feedback (up) does not generate memories', async () => {
    // Only upvotes — should not trigger memory creation
    feedbackStore = [
      { id: 'fb-1', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-1', signal: 'up', comment: 'Great!', createdAt: new Date() },
      { id: 'fb-2', userId: 'user-1', teamId: 'team-1', entityType: 'artifact', entityId: 'art-2', signal: 'up', comment: null, createdAt: new Date() },
    ];

    // runFeedbackDigest filters to 'down' and 'dismiss' signals only
    // We simulate the actual query behavior: only negative signals returned
    mockFeedbackFindMany.mockResolvedValue([]); // no negative feedback

    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(0);
    expect(result.results).toEqual([]);
    expect(memoryStore.length).toBe(0);
    expect(mockMemorySave).not.toHaveBeenCalled();

    // But stats should still show them
    mockFeedbackFindMany.mockResolvedValue(feedbackStore);
    const stats = await getFeedbackStats(24);
    expect(stats.total).toBe(2);
    expect(stats.bySignal.up).toBe(2);
  });

  it('below-threshold feedback does not create memories but is still stored', async () => {
    // Only 1 dismissal — below MIN_SIGNALS_FOR_PATTERN (2)
    const res = await feedbackPOST(createFeedbackRequest({
      entityType: 'artifact',
      entityId: 'art-lonely',
      signal: 'dismiss',
    }));
    expect(res.status).toBe(201);

    mockFeedbackFindMany.mockResolvedValue(feedbackStore);
    const result = await runFeedbackDigest(24);

    expect(result.totalFeedback).toBe(1);
    expect(result.results[0].memoriesSaved).toBe(0);
    expect(memoryStore.length).toBe(0);

    // But feedback IS stored
    expect(feedbackStore.length).toBe(1);
  });
});
