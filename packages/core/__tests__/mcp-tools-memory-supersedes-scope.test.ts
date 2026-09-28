/**
 * Invariant: an explicit `supersedes` on learn / buildd_memory save / update only
 * ever affects the caller's own project memories. The `{teamId}:memory`
 * namespace is team-wide, so an id from another project (or one that does not
 * exist) must leave the index untouched, and the reply must not distinguish
 * the two cases.
 *
 * Also: every write path mirrors through the one write helper, and a failed
 * mirror is recorded instead of swallowed.
 */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { handleLearnAction, handleMemoryAction } from '../mcp-tools';
import { getMemoryMirrorFailureCounts, resetMemoryMirrorFailureCounts, MEMORY_MIRROR_FAILED_TAG } from '../memory-write';
import type { KnowledgeStore, UpsertChunk } from '../knowledge-store/types';

const TEAM_ID = 'team-supersede';
const OWN = 'acme/widgets';
const FOREIGN = 'acme/secret-thing';

type Row = { id: string; project: string | null };

function makeMemStore(rows: Row[]) {
  const full = (r: Row) => ({ type: 'gotcha', title: 'T', content: 'C', tags: [], files: [], source: null, ...r });
  return {
    async batch(ids: string[]) {
      return { memories: ids.map(id => rows.find(r => r.id === id)).filter(Boolean).map(r => full(r!)) };
    },
    async get(id: string) {
      const r = rows.find(x => x.id === id);
      if (!r) throw new Error(`Memory not found: ${id}`);
      return { memory: full(r) };
    },
    async save(input: any) { return { memory: full({ id: 'new-mem', project: input.project ?? null, ...input }) }; },
    async update(id: string, fields: any) { return { memory: full({ id, project: OWN, ...fields }) }; },
    async search() { return { results: [], total: 0, limit: 10, offset: 0 }; },
  };
}

/** Index with real is_current state: an explicit supersedes flips current rows, like the pg store. */
function statefulIndex(sourceIds: string[]) {
  const current = new Map(sourceIds.map(id => [id, true]));
  const upserts: UpsertChunk[] = [];
  const store: KnowledgeStore = {
    async upsert(_ns, chunks) {
      let superseded = 0;
      for (const c of chunks) {
        upserts.push(c);
        current.set(c.id, true);
        for (const t of c.supersedes ?? []) {
          if (t !== c.id && current.get(t) === true) { current.set(t, false); superseded++; }
        }
      }
      return { inserted: chunks.length, updated: 0, superseded };
    },
    async query() { return []; },
    async delete() {},
    async listNamespaces() { return []; },
  };
  return { store, current, upserts };
}

const ctxFor = (ks: KnowledgeStore) => ({ workspaceId: 'ws-own', teamId: TEAM_ID, project: OWN, knowledgeStore: ks, embedder: null as any });

const ROWS: Row[] = [
  { id: 'own-old', project: OWN },
  { id: 'foreign-old', project: FOREIGN },
  { id: 'teamwide-old', project: null },
];

/** Replace the one id that differs per call so replies can be compared. */
const replyOf = (res: { content: Array<{ text: string }> }) => res.content[0].text;

beforeEach(() => resetMemoryMirrorFailureCounts());

describe('learn supersedes: caller project only', () => {
  it('a foreign id stays is_current and only the own id is sent to the index', async () => {
    const { store, current, upserts } = statefulIndex(['own-old', 'foreign-old', 'teamwide-old']);
    const res = await handleLearnAction(makeMemStore(ROWS) as any, {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['own-old', 'foreign-old', 'teamwide-old', 'missing-id'],
    }, ctxFor(store));

    expect(res.isError).toBeFalsy();
    expect(current.get('foreign-old')).toBe(true);
    expect(current.get('teamwide-old')).toBe(true);
    expect(current.get('own-old')).toBe(false);
    expect(upserts[0].supersedes).toEqual(['own-old']);
    expect(replyOf(res)).toContain('superseded: 1');
  });

  it('a foreign id and a missing id produce the same reply', async () => {
    const a = statefulIndex(['foreign-old']);
    const foreign = await handleLearnAction(makeMemStore(ROWS) as any, {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['foreign-old'],
    }, ctxFor(a.store));
    const b = statefulIndex(['foreign-old']);
    const missing = await handleLearnAction(makeMemStore(ROWS) as any, {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['missing-id'],
    }, ctxFor(b.store));

    expect(a.current.get('foreign-old')).toBe(true);
    expect(replyOf(foreign)).toBe(replyOf(missing));
    expect(replyOf(foreign)).toContain('superseded: 0');
    // Nothing to supersede: the chunk is written without a supersedes list.
    expect(a.upserts[0].supersedes).toBeUndefined();
  });

  it('a failed row lookup supersedes nothing (fail closed)', async () => {
    const { store, current } = statefulIndex(['own-old']);
    const mc = { ...makeMemStore(ROWS), async batch() { throw new Error('db down'); } };
    const res = await handleLearnAction(mc as any, {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['own-old'],
    }, ctxFor(store));
    expect(res.isError).toBeFalsy();
    expect(current.get('own-old')).toBe(true);
  });
});

