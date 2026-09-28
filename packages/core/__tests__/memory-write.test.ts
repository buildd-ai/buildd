/**
 * The one memory write path: every write lands in `memories` AND is mirrored
 * into the `{teamId}:memory` index, and a failed mirror is recorded (log tag +
 * counter) instead of vanishing. The write itself never fails because the
 * mirror did: the reconcile pass picks the row up later.
 */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import {
  saveMemory,
  updateMemory,
  mirrorMemoryToIndex,
  memoryIndexChunk,
  getMemoryMirrorFailureCounts,
  resetMemoryMirrorFailureCounts,
  MEMORY_MIRROR_FAILED_TAG,
} from '../memory-write';
import type { KnowledgeStore, UpsertChunk } from '../knowledge-store/types';

const TEAM = 'team-a';

const record = (over: Record<string, unknown> = {}) => ({
  id: 'mem-1', teamId: TEAM, type: 'gotcha', title: 'T', content: 'C',
  project: 'acme/widgets', tags: ['x'], files: ['a.ts'], source: 'dashboard',
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...over,
});

function recordingStore(opts: { fail?: boolean; superseded?: number } = {}) {
  const upserts: Array<{ ns: string; chunks: UpsertChunk[] }> = [];
  const store: KnowledgeStore = {
    async upsert(ns, chunks) {
      upserts.push({ ns, chunks });
      if (opts.fail) throw new Error('index down');
      return { inserted: chunks.length, updated: 0, superseded: opts.superseded ?? 0 };
    },
    async query() { return []; },
    async delete() {},
    async listNamespaces() { return []; },
  };
  return { store, upserts };
}

beforeEach(() => resetMemoryMirrorFailureCounts());

describe('memoryIndexChunk', () => {
  it('keys the chunk by memory id and carries the project in metadata', () => {
    const c = memoryIndexChunk(record() as any);
    expect(c.id).toBe('mem-1');
    expect(c.sourceType).toBe('memory');
    expect(c.lexicalText).toBe('T\n\nC');
    expect(c.metadata).toMatchObject({ memoryId: 'mem-1', project: 'acme/widgets', type: 'gotcha' });
    expect(c.supersedes).toBeUndefined();
  });
});

describe('saveMemory', () => {
  it('saves the row and mirrors it into the team memory namespace', async () => {
    const saved: unknown[] = [];
    const client = { save: async (input: any) => { saved.push(input); return { memory: record({ ...input }) as any }; } };
    const { store, upserts } = recordingStore();

    const res = await saveMemory(client, { type: 'gotcha', title: 'T', content: 'C', project: 'acme/widgets' }, {
      teamId: TEAM, knowledgeStore: store, via: 'dashboard:create',
    });

    expect(saved).toHaveLength(1);
    expect(res.mirrored).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].ns).toBe(`${TEAM}:memory`);
    expect(upserts[0].chunks[0].id).toBe('mem-1');
  });

  it('falls back to the row team when no teamId is passed', async () => {
    const client = { save: async () => ({ memory: record() as any }) };
    const { store, upserts } = recordingStore();
    await saveMemory(client, { type: 'gotcha', title: 'T', content: 'C' }, { knowledgeStore: store, via: 'feedback-digest' });
    expect(upserts[0].ns).toBe(`${TEAM}:memory`);
  });

  it('a failed mirror keeps the saved row, logs the tag and counts the failure', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const client = { save: async () => ({ memory: record() as any }) };
    const { store } = recordingStore({ fail: true });

    const res = await saveMemory(client, { type: 'gotcha', title: 'T', content: 'C' }, {
      teamId: TEAM, knowledgeStore: store, via: 'learn',
    });

    expect(res.memory.id).toBe('mem-1');
    expect(res.mirrored).toBe(false);
    expect(getMemoryMirrorFailureCounts()).toEqual({ learn: 1 });
    expect(warn.mock.calls.some(c => String(c[0]).startsWith(MEMORY_MIRROR_FAILED_TAG))).toBe(true);
    warn.mockRestore();
  });

  it('no index configured is not a failure', async () => {
    const client = { save: async () => ({ memory: record() as any }) };
    const res = await saveMemory(client, { type: 'gotcha', title: 'T', content: 'C' }, { teamId: TEAM, via: 'learn' });
    expect(res.mirrored).toBe(false);
    expect(getMemoryMirrorFailureCounts()).toEqual({});
  });

  it('passes supersedes through and reports the flipped count', async () => {
    const client = { save: async () => ({ memory: record() as any }) };
    const { store, upserts } = recordingStore({ superseded: 1 });
    const res = await saveMemory(client, { type: 'gotcha', title: 'T', content: 'C' }, {
      teamId: TEAM, knowledgeStore: store, via: 'learn', supersedes: ['old-1'],
    });
    expect(upserts[0].chunks[0].supersedes).toEqual(['old-1']);
    expect(res.superseded).toBe(1);
  });
});

describe('updateMemory', () => {
  it('updates the row and re-mirrors it', async () => {
    const client = { update: async (id: string, fields: any) => ({ memory: record({ id, ...fields }) as any }) };
    const { store, upserts } = recordingStore();
    const res = await updateMemory(client, 'mem-9', { content: 'new' }, { teamId: TEAM, knowledgeStore: store, via: 'dashboard:update' });
    expect(res.memory.id).toBe('mem-9');
    expect(upserts[0].chunks[0]).toMatchObject({ id: 'mem-9', content: 'new' });
  });

  it('a failed re-mirror is counted under its own path', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const client = { update: async () => ({ memory: record() as any }) };
    const { store } = recordingStore({ fail: true });
    await updateMemory(client, 'mem-1', { content: 'x' }, { teamId: TEAM, knowledgeStore: store, via: 'feedback-digest' });
    expect(getMemoryMirrorFailureCounts()).toEqual({ 'feedback-digest': 1 });
    warn.mockRestore();
  });
});

describe('mirrorMemoryToIndex', () => {
  it('reports a store that returns void as mirrored with zero superseded', async () => {
    const store = { ...recordingStore().store, async upsert() {} } as KnowledgeStore;
    const res = await mirrorMemoryToIndex(store, TEAM, record() as any, { via: 'reconcile' });
    expect(res).toEqual({ mirrored: true, superseded: 0 });
  });
});

describe('supersession is recorded on the rows', () => {
  it('marks the superseded rows even when the mirror failed', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const marked: Array<{ ids: string[]; by: string }> = [];
    const client = {
      save: async () => ({ memory: record({ id: 'new-1' }) as any }),
      markSuperseded: async (ids: string[], by: string) => { marked.push({ ids, by }); return ids.length; },
    };
    const { store } = recordingStore({ fail: true });
    await saveMemory(client, { type: 'gotcha', title: 'T', content: 'C' }, {
      teamId: TEAM, knowledgeStore: store, via: 'learn', supersedes: ['old-1'],
    });
    expect(marked).toEqual([{ ids: ['old-1'], by: 'new-1' }]);
    warn.mockRestore();
  });

  it('does not touch rows when nothing is superseded', async () => {
    const marked: unknown[] = [];
    const client = {
      update: async () => ({ memory: record() as any }),
      markSuperseded: async (ids: string[]) => { marked.push(ids); return 0; },
    };
    await updateMemory(client, 'mem-1', { content: 'x' }, { teamId: TEAM, knowledgeStore: recordingStore().store, via: 'dashboard:update' });
    expect(marked).toEqual([]);
  });
});
