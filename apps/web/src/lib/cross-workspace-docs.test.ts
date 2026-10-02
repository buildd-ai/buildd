import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockWorkspacesFindFirst = mock(async (_args?: any) => null as any);
const mockWorkspacesFindMany = mock(async (_args?: any) => [] as any[]);
const mockWorkersFindFirst = mock(async (_args?: any) => null as any);
const mockTasksFindFirst = mock(async (_args?: any) => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst, findMany: mockWorkspacesFindMany },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id', teamId: 'teamId' },
  workers: { id: 'id' },
  tasks: { id: 'id' },
}));

import { loadReadableDocsWorkspaces } from './cross-workspace-docs';
import { validateCrossWorkspaceDocsInput } from './cross-workspace-docs-input';

const TEAM = 'team-a';
const READER = { id: 'ws-reader', teamId: TEAM, dataClass: 'standard', gitConfig: {} as any };
const KB = { id: 'ws-kb', name: 'private-notes', teamId: TEAM, dataClass: 'sensitive', gitConfig: {} };
const PEER = { id: 'ws-peer', name: 'peer-docs', teamId: TEAM, dataClass: 'standard', gitConfig: {} };

function seed(reader: Record<string, unknown>, siblings: any[]) {
  mockWorkspacesFindFirst.mockImplementation(async () => reader);
  mockWorkspacesFindMany.mockImplementation(async () => siblings);
}

beforeEach(() => {
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindMany.mockReset();
  mockWorkersFindFirst.mockReset();
  mockTasksFindFirst.mockReset();
  mockWorkspacesFindMany.mockResolvedValue([]);
  mockWorkersFindFirst.mockResolvedValue(null);
  mockTasksFindFirst.mockResolvedValue(null);
});

describe('loadReadableDocsWorkspaces', () => {
  it('reads nothing for a workspace that did not opt in, and loads no siblings', async () => {
    seed({ ...READER, gitConfig: {} }, [KB]);
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM })).toEqual([]);
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('returns the opted-in sources of the same team', async () => {
    seed(
      { ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: KB.id, acknowledgeSensitive: true }, { workspaceId: PEER.id }] } } },
      [KB, PEER],
    );
    const out = await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM });
    expect(out.map((w) => w.id)).toEqual([KB.id, PEER.id]);
    expect(out[0]).toEqual({ id: KB.id, name: KB.name, dataClass: 'sensitive' });
  });

  it('refuses a source row belonging to another team, even if the query returned it', async () => {
    const stranger = { ...PEER, id: 'ws-stranger', teamId: 'team-b' };
    seed({ ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: stranger.id }] } } }, [stranger]);
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM })).toEqual([]);
  });

  it('refuses when the caller\'s team is not the reader workspace\'s team', async () => {
    seed({ ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: PEER.id }] } } }, [PEER]);
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: 'team-b' })).toEqual([]);
  });

  it('denies a sensitive source to a standard reader that did not acknowledge it', async () => {
    seed({ ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: KB.id }] } } }, [KB]);
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM })).toEqual([]);
  });

  it('lets a sensitive reader read a sensitive source unacknowledged', async () => {
    seed({ ...READER, dataClass: 'sensitive', gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: KB.id }] } } }, [KB]);
    const out = await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM });
    expect(out.map((w) => w.id)).toEqual([KB.id]);
  });

  it('reads a legacy gitConfig.dataClass=sensitive on the source as sensitive', async () => {
    const legacy = { ...PEER, gitConfig: { dataClass: 'sensitive' } };
    seed({ ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: legacy.id }] } } }, [legacy]);
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM })).toEqual([]);
  });

  it('denies a source whose class is missing rather than defaulting it to standard', async () => {
    const unclassified = { ...PEER, dataClass: null };
    seed({ ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: unclassified.id }] } } }, [unclassified]);
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM })).toEqual([]);
  });

  it('returns nothing on a database failure', async () => {
    mockWorkspacesFindFirst.mockRejectedValue(new Error('db down'));
    expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM })).toEqual([]);
  });

  it('returns nothing without a workspace', async () => {
    expect(await loadReadableDocsWorkspaces({ workspaceId: null, teamId: TEAM })).toEqual([]);
  });

  describe('untrusted input', () => {
    const optedIn = { ...READER, gitConfig: { crossWorkspaceDocs: { sources: [{ workspaceId: PEER.id }] } } };

    it('a reviewer worker reads nothing cross-workspace', async () => {
      seed(optedIn, [PEER]);
      mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-1' });
      mockTasksFindFirst.mockResolvedValue({ category: 'review', roleSlug: 'reviewer' });
      expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM, workerId: 'w-1' })).toEqual([]);
    });

    it('a builder worker reads the opted-in sources', async () => {
      seed(optedIn, [PEER]);
      mockWorkersFindFirst.mockResolvedValue({ taskId: 'task-1' });
      mockTasksFindFirst.mockResolvedValue({ category: 'feature', roleSlug: 'builder' });
      const out = await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM, workerId: 'w-1' });
      expect(out.map((w) => w.id)).toEqual([PEER.id]);
    });

    it('a worker whose task cannot be resolved is treated as untrusted', async () => {
      seed(optedIn, [PEER]);
      mockWorkersFindFirst.mockResolvedValue(null);
      expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM, workerId: 'w-1' })).toEqual([]);
    });

    it('a failed worker lookup is treated as untrusted', async () => {
      seed(optedIn, [PEER]);
      mockWorkersFindFirst.mockRejectedValue(new Error('db down'));
      expect(await loadReadableDocsWorkspaces({ workspaceId: READER.id, teamId: TEAM, workerId: 'w-1' })).toEqual([]);
    });
  });
});

