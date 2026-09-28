/**
 * learn / buildd_memory save with Jev decisions wired in (keep, type, update).
 * The decider is the real one; only its transport (`fetch`) is mocked.
 */
import { describe, expect, it } from 'bun:test';
import { handleLearnAction, handleMemoryAction } from '../mcp-tools';
import { createMemoryDecider, KEEP_NOT_DURABLE_TAG, type MemoryDecisionRow } from '../memory-decisions';

const WS_ID = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000001';
const PROJECT = 'acme/widgets';

const choiceAns = (label: string, confidence: number) => ({ type: 'choice', choice: label, probabilities: { [label]: confidence }, confidence });
const noulAns = (p: number) => ({ type: 'noul', noul: p });

/** Answers keyed by which decision was asked (learn: keep+type, update: action). */
function decider(answers: { learn?: Record<string, unknown> | 'error'; update?: Record<string, unknown> | 'error' }, key: string | null = 'sk-test') {
  const rows: MemoryDecisionRow[] = [];
  const asked: string[] = [];
  const d = createMemoryDecider({
    resolveKey: async () => key,
    record: r => { rows.push(...r); },
    fetch: async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body ?? '{}'));
      const which = 'action' in req.questions ? 'update' : 'learn';
      asked.push(which);
      const a = answers[which];
      if (!a || a === 'error') return new Response('{"error":"x"}', { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ model: 'typesafe/jev-1.13-test', answers: a, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { d, rows, asked };
}

const EXISTING = {
  id: 'existing-mem-id', type: 'gotcha', title: 'Existing title', content: 'An existing memory',
  project: PROJECT, tags: ['old'], files: ['a.ts'], source: null,
};

function memClient() {
  const saves: any[] = [];
  const updates: Array<{ id: string; fields: any }> = [];
  const client = {
    saves, updates,
    get: async (id: string) => ({ memory: id === EXISTING.id ? EXISTING : { ...EXISTING, id } }),
    batch: async (ids: string[]) => ({ memories: ids.map(id => ({ ...EXISTING, id })) }),
    save: async (data: any) => {
      saves.push(data);
      return { memory: { id: 'new-id', ...data, tags: data.tags ?? [], files: data.files ?? [] } };
    },
    update: async (id: string, fields: any) => {
      updates.push({ id, fields });
      return { memory: { ...EXISTING, ...fields, id } };
    },
    markSuperseded: async () => 1,
  };
  return client;
}

function store(similarity: number | null) {
  const upserts: Array<{ supersedes?: string[] }> = [];
  return {
    upserts,
    async query() { return []; },
    async upsert(_ns: string, chunks: any[]) {
      for (const c of chunks) upserts.push({ supersedes: c.supersedes });
      return { inserted: 1, updated: 0, superseded: chunks[0]?.supersedes?.length ?? 0 };
    },
    async delete() {},
    async listNamespaces() { return []; },
    async nearDupeCheck() {
      return similarity === null ? [] : [{ id: EXISTING.id, similarity, content: EXISTING.content, sourceUrl: null }];
    },
  };
}

const ctx = (s: any, memoryDecider?: any) => ({ project: PROJECT, workspaceId: WS_ID, teamId: TEAM_ID, knowledgeStore: s, memoryDecider });
const LEARN = { type: 'gotcha', title: 'T', content: 'C', tags: ['mine'] };

describe('learn: keep and type', () => {
  it('a confident "not durable" verdict tags the row and never drops it', async () => {
    const { d, rows } = decider({ learn: { keep: noulAns(0.05), type: choiceAns('gotcha', 0.99) } });
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(null), d));
    expect(mc.saves).toHaveLength(1);
    expect(mc.saves[0].tags).toEqual(['mine', KEEP_NOT_DURABLE_TAG]);
    expect(res.content[0].text).toContain('new-id');
    expect(res.content[0].text).toContain(KEEP_NOT_DURABLE_TAG);
    expect(rows.find(r => r.decision === 'keep')).toMatchObject({ memoryId: 'new-id', applied: true, verdict: 'false' });
  });

  it('overrides the caller\'s type only above threshold, and logs both', async () => {
    const { d, rows } = decider({ learn: { keep: noulAns(0.9), type: choiceAns('pattern', 0.95) } });
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(null), d));
    expect(mc.saves[0].type).toBe('pattern');
    expect(mc.saves[0].tags).toEqual(['mine']);
    expect(res.content[0].text).toContain('type set to pattern');
    expect(rows.find(r => r.decision === 'type')).toMatchObject({ rule: 'gotcha', verdict: 'pattern', applied: true });
  });

  it('fails open to today\'s write on a decision error', async () => {
    const { d } = decider({ learn: 'error' });
    const mc = memClient();
    await handleLearnAction(mc as any, LEARN, ctx(store(null), d));
    expect(mc.saves[0]).toMatchObject({ type: 'gotcha', tags: ['mine'] });
  });

  it('with no decider the write is byte-identical to today', async () => {
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(null)));
    expect(mc.saves[0]).toMatchObject({ type: 'gotcha', tags: ['mine'] });
    expect(res.content[0].text).toBe('Memory saved: "T" (gotcha)\nID: new-id');
  });

  it('buildd_memory save applies the same keep/type judgement', async () => {
    const { d } = decider({ learn: { keep: noulAns(0.1), type: choiceAns('decision', 0.97) } });
    const mc = memClient();
    await handleMemoryAction(mc as any, 'save', LEARN, ctx(store(null), d));
    expect(mc.saves[0].type).toBe('decision');
    expect(mc.saves[0].tags).toContain(KEEP_NOT_DURABLE_TAG);
  });
});

