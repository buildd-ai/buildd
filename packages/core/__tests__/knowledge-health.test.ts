import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE health is loaded — identical shape to the
// mock in knowledge-consolidation.test.ts (bun's mock.module is process-global;
// keeping the shape identical makes full-suite and standalone runs behave the
// same).
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

// ── Recording DB mock ─────────────────────────────────────────────────────────

interface Executed {
  text: string;
  values: unknown[];
}

let executed: Executed[] = [];
let responder: (text: string) => { rows: Array<Record<string, unknown>> } = () => ({ rows: [] });

/** Flatten a mocked sql fragment (strings/values or join parts) into text. */
function flattenSql(q: any): string {
  if (q === null || q === undefined) return '';
  if (typeof q !== 'object') return JSON.stringify(q);
  if (Array.isArray(q.parts)) return q.parts.map(flattenSql).join(', ');
  if (q.strings) {
    let out = '';
    const strings: string[] = Array.from(q.strings);
    const values: unknown[] = q.values ?? [];
    strings.forEach((s, i) => {
      out += s;
      if (i < values.length) {
        const v: any = values[i];
        out += v && typeof v === 'object' && (v.strings || v.parts) ? flattenSql(v) : JSON.stringify(v);
      }
    });
    return out;
  }
  return '';
}

/** Recursively collect scalar bind values from a mocked sql fragment. */
function collectValues(q: any, acc: unknown[] = []): unknown[] {
  if (q === null || q === undefined || typeof q !== 'object') {
    acc.push(q);
    return acc;
  }
  if (Array.isArray(q.parts)) {
    for (const p of q.parts) collectValues(p, acc);
    return acc;
  }
  if (q.strings) {
    for (const v of q.values ?? []) collectValues(v, acc);
    return acc;
  }
  acc.push(q);
  return acc;
}

const mockDb = {
  execute: (q: unknown) => {
    const text = flattenSql(q);
    executed.push({ text, values: collectValues(q) });
    return Promise.resolve(responder(text));
  },
};

// Dynamic import runs AFTER mock.module — health picks up the mocked sql.
const { computeFreshness, getKnowledgeHealth, ALL_CORPORA, DEFAULT_STALE_AFTER_DAYS } = await import(
  '../knowledge-store/health'
);

beforeEach(() => {
  executed = [];
  responder = () => ({ rows: [] });
});

// ── computeFreshness (pure verdict logic) ──────────────────────────────────────

describe('computeFreshness', () => {
  it("returns 'no-index' when there is no code index, regardless of timestamp", () => {
    expect(computeFreshness({ hasCodeIndex: false, lastSuccessfulIngestAt: new Date() })).toBe('no-index');
    expect(computeFreshness({ hasCodeIndex: false, lastSuccessfulIngestAt: null })).toBe('no-index');
  });

  it("returns 'stale' when a code index exists but no successful ingest is recorded", () => {
    expect(computeFreshness({ hasCodeIndex: true, lastSuccessfulIngestAt: null })).toBe('stale');
  });

  it("returns 'fresh' when the last successful ingest is within the window", () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const recent = new Date('2026-07-10T00:00:00Z'); // 2 days ago
    expect(computeFreshness({ hasCodeIndex: true, lastSuccessfulIngestAt: recent, now })).toBe('fresh');
  });

  it("returns 'stale' when the last successful ingest is older than the window", () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const old = new Date('2026-06-01T00:00:00Z'); // ~41 days ago
    expect(computeFreshness({ hasCodeIndex: true, lastSuccessfulIngestAt: old, now })).toBe('stale');
  });

  it('respects a custom staleAfterDays threshold', () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const fiveDaysAgo = new Date('2026-07-07T00:00:00Z');
    expect(
      computeFreshness({ hasCodeIndex: true, lastSuccessfulIngestAt: fiveDaysAgo, now, staleAfterDays: 3 }),
    ).toBe('stale');
    expect(
      computeFreshness({ hasCodeIndex: true, lastSuccessfulIngestAt: fiveDaysAgo, now, staleAfterDays: 7 }),
    ).toBe('fresh');
  });

  it('treats an ingest exactly at the boundary as fresh (strictly greater is stale)', () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const exactly14 = new Date('2026-06-28T00:00:00Z'); // exactly 14 days
    expect(
      computeFreshness({ hasCodeIndex: true, lastSuccessfulIngestAt: exactly14, now, staleAfterDays: 14 }),
    ).toBe('fresh');
  });

  it('defaults staleAfterDays to DEFAULT_STALE_AFTER_DAYS (14)', () => {
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(14);
  });
});

// ── getKnowledgeHealth (query shaping + payload assembly) ───────────────────────