describe('validateCrossWorkspaceDocsInput', () => {
  const self = { id: READER.id, teamId: TEAM };

  beforeEach(() => {
    mockWorkspacesFindFirst.mockImplementation(async (args: any) => {
      const wanted = args?.where?.value;
      return [KB, PEER, { ...PEER, id: 'ws-stranger', teamId: 'team-b' }].find((w) => w.id === wanted) ?? null;
    });
  });

  it('null clears the setting', async () => {
    expect(await validateCrossWorkspaceDocsInput(null, self)).toEqual({ ok: true, value: undefined });
  });

  it('accepts same-team sources', async () => {
    const out = await validateCrossWorkspaceDocsInput(
      { sources: [{ workspaceId: KB.id, acknowledgeSensitive: true }, { workspaceId: PEER.id }] },
      self,
    );
    expect(out).toEqual({
      ok: true,
      value: { sources: [{ workspaceId: KB.id, acknowledgeSensitive: true }, { workspaceId: PEER.id }] },
    });
  });

  it('accepts an empty list as a way to switch it off', async () => {
    expect(await validateCrossWorkspaceDocsInput({ sources: [] }, self)).toEqual({ ok: true, value: { sources: [] } });
  });

  it('refuses a source of another team, and one that does not exist, with the same message', async () => {
    const a = await validateCrossWorkspaceDocsInput({ sources: [{ workspaceId: 'ws-stranger' }] }, self);
    const b = await validateCrossWorkspaceDocsInput({ sources: [{ workspaceId: 'ws-missing' }] }, self);
    expect(a.ok).toBe(false);
    expect(b).toEqual(a);
  });

  it('refuses the workspace itself', async () => {
    const out = await validateCrossWorkspaceDocsInput({ sources: [{ workspaceId: READER.id }] }, self);
    expect(out.ok).toBe(false);
  });

  it('refuses malformed input', async () => {
    for (const bad of [
      'yes',
      [],
      {},
      { sources: 'a' },
      { sources: [null] },
      { sources: [{}] },
      { sources: [{ workspaceId: PEER.id, acknowledgeSensitive: 'true' }] },
      { sources: [{ workspaceId: PEER.id, extra: 1 }] },
      { sources: [{ workspaceId: PEER.id }, { workspaceId: PEER.id }] },
    ]) {
      const out = await validateCrossWorkspaceDocsInput(bad, self);
      expect(out.ok).toBe(false);
    }
  });

  it('refuses more sources than a retrieval will fan out to', async () => {
    const sources = Array.from({ length: 50 }, (_, i) => ({ workspaceId: `ws-${i}` }));
    const out = await validateCrossWorkspaceDocsInput({ sources }, self);
    expect(out.ok).toBe(false);
  });
});