describe('buildd_memory save/update supersedes: caller project only', () => {
  it('save leaves a foreign id current', async () => {
    const { store, current, upserts } = statefulIndex(['own-old', 'foreign-old']);
    const res = await handleMemoryAction(makeMemStore(ROWS) as any, 'save', {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['own-old', 'foreign-old'],
    }, ctxFor(store));
    expect(res.isError).toBeFalsy();
    expect(current.get('foreign-old')).toBe(true);
    expect(current.get('own-old')).toBe(false);
    expect(upserts[0].supersedes).toEqual(['own-old']);
  });

  it('save replies the same for a foreign and a missing id', async () => {
    const a = await handleMemoryAction(makeMemStore(ROWS) as any, 'save', {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['foreign-old'],
    }, ctxFor(statefulIndex(['foreign-old']).store));
    const b = await handleMemoryAction(makeMemStore(ROWS) as any, 'save', {
      type: 'gotcha', title: 'T', content: 'C', supersedes: ['missing-id'],
    }, ctxFor(statefulIndex(['foreign-old']).store));
    expect(replyOf(a)).toBe(replyOf(b));
  });

  it('update leaves a foreign id current', async () => {
    const { store, current, upserts } = statefulIndex(['own-old', 'foreign-old']);
    const res = await handleMemoryAction(makeMemStore([...ROWS, { id: 'own-edit', project: OWN }]) as any, 'update', {
      id: 'own-edit', content: 'new', supersedes: ['foreign-old', 'own-old'],
    }, ctxFor(store));
    expect(res.isError).toBeFalsy();
    expect(current.get('foreign-old')).toBe(true);
    expect(current.get('own-old')).toBe(false);
    expect(upserts[0].supersedes).toEqual(['own-old']);
  });

  it('update replies the same for a foreign and a missing id', async () => {
    const rows = [...ROWS, { id: 'own-edit', project: OWN }];
    const a = await handleMemoryAction(makeMemStore(rows) as any, 'update', {
      id: 'own-edit', content: 'new', supersedes: ['foreign-old'],
    }, ctxFor(statefulIndex(['foreign-old']).store));
    const b = await handleMemoryAction(makeMemStore(rows) as any, 'update', {
      id: 'own-edit', content: 'new', supersedes: ['missing-id'],
    }, ctxFor(statefulIndex(['foreign-old']).store));
    expect(replyOf(a)).toBe(replyOf(b));
  });
});

describe('learn mirror failures are visible', () => {
  it('a failed mirror still saves, and is logged and counted', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const failing: KnowledgeStore = {
      ...statefulIndex([]).store,
      async upsert() { throw new Error('index down'); },
    };
    const res = await handleLearnAction(makeMemStore(ROWS) as any, { type: 'gotcha', title: 'T', content: 'C' }, ctxFor(failing));
    expect(res.isError).toBeFalsy();
    expect(replyOf(res)).toContain('Memory saved');
    expect(getMemoryMirrorFailureCounts()).toEqual({ learn: 1 });
    expect(warn.mock.calls.some(c => String(c[0]).startsWith(MEMORY_MIRROR_FAILED_TAG))).toBe(true);
    warn.mockRestore();
  });

  it('buildd_memory save and update failures are counted under their own path', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const failing: KnowledgeStore = {
      ...statefulIndex([]).store,
      async upsert() { throw new Error('index down'); },
    };
    const mc = makeMemStore([...ROWS, { id: 'own-edit', project: OWN }]);
    await handleMemoryAction(mc as any, 'save', { type: 'gotcha', title: 'T', content: 'C' }, ctxFor(failing));
    await handleMemoryAction(mc as any, 'update', { id: 'own-edit', content: 'x' }, ctxFor(failing));
    expect(getMemoryMirrorFailureCounts()).toEqual({ 'buildd_memory:save': 1, 'buildd_memory:update': 1 });
    warn.mockRestore();
  });
});
