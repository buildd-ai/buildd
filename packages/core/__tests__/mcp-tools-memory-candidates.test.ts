/**
 * Candidate writes and reads (docs/design/memory-done-right.md, "Write:
 * candidates, then promotion").
 *
 * - flag off (the default): a learn / save writes exactly what it did before;
 * - flag on: the row lands as a candidate with provenance, and the reply says so;
 * - dedupe-only (background extraction): a near-duplicate writes nothing and
 *   supersedes nothing;
 * - recall serves candidates only when asked, and a push never does.
 */
import { describe, expect, it } from 'bun:test';
import { handleLearnAction, handleMemoryAction, handleRecallAction } from '../mcp-tools';

const WS_ID = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000001';
const TASK_ID = 'cccc0000-0000-0000-0000-000000000002';
const PROJECT = 'acme/widgets';

type Row = { id: string; type: string; title: string; content: string; project: string; tags: string[]; files: string[]; source: null; state?: string };

function memClient(rows: Row[] = []) {
  const saves: any[] = [];
  const superseded: Array<{ ids: string[]; byId: string }> = [];
  const byId = new Map(rows.map(r => [r.id, r]));
  return {
    saves, superseded,
    get: async (id: string) => {
      const r = byId.get(id);
      if (!r) throw new Error('not found');
      return { memory: r };
    },
    batch: async (ids: string[]) => ({ memories: ids.flatMap(id => (byId.has(id) ? [byId.get(id)!] : [])) }),
    save: async (data: any) => {
      saves.push(data);
      return { memory: { id: 'new-id', ...data, tags: data.tags ?? [], files: data.files ?? [] } };
    },
    update: async () => { throw new Error('no update'); },
    markSuperseded: async (ids: string[], by: string) => { superseded.push({ ids, byId: by }); return ids.length; },
    findByIdPrefix: async () => [],
  };
}

function store(opts: { dupe?: { id: string; similarity: number } | null; hits?: string[] } = {}) {
  const upserts: any[] = [];
  return {
    upserts,
    async query() {
      return (opts.hits ?? []).map((id, i) => ({ id, content: `body ${id}`, score: 0.9 - i * 0.01, isCurrent: true, metadata: { memoryId: id } }));
    },
    async upsert(_ns: string, chunks: any[]) {
      upserts.push(...chunks);
      return { inserted: 1, updated: 0, superseded: chunks[0]?.supersedes?.length ?? 0 };
    },
    async delete() {},
    async listNamespaces() { return []; },
    async nearDupeCheck() {
      return opts.dupe ? [{ id: opts.dupe.id, similarity: opts.dupe.similarity, content: 'x', sourceUrl: null }] : [];
    },
  };
}

const ctx = (s: any, over: Record<string, unknown> = {}) => ({
  project: PROJECT, workspaceId: WS_ID, teamId: TEAM_ID, knowledgeStore: s, memoryLedger: () => {}, ...over,
});
const LEARN = { type: 'gotcha', title: 'T', content: 'C' };
const row = (id: string, state?: string): Row => ({
  id, type: 'gotcha', title: `title ${id}`, content: `content ${id}`, project: PROJECT, tags: [], files: [], source: null,
  ...(state ? { state } : {}),
});

describe('learn with the candidate flag off', () => {
  it('writes the same row as before: no lifecycle fields', async () => {
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(), { memoryCandidateWrites: false, taskId: TASK_ID }));
    expect(mc.saves).toHaveLength(1);
    for (const k of ['state', 'sourceKind', 'sourceId', 'external']) expect(k in mc.saves[0]).toBe(false);
    expect(res.content[0].text).toBe('Memory saved: "T" (gotcha)\nID: new-id');
  });

  it('with no flag given and no database (unit tests), stays off', async () => {
    const mc = memClient();
    await handleLearnAction(mc as any, LEARN, ctx(store()));
    expect('state' in mc.saves[0]).toBe(false);
  });
});

