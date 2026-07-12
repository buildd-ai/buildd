import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE consolidation is loaded — identical
// shape to the mock in knowledge-supersession.test.ts (bun's mock.module is
// process-global; keeping the shape identical makes full-suite and standalone
// runs behave the same).
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

mock.module('../db/index', () => ({ db: mockDb }));

// Dynamic import runs AFTER mock.module — consolidation picks up the mocks.
const {
  findNearDuplicates,
  findDecayedUnused,
  archiveChunks,
  WEEKLY_CONSOLIDATION_SCHEDULE,
} = await import('../knowledge-store/consolidation');
const { HALF_LIFE_DAYS } = await import('../knowledge-store/recency-authority');

beforeEach(() => {
  executed = [];
  responder = () => ({ rows: [] });
});

// ── findNearDuplicates ────────────────────────────────────────────────────────

describe('findNearDuplicates', () => {
  it('returns [] without SQL when no namespaces are given', async () => {
    const pairs = await findNearDuplicates([]);
    expect(pairs).toEqual([]);
    expect(executed).toHaveLength(0);
  });

  it('self-joins current embedded chunks within the same namespace above the threshold', async () => {
    responder = () => ({
      rows: [{
        namespace: 'team-1:memory',
        source_id_a: 'mem-1',
        source_id_b: 'mem-2',
        similarity: '0.9612',
        preview_a: 'neon http driver has no transactions',
        preview_b: 'no db.transaction() on neon-http',
        source_ts_a: '2026-06-01T00:00:00.000Z',
        source_ts_b: '2026-05-01T00:00:00.000Z',
        hit_count_a: 4,
        hit_count_b: 0,
      }],
    });

    const pairs = await findNearDuplicates(['team-1:memory', 'ws-1:task']);

    expect(executed).toHaveLength(1);
    const q = executed[0];
    // Bounded candidate set: current, embedded chunks only, recency-ordered, capped
    expect(q.text).toContain('is_current = true');
    expect(q.text).toContain('embedding IS NOT NULL');
    expect(q.text).toContain('LIMIT');
    expect(q.values).toContain('team-1:memory');
    expect(q.values).toContain('ws-1:task');
    // Pairs form within one namespace only, deduped by id ordering
    expect(q.text).toContain('a.namespace = b.namespace');
    expect(q.text).toContain('a.id < b.id');
    // Cosine similarity via pgvector distance operator, default threshold 0.92
    expect(q.text).toContain('<=>');
    expect(q.values).toContain(0.92);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      namespace: 'team-1:memory',
      sourceIdA: 'mem-1',
      sourceIdB: 'mem-2',
      hitCountA: 4,
      hitCountB: 0,
    });
    expect(pairs[0].similarity).toBeCloseTo(0.9612);
  });

  it('honours a custom threshold and caps limit and candidateLimit', async () => {
    await findNearDuplicates('ws-1:task', { threshold: 0.85, limit: 10_000, candidateLimit: 999_999 });

    const q = executed[0];
    expect(q.values).toContain(0.85);
    // Hard caps so the self-join cannot melt the DB
    expect(q.values).toContain(200);   // limit cap
    expect(q.values).toContain(2000);  // candidate cap
  });
});

// ── findDecayedUnused ─────────────────────────────────────────────────────────

describe('findDecayedUnused', () => {
  it('returns [] without SQL when no namespaces are given', async () => {
    const rows = await findDecayedUnused([]);
    expect(rows).toEqual([]);
    expect(executed).toHaveLength(0);
  });

  it('selects zero-hit current chunks older than 6× the corpus half-life', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    responder = () => ({
      rows: [{
        namespace: 'ws-1:task',
        source_id: 'task:t-old',
        corpus: 'task',
        source_ts: '2025-01-01T00:00:00.000Z',
        hit_count: 0,
        preview: 'stale outcome',
      }],
    });

    const rows = await findDecayedUnused(['ws-1:task', 'ws-1:artifact'], { now });

    expect(executed).toHaveLength(1);
    const q = executed[0];
    expect(q.text).toContain('is_current = true');
    expect(q.text).toContain('hit_count = 0');
    // Chunks without a source_ts are never judged decayed (conservative)
    expect(q.text).toContain('source_ts IS NOT NULL');

    // Per-corpus cutoff = now − 6 × half-life (task and artifact are both 30d → 180d)
    const taskCutoff = new Date(now.getTime() - 6 * HALF_LIFE_DAYS.task * 24 * 60 * 60 * 1000);
    const artifactCutoff = new Date(now.getTime() - 6 * HALF_LIFE_DAYS.artifact * 24 * 60 * 60 * 1000);
    expect(q.values).toContain(taskCutoff.toISOString());
    expect(q.values).toContain(artifactCutoff.toISOString());
    expect(q.values).toContain('ws-1:task');
    expect(q.values).toContain('ws-1:artifact');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      namespace: 'ws-1:task',
      sourceId: 'task:t-old',
      corpus: 'task',
      hitCount: 0,
    });
  });

  it('applies a custom halfLifeMultiple', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    await findDecayedUnused('ws-1:pr', { halfLifeMultiple: 2, now });

    const cutoff = new Date(now.getTime() - 2 * HALF_LIFE_DAYS.pr * 24 * 60 * 60 * 1000);
    expect(executed[0].values).toContain(cutoff.toISOString());
  });

  it('skips namespaces whose corpus segment is unknown', async () => {
    const rows = await findDecayedUnused(['ws-1:bogus', 'no-corpus-segment']);
    expect(rows).toEqual([]);
    expect(executed).toHaveLength(0);
  });
});