describe('learn: the 0.88 to 0.94 band', () => {
  const keepAns = { keep: noulAns(0.9), type: choiceAns('gotcha', 0.99) };

  it('SUPERSEDE at high confidence writes new and supersedes the own-project match', async () => {
    const { d, rows } = decider({ learn: keepAns, update: { action: choiceAns('SUPERSEDE', 0.95) } });
    const mc = memClient();
    const s = store(0.91);
    const res = await handleLearnAction(mc as any, LEARN, ctx(s, d));
    expect(mc.saves).toHaveLength(1);
    expect(s.upserts[0].supersedes).toEqual([EXISTING.id]);
    expect(res.content[0].text).toContain('superseded: 1');
    expect(rows.find(r => r.decision === 'update')).toMatchObject({ verdict: 'SUPERSEDE', rule: 'conflict', applied: true, memoryId: 'new-id' });
  });

  it('UPDATE merges into the existing row (keeps its id and type, unions tags and files)', async () => {
    const { d } = decider({ learn: keepAns, update: { action: choiceAns('UPDATE', 0.97) } });
    const mc = memClient();
    const res = await handleLearnAction(mc as any, { ...LEARN, files: ['b.ts'] }, ctx(store(0.9), d));
    expect(mc.saves).toHaveLength(0);
    expect(mc.updates).toHaveLength(1);
    expect(mc.updates[0].id).toBe(EXISTING.id);
    expect(mc.updates[0].fields).toMatchObject({ title: 'T', content: 'C', tags: ['old', 'mine'], files: ['a.ts', 'b.ts'] });
    expect(mc.updates[0].fields.type).toBeUndefined();
    expect(res.content[0].text).toContain(`ID: ${EXISTING.id}`);
  });

  it('NOOP returns the existing id and writes nothing', async () => {
    const { d, rows } = decider({ learn: keepAns, update: { action: choiceAns('NOOP', 0.93) } });
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(0.92), d));
    expect(mc.saves).toHaveLength(0);
    expect(mc.updates).toHaveLength(0);
    expect(res.content[0].text).toContain('Memory already recorded');
    expect(res.content[0].text).toContain(`ID: ${EXISTING.id}`);
    expect(rows.find(r => r.decision === 'update')).toMatchObject({ verdict: 'NOOP', applied: true });
  });

  it('ADD writes a new memory without superseding', async () => {
    const { d } = decider({ learn: keepAns, update: { action: choiceAns('ADD', 0.94) } });
    const mc = memClient();
    const s = store(0.9);
    await handleLearnAction(mc as any, LEARN, ctx(s, d));
    expect(mc.saves).toHaveLength(1);
    expect(s.upserts[0].supersedes).toBeUndefined();
  });

  it('below threshold keeps today\'s conflict reply and logs the unapplied verdict', async () => {
    const { d, rows } = decider({ learn: keepAns, update: { action: choiceAns('SUPERSEDE', 0.7) } });
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(0.9), d));
    expect(res.content[0].text.toLowerCase()).toContain('near-duplicate');
    expect(mc.saves).toHaveLength(0);
    expect(rows.find(r => r.decision === 'update')).toMatchObject({ verdict: 'SUPERSEDE', applied: false });
  });

  it('a failed update call keeps today\'s conflict reply', async () => {
    const { d } = decider({ learn: keepAns, update: 'error' });
    const mc = memClient();
    const res = await handleLearnAction(mc as any, LEARN, ctx(store(0.9), d));
    expect(res.content[0].text.toLowerCase()).toContain('near-duplicate');
  });

  it('above 0.94 still auto-supersedes without asking about the band', async () => {
    const { d, asked } = decider({ learn: keepAns });
    const mc = memClient();
    const s = store(0.97);
    await handleLearnAction(mc as any, LEARN, ctx(s, d));
    expect(asked).toEqual(['learn']);
    expect(s.upserts[0].supersedes).toEqual([EXISTING.id]);
  });
});