describe('learn with the candidate flag on', () => {
  it('lands as a candidate with learn provenance from the caller task', async () => {
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(), { memoryCandidateWrites: true, taskId: TASK_ID }));
    expect(mc.saves[0]).toMatchObject({ state: 'candidate', sourceKind: 'learn', sourceId: TASK_ID, project: PROJECT });
    expect('external' in mc.saves[0]).toBe(false);
    expect(res.content[0].text).toContain('saved as a candidate');
  });

  it('records explicit provenance, including the external floor', async () => {
    const mc = memClient();
    await handleLearnAction(mc as any, LEARN, ctx(store(), {
      memoryCandidateWrites: true, taskId: TASK_ID, memoryProvenance: { kind: 'review', id: 'review-1', external: true },
    }));
    expect(mc.saves[0]).toMatchObject({ state: 'candidate', sourceKind: 'review', sourceId: 'review-1', external: true });
  });

  it('buildd_memory save lands as a candidate too', async () => {
    const mc = memClient();
    await handleMemoryAction(mc as any, 'save', LEARN, ctx(store(), { memoryCandidateWrites: true, taskId: TASK_ID }) as any);
    expect(mc.saves[0]).toMatchObject({ state: 'candidate', sourceKind: 'learn' });
  });

  it('an auto-superseding near-duplicate still supersedes (the corroboration link)', async () => {
    const mc = memClient([row('old-id', 'candidate')]);
    await handleLearnAction(mc as any, LEARN, ctx(store({ dupe: { id: 'old-id', similarity: 0.97 } }), { memoryCandidateWrites: true, taskId: TASK_ID }));
    expect(mc.saves[0].state).toBe('candidate');
    expect(mc.superseded).toEqual([{ ids: ['old-id'], byId: 'new-id' }]);
  });
});

describe('learn in dedupe-only mode (background extraction)', () => {
  for (const similarity of [0.97, 0.9]) {
    it(`a near-duplicate at ${similarity} writes nothing and supersedes nothing`, async () => {
      const mc = memClient([row('old-id')]);
      const s = store({ dupe: { id: 'old-id', similarity } });
      const res = await handleLearnAction(mc as any, LEARN, ctx(s, { memoryCandidateWrites: true, memoryDedupeOnly: true }));
      expect(mc.saves).toHaveLength(0);
      expect(mc.superseded).toHaveLength(0);
      expect(s.upserts).toHaveLength(0);
      expect(res.content[0].text).toContain('Memory already recorded');
    });
  }

  it('a foreign-project near-duplicate does not count', async () => {
    const mc = memClient([{ ...row('old-id'), project: 'other/repo' }]);
    await handleLearnAction(mc as any, LEARN, ctx(store({ dupe: { id: 'old-id', similarity: 0.99 } }), { memoryCandidateWrites: true, memoryDedupeOnly: true }));
    expect(mc.saves).toHaveLength(1);
    expect(mc.superseded).toHaveLength(0);
  });
});

describe('recall and candidates', () => {
  const rows = [row('active-1'), row('cand-1', 'candidate'), row('exp-1', 'expired'), row('inv-1', 'invalidated'), row('legacy-1')];
  const hits = rows.map(r => r.id);
  const ids = (text: string) => hits.filter(id => text.includes(id));

  it('by default serves active rows only (a row with no state is active)', async () => {
    const res = await handleRecallAction(memClient(rows) as any, { query: 'widgets' }, ctx(store({ hits })) as any);
    expect(ids(res.content[0].text)).toEqual(['active-1', 'legacy-1']);
  });

  it('includeCandidates adds candidates, never expired or invalidated rows', async () => {
    const res = await handleRecallAction(memClient(rows) as any, { query: 'widgets', includeCandidates: true }, ctx(store({ hits })) as any);
    expect(ids(res.content[0].text)).toEqual(['active-1', 'cand-1', 'legacy-1']);
  });

  it('by id returns any state, and labels a non-active one', async () => {
    const res = await handleRecallAction(memClient(rows) as any, { id: 'exp-1' }, ctx(store()) as any);
    expect(res.content[0].text).toContain('State: expired');
    const active = await handleRecallAction(memClient(rows) as any, { id: 'active-1' }, ctx(store()) as any);
    expect(active.content[0].text).not.toContain('State:');
  });

  it('by id flags a memory for re-verification', async () => {
    const flagged = [{ ...row('rv-1'), reverifyFlaggedAt: '2026-01-01T00:00:00.000Z', reverifyRef: 'pr:42' }];
    const res = await handleRecallAction(memClient(flagged as any) as any, { id: 'rv-1' }, ctx(store()) as any);
    expect(res.content[0].text).toContain('Re-verify: files it names changed since it was written (pr:42)');
  });

  it('buildd_memory search passes active-only states unless candidates are asked for', async () => {
    const calls: any[] = [];
    const mc = { ...memClient(rows), search: async (p: any) => { calls.push(p); return { results: [], total: 0 } } };
    await handleMemoryAction(mc as any, 'search', { query: 'x' }, ctx(store()) as any);
    await handleMemoryAction(mc as any, 'search', { query: 'x', includeCandidates: true }, ctx(store()) as any);
    expect(calls[0].states).toEqual(['active']);
    expect(calls[1].states).toEqual(['active', 'candidate']);
  });
});