// ── archiveChunks ─────────────────────────────────────────────────────────────

describe('archiveChunks', () => {
  it('flips is_current atomically and returns the archived source ids', async () => {
    responder = (text) =>
      text.includes('UPDATE knowledge_chunks')
        ? { rows: [{ source_id: 'task:t-1' }, { source_id: 'task:t-2' }] }
        : { rows: [] };

    const result = await archiveChunks('ws-1:task', ['task:t-1', 'task:t-2', 'task:missing']);

    expect(executed).toHaveLength(1);
    const q = executed[0];
    // Archive is supersession without a successor — audit-recoverable, nothing deleted
    expect(q.text).toContain('UPDATE knowledge_chunks');
    expect(q.text).toContain('is_current = false');
    expect(q.text).toContain('superseded_by');
    expect(q.text).not.toContain('DELETE');
    // Namespace-scoped, current-only, id-listed
    expect(q.values).toContain('ws-1:task');
    expect(q.values).toContain('task:t-1');
    expect(q.values).toContain('task:t-2');
    expect(q.text).toContain('is_current = true');

    expect(result.archived).toBe(2);
    expect(result.sourceIds).toEqual(['task:t-1', 'task:t-2']);
  });

  it('records an audit marker in superseded_by', async () => {
    await archiveChunks('ws-1:task', ['task:t-1']);
    expect(executed[0].values).toContain('archived:consolidation');
  });

  it('accepts a custom reason marker', async () => {
    await archiveChunks('ws-1:task', ['task:t-1'], { reason: 'archived:weekly-run' });
    expect(executed[0].values).toContain('archived:weekly-run');
  });

  it('issues no SQL for an empty id list', async () => {
    const result = await archiveChunks('ws-1:task', []);
    expect(result).toEqual({ archived: 0, sourceIds: [] });
    expect(executed).toHaveLength(0);
  });
});

// ── Weekly schedule template ──────────────────────────────────────────────────

describe('WEEKLY_CONSOLIDATION_SCHEDULE', () => {
  it('is a complete taskSchedules payload with a weekly cron', async () => {
    expect(WEEKLY_CONSOLIDATION_SCHEDULE.name).toBe('knowledge-consolidation');
    // 5-field cron, weekly (day-of-week set, day-of-month wildcard)
    const fields = WEEKLY_CONSOLIDATION_SCHEDULE.cronExpression.split(' ');
    expect(fields).toHaveLength(5);
    expect(fields[2]).toBe('*');
    expect(fields[4]).not.toBe('*');
    expect(WEEKLY_CONSOLIDATION_SCHEDULE.taskTemplate.title.length).toBeGreaterThan(0);
  });

  it('prompt covers spec §5 steps 1–4: find dups, merge via memory service, archive decayed, report', () => {
    const prompt = WEEKLY_CONSOLIDATION_SCHEDULE.taskTemplate.description ?? '';
    expect(prompt).toContain('consolidate_knowledge');
    expect(prompt).toContain('find_duplicates');
    expect(prompt).toContain('find_decayed');
    expect(prompt).toContain('archive');
    // Memory service is the source of truth for merges
    expect(prompt).toContain('buildd_memory');
    expect(prompt).toContain('supersedes');
    // Ends with an auditable consolidation report artifact
    expect(prompt).toContain('create_artifact');
    // Nothing is deleted
    expect(prompt.toLowerCase()).toContain('never delete');
  });
});
