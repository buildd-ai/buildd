import { describe, it, expect, mock } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE entity-resolver is loaded.
// The worktree lacks its own node_modules; the mock lets tests run without
// a real DB connection while entity-resolver.ts uses the sql tag at module level.
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

// Dynamic import runs AFTER mock.module — entity-resolver picks up the mock sql.
const { resolveEntity, insertPendingRef } = await import('../knowledge-store/entity-resolver');

// ── Mock DB factory ───────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

/**
 * Returns a mock DB whose execute() cycles through the given response queue.
 * Out-of-bounds calls return { rows: [] }.
 */
function makeMockDb(responses: Array<{ rows: MockRow[] }> = []) {
  let callIdx = 0;
  const executeFn = mock((_sql: unknown) => {
    const resp = responses[callIdx] ?? { rows: [] };
    callIdx++;
    return Promise.resolve(resp);
  });
  return { execute: executeFn };
}

// ── resolveEntity ─────────────────────────────────────────────────────────────

describe('resolveEntity', () => {
  it('resolves on exact key match (tier 1)', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'entity-uuid-exact' }] }, // tier 1 hit
    ]);

    const result = await resolveEntity(db as any, 'ws-1', 'task:abc-123');

    expect(result).toBe('entity-uuid-exact');
    // Only one DB round-trip needed
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('resolves via alias table when exact match misses (tier 2)', async () => {
    const db = makeMockDb([
      { rows: [] },                             // tier 1 miss
      { rows: [{ id: 'entity-uuid-alias' }] }, // tier 2 hit
    ]);

    const result = await resolveEntity(db as any, 'ws-1', 'auth service');

    expect(result).toBe('entity-uuid-alias');
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('resolves via pg_trgm fuzzy match when tiers 1+2 miss (tier 3)', async () => {
    const db = makeMockDb([
      { rows: [] }, // tier 1 miss
      { rows: [] }, // tier 2 miss
      // tier 3: resolveFuzzy returns candidates ordered by similarity
      {
        rows: [{
          id: 'entity-uuid-fuzzy',
          key: 'auth-service',
          canonical_name: 'Auth Service',
        }],
      },
    ]);

    const result = await resolveEntity(db as any, 'ws-1', 'auth servic'); // typo → fuzzy

    expect(result).toBe('entity-uuid-fuzzy');
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('returns null when all three tiers miss (→ caller should queue pending ref)', async () => {
    const db = makeMockDb([
      { rows: [] }, // tier 1 miss
      { rows: [] }, // tier 2 miss
      { rows: [] }, // tier 3 miss (no fuzzy candidates)
    ]);

    const result = await resolveEntity(db as any, 'ws-1', 'completely-unknown-ref');

    expect(result).toBeNull();
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('respects kindHint — still returns the entity id on tier-1 hit', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'entity-uuid-task' }] }, // tier 1 hit (kind-filtered)
    ]);

    const result = await resolveEntity(db as any, 'ws-1', 'task:xyz', 'task');

    expect(result).toBe('entity-uuid-task');
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

// ── insertPendingRef ──────────────────────────────────────────────────────────

describe('insertPendingRef', () => {
  it('writes a pending ref row for an unresolved agent ref', async () => {
    const db = makeMockDb([{ rows: [] }]);

    await insertPendingRef(db as any, {
      workspaceId: 'ws-1',
      rawRef: 'some-unknown-concept',
      kindHint: 'concept',
      sourceChunkId: 'chunk-abc',
      source: 'agent',
    });

    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('accepts null kindHint and sourceChunkId (ingest source)', async () => {
    const db = makeMockDb([{ rows: [] }]);

    await insertPendingRef(db as any, {
      workspaceId: 'ws-1',
      rawRef: 'bare-ref',
      source: 'ingest',
    });

    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
