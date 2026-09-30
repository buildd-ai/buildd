/**
 * Evidence indexer and sweep (docs/specs/byo-evidence-storage.md, "The
 * `evidence` corpus", build breakdown item 5; AC-6, AC-7 indexing half).
 *
 * The db is injected, so the selection predicate is asserted separately on the
 * SQL PgDialect renders: a mocked query would accept any WHERE at all.
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: {} }));

import {
  evidenceIndexCandidateWhere,
  indexEvidenceObject,
  runEvidenceIndexSweep,
  EVIDENCE_INDEX_RETRY_AFTER_MS,
  PENDING_UPLOAD_GRACE_MS,
  type EvidenceIndexCandidate,
  type EvidenceIndexerDeps,
} from './evidence-indexer';
import { handleMemoryAction } from '@buildd/core/mcp-tools';
import type { KnowledgeStore, QueryResult, UpsertChunk } from '@buildd/core/knowledge-store';

const WS = 'aaaa0000-0000-0000-0000-00000000e101';
const TASK = 'cccc1111-0000-0000-0000-00000000e102';
const ROOT = 'dddd2222-0000-0000-0000-00000000e103';
const NOW = new Date('2026-09-30T12:00:00.000Z');

const FAILING_LOG = [
  '$ bun run scripts/run-unit-tests.ts',
  'apps/web/src/lib/ratchet.test.ts:',
  '(pass) ratchet > accepts equal baseline [0.20ms]',
  'error: expect(received).toBe(expected)',
  '',
  'Expected: 17',
  'Received: 19',
  '      at <anonymous> (apps/web/src/lib/ratchet.test.ts:42:30)',
  '(fail) ratchet > rejects a stale baseline [1.02ms]',
  ...Array.from({ length: 50 }, (_, i) => `(pass) other > case ${i} [0.1ms]`),
].join('\n');

/** A tiny lexical store: every query term must appear in the chunk. */
function memoryStore() {
  const chunks = new Map<string, Map<string, UpsertChunk>>();
  const deleted: Array<{ ns: string; sourcePath?: string }> = [];
  const store: KnowledgeStore & { chunks: typeof chunks; deleted: typeof deleted } = {
    chunks,
    deleted,
    async upsert(ns, cs) {
      const m = chunks.get(ns) ?? new Map();
      for (const c of cs) m.set(c.id, c);
      chunks.set(ns, m);
      return { superseded: 0 };
    },
    async deleteBySource(ns, sel) {
      deleted.push({ ns, sourcePath: sel.sourcePath });
      const m = chunks.get(ns);
      if (!m) return;
      for (const [id, c] of m) if (c.sourcePath === sel.sourcePath) m.delete(id);
    },
    async query(ns, params): Promise<QueryResult[]> {
      const terms = params.text.toLowerCase().split(/\s+/).filter(Boolean);
      return [...(chunks.get(ns)?.values() ?? [])]
        .filter(c => terms.every(t => c.content.toLowerCase().includes(t)))
        .map(c => ({
          id: c.id, namespace: ns, corpus: 'evidence' as const, sourceType: c.sourceType,
          sourcePath: c.sourcePath ?? null, sourceUrl: c.sourceUrl ?? null, content: c.content,
          metadata: c.metadata ?? {}, score: 1, isCurrent: true,
        }));
    },
    async delete() {},
    async listNamespaces() { return [...chunks.keys()]; },
  };
  return store;
}

function candidate(over: Partial<EvidenceIndexCandidate['row']> = {}, extra: Partial<EvidenceIndexCandidate> = {}): EvidenceIndexCandidate {
  return {
    row: {
      id: 'ev-0001', workspaceId: WS, taskId: TASK, rootTaskId: ROOT, workerId: 'worker-1', prNumber: 12,
      kind: 'ci_job_log', backendId: 'backend-1', objectKey: 'evidence/k.log.gz', bytes: 100, sha256: null,
      uploadState: 'stored', indexState: 'queued', expiresAt: null,
      createdAt: new Date(NOW.getTime() - 60_000), updatedAt: new Date(NOW.getTime() - 60_000),
      ...over,
    } as EvidenceIndexCandidate['row'],
    dataClass: 'standard',
    taskTitle: 'fix(ci): ratchet baseline',
    taskSummary: null,
    ...extra,
  };
}

async function* body(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text);
}