describe('getKnowledgeHealth', () => {
  it('enumerates every corpus namespace and filters is_current in the chunk query', async () => {
    await getKnowledgeHealth('ws-1', { db: mockDb });

    const chunkQuery = executed[0].text;
    expect(chunkQuery).toContain('knowledge_chunks');
    expect(chunkQuery).toContain('is_current = true');
    expect(chunkQuery).toContain('GROUP BY corpus');
    // Every corpus namespace is bound in the first query's values.
    const boundValues = executed[0].values.map((v) => String(v));
    for (const corpus of ALL_CORPORA) {
      expect(boundValues).toContain(`ws-1:${corpus}`);
    }
  });

  it('scopes ingest-job and pending-ref queries to the workspace', async () => {
    await getKnowledgeHealth('ws-1', { db: mockDb });

    const allText = executed.map((e) => e.text).join('\n');
    expect(allText).toContain('knowledge_ingest_jobs');
    expect(allText).toContain('DISTINCT ON (repo)');
    expect(allText).toContain("status = 'done'");
    expect(allText).toContain('pending_entity_refs');
    expect(allText).toContain('resolved_at IS NULL');
    expect(allText).toContain('workspace_id');
  });

  it("assembles a 'no-index' payload when no code chunks exist", async () => {
    responder = (text) => {
      if (text.includes('GROUP BY corpus')) {
        return { rows: [{ corpus: 'memory', current_chunks: 5 }] };
      }
      return { rows: [] };
    };

    const health = await getKnowledgeHealth('ws-1', { db: mockDb });
    expect(health.hasCodeIndex).toBe(false);
    expect(health.freshness).toBe('no-index');
    expect(health.totalCurrentChunks).toBe(5);
    expect(health.corpora).toEqual([{ corpus: 'memory', currentChunks: 5 }]);
    expect(health.lastIngestByRepo).toEqual([]);
    expect(health.pendingEntityRefs).toBe(0);
    expect(health.lastSuccessfulIngestAt).toBeNull();
  });

  it("assembles a 'fresh' payload with per-repo latest ingest and pending refs", async () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const finished = '2026-07-11T00:00:00Z';
    responder = (text) => {
      if (text.includes('GROUP BY corpus')) {
        return {
          rows: [
            { corpus: 'code', current_chunks: 120 },
            { corpus: 'memory', current_chunks: 8 },
          ],
        };
      }
      if (text.includes('DISTINCT ON (repo)')) {
        return {
          rows: [
            {
              repo: 'org/app',
              sha: 'abc123',
              status: 'done',
              scope: 'diff',
              trigger: 'pr_merged',
              pr_number: 42,
              finished_at: finished,
              created_at: finished,
              error: null,
            },
          ],
        };
      }
      if (text.includes("status = 'done'")) {
        return { rows: [{ last_done: finished }] };
      }
      if (text.includes('pending_entity_refs')) {
        return { rows: [{ pending: 3 }] };
      }
      return { rows: [] };
    };

    const health = await getKnowledgeHealth('ws-1', { db: mockDb, now });
    expect(health.hasCodeIndex).toBe(true);
    expect(health.freshness).toBe('fresh');
    expect(health.totalCurrentChunks).toBe(128);
    expect(health.lastIngestByRepo).toHaveLength(1);
    expect(health.lastIngestByRepo[0]).toMatchObject({
      repo: 'org/app',
      sha: 'abc123',
      status: 'done',
      scope: 'diff',
      prNumber: 42,
    });
    expect(health.lastSuccessfulIngestAt).toEqual(new Date(finished));
    expect(health.pendingEntityRefs).toBe(3);
  });

  it("assembles a 'stale' payload when the last code ingest is old", async () => {
    const now = new Date('2026-07-12T00:00:00Z');
    const old = '2026-05-01T00:00:00Z';
    responder = (text) => {
      if (text.includes('GROUP BY corpus')) {
        return { rows: [{ corpus: 'code', current_chunks: 50 }] };
      }
      if (text.includes("status = 'done'")) {
        return { rows: [{ last_done: old }] };
      }
      return { rows: [] };
    };

    const health = await getKnowledgeHealth('ws-1', { db: mockDb, now });
    expect(health.hasCodeIndex).toBe(true);
    expect(health.freshness).toBe('stale');
  });

  it('sorts multiple repos by most-recent job first', async () => {
    responder = (text) => {
      if (text.includes('DISTINCT ON (repo)')) {
        return {
          rows: [
            { repo: 'org/old', sha: 's1', status: 'done', scope: 'full', trigger: 'backfill', pr_number: null, finished_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', error: null },
            { repo: 'org/new', sha: 's2', status: 'done', scope: 'diff', trigger: 'pr_merged', pr_number: 9, finished_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:00Z', error: null },
          ],
        };
      }
      return { rows: [] };
    };

    const health = await getKnowledgeHealth('ws-1', { db: mockDb });
    expect(health.lastIngestByRepo.map((r) => r.repo)).toEqual(['org/new', 'org/old']);
  });
});