function deps(over: Partial<EvidenceIndexerDeps> & { rows?: EvidenceIndexCandidate[] } = {}) {
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const store = memoryStore();
  let rows = over.rows ?? [];
  const d: EvidenceIndexerDeps = {
    loadCandidates: async () => rows,
    openObject: async () => body(FAILING_LOG),
    store,
    updateRow: async (id, fields) => {
      updates.push({ id, fields });
      rows = rows.filter(r => r.row.id !== id || fields.indexState === 'queued' || fields.indexState === 'failed');
    },
    now: () => NOW,
    ...over,
  };
  return { d, updates, store };
}

const text = (r: { content: Array<{ text: string }> }) => r.content.map(c => c.text).join('\n');

describe('AC-6: indexed evidence is found by query_knowledge corpus=evidence', () => {
  it('returns the originating task\'s chunk for a phrase from the failure', async () => {
    const { d, store, updates } = deps({ rows: [candidate()] });
    const res = await runEvidenceIndexSweep(d);
    expect(res.indexed).toBe(1);
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'indexed' } }]);

    const out = await handleMemoryAction(null, 'query_knowledge', { query: 'rejects a stale baseline', corpus: 'evidence' }, {
      workspaceId: WS, teamId: 'team-1', knowledgeStore: store, embedder: null,
    });
    const hit = text(out);
    expect(hit).toContain(`task ${TASK.slice(0, 8)}`);
    expect(hit).toContain('Received: 19');
  });

  it('writes lineage metadata and source ids of the form <evidenceId>#<n>', async () => {
    const { d, store } = deps({ rows: [candidate()] });
    await runEvidenceIndexSweep(d);
    const chunks = [...store.chunks.get(`${WS}:evidence`)!.values()];
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((c, i) => {
      expect(c.id).toBe(`ev-0001#${i}`);
      expect(c.sourceType).toBe('evidence');
      expect(c.sourcePath).toBe('evidence/ev-0001');
      expect(c.metadata).toMatchObject({ evidenceId: 'ev-0001', taskId: TASK, rootTaskId: ROOT, prNumber: 12, kind: 'ci_job_log' });
      expect(typeof c.metadata!.errorClass).toBe('string');
    });
    const test = chunks.find(c => c.metadata!.testName === 'ratchet > rejects a stale baseline');
    expect(test?.metadata!.file).toBe('apps/web/src/lib/ratchet.test.ts');
    // Only the signal: the passing tests are not indexed.
    for (const c of chunks) expect(c.content).not.toContain('other > case');
  });

  it('clears the object\'s earlier chunks before re-indexing it', async () => {
    const { d, store } = deps({ rows: [candidate({ indexState: 'failed' })] });
    await runEvidenceIndexSweep(d);
    expect(store.deleted).toContainEqual({ ns: `${WS}:evidence`, sourcePath: 'evidence/ev-0001' });
  });
});

describe('AC-7 (indexing half): a sensitive workspace is never indexed', () => {
  it('marks the row skipped, sends nothing to the store, and purges any old chunks', async () => {
    let opened = false;
    const { d, store, updates } = deps({
      rows: [candidate({}, { dataClass: 'sensitive' })],
      openObject: async () => { opened = true; return body(FAILING_LOG); },
    });
    const res = await runEvidenceIndexSweep(d);
    expect(res.skipped).toBe(1);
    expect(opened).toBe(false);
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'skipped' } }]);
    expect(store.chunks.get(`${WS}:evidence`)?.size ?? 0).toBe(0);
    expect(store.deleted).toContainEqual({ ns: `${WS}:evidence`, sourcePath: 'evidence/ev-0001' });
  });
});

describe('sweep durability', () => {
  it('indexes a row stuck in queued on the next run', async () => {
    // Run 1: the bucket is unreachable. The row is recorded as failed, not lost.
    let reachable = false;
    const { d, updates, store } = deps({
      rows: [candidate()],
      openObject: async () => {
        if (!reachable) throw Object.assign(new Error('the storage backend cannot be reached'), { status: 502 });
        return body(FAILING_LOG);
      },
    });
    const first = await runEvidenceIndexSweep(d);
    expect(first).toMatchObject({ indexed: 0, failed: 1 });
    expect(updates[0]).toEqual({ id: 'ev-0001', fields: { indexState: 'failed' } });

    // Run 2: reachable again; the same row is re-driven and indexed.
    reachable = true;
    const second = await runEvidenceIndexSweep(d);
    expect(second).toMatchObject({ indexed: 1, failed: 0 });
    expect(updates[1]).toEqual({ id: 'ev-0001', fields: { indexState: 'indexed' } });
    expect(store.chunks.get(`${WS}:evidence`)!.size).toBeGreaterThan(0);
  });

  it('a queued row that was never picked up is indexed by the next sweep', async () => {
    const { d, updates } = deps({ rows: [candidate({ createdAt: new Date(NOW.getTime() - 3 * 86_400_000) })] });
    const res = await runEvidenceIndexSweep(d);
    expect(res.indexed).toBe(1);
    expect(updates.map(u => u.fields.indexState)).toEqual(['indexed']);
  });

  it('confirms a pending runner upload it can read, and indexes it', async () => {
    const { d, updates } = deps({ rows: [candidate({ uploadState: 'pending', kind: 'command_output' })] });
    const res = await runEvidenceIndexSweep(d);
    expect(res.indexed).toBe(1);
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'indexed', uploadState: 'stored' } }]);
  });

  it('leaves a pending row whose object is not there yet queued, inside the grace window', async () => {
    const { d, updates } = deps({
      rows: [candidate({ uploadState: 'pending', createdAt: new Date(NOW.getTime() - 60_000) })],
      openObject: async () => { throw Object.assign(new Error('missing'), { status: 410 }); },
    });
    const res = await runEvidenceIndexSweep(d);
    expect(res.deferred).toBe(1);
    // Re-stamped (still queued) so it moves to the back of the next batch.
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'queued' } }]);
  });

  it('gives up on a pending row whose object never arrived', async () => {
    const { d, updates } = deps({
      rows: [candidate({ uploadState: 'pending', createdAt: new Date(NOW.getTime() - PENDING_UPLOAD_GRACE_MS - 1) })],
      openObject: async () => { throw Object.assign(new Error('missing'), { status: 410 }); },
    });
    await runEvidenceIndexSweep(d);
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'skipped', uploadState: 'failed' } }]);
  });

  it('a store failure marks the row failed and never throws', async () => {
    const { d, updates } = deps({ rows: [candidate()] });
    d.store = { ...d.store, upsert: async () => { throw new Error('embedder down'); } } as any;
    const res = await runEvidenceIndexSweep(d);
    expect(res.failed).toBe(1);
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'failed' } }]);
  });

  it('a row with no error-bearing signal is indexed with zero chunks', async () => {
    const { d, store, updates } = deps({ rows: [candidate()], openObject: async () => body('(pass) a > b [1ms]\nDone') });
    const r = await indexEvidenceObject(candidate(), d);
    expect(r).toMatchObject({ outcome: 'indexed', chunks: 0 });
    expect(store.chunks.get(`${WS}:evidence`)?.size ?? 0).toBe(0);
    expect(updates).toEqual([{ id: 'ev-0001', fields: { indexState: 'indexed' } }]);
  });

  it('includes the CI failure digest for a CI job log', async () => {
    const log = ['2 of 90 unit test files failed:', '  apps/web/src/lib/ratchet.test.ts', 'Full output: .test-report.log'].join('\n');
    const { d, store } = deps({ rows: [candidate()], openObject: async () => body(log) });
    await runEvidenceIndexSweep(d);
    const chunks = [...store.chunks.get(`${WS}:evidence`)!.values()];
    expect(chunks.some(c => c.metadata!.errorClass === 'ci_digest' && c.content.includes('2 of 90 unit test files failed'))).toBe(true);
  });
});

describe('evidenceIndexCandidateWhere (rendered SQL)', () => {
  const dialect = new PgDialect();
  const q = dialect.sqlToQuery(evidenceIndexCandidateWhere(NOW));
  const sql = q.sql.replace(/\$\d+/g, '$?');

  it('selects queued rows and failed rows past the retry backoff', () => {
    expect(sql).toContain('"evidence_objects"."index_state" = $?');
    expect(sql).toContain('"evidence_objects"."updated_at" < $?');
    expect(q.params).toContain('queued');
    expect(q.params).toContain('failed');
    const cutoff = q.params.find(p => typeof p === 'string' && /^\d{4}-/.test(p) || p instanceof Date);
    expect(new Date(cutoff as string).getTime()).toBe(NOW.getTime() - EVIDENCE_INDEX_RETRY_AFTER_MS);
  });

  it('only considers objects that are, or may be, in the bucket', () => {
    expect(sql).toContain('"evidence_objects"."upload_state" in ($?, $?)');
    expect(q.params).toContain('pending');
    expect(q.params).toContain('stored');
  });

  it('never selects a skipped or already-indexed row', () => {
    expect(q.params).not.toContain('skipped');
    expect(q.params).not.toContain('indexed');
  });
});
