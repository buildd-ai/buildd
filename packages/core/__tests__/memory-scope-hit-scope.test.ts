/**
 * resolveMemoryHitScope: the DB-backed scope for server-side memory reads
 * (claim-time and planning prior work, authoring prior work). Fails closed:
 * no key, a sensitive workspace, a key shared with a sensitive workspace, a
 * workspace outside the namespace's team, or a failed lookup all mean no memory.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

type Ws = { id: string; teamId: string; repo: string | null; name: string; dataClass: string };

let workspaceRows: Ws[] = [];
let memoryRows: Array<{ id: string; teamId: string; project: string | null }> = [];
let throwOnWorkspace = false;

const fullMemory = (r: { id: string; teamId: string; project: string | null }) => ({
  ...r, type: 'gotcha', title: 'T', content: 'C', tags: [], files: [], source: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

mock.module('../db', () => ({
  db: {
    query: {
      workspaces: {
        // The resolver's WHERE is a drizzle predicate; these stubs answer by
        // the ids the tests set up, and the tests assert on the outcome.
        findFirst: async () => {
          if (throwOnWorkspace) throw new Error('db down');
          return workspaceRows[0];
        },
        findMany: async () => workspaceRows.filter(w => w.dataClass === 'sensitive'),
      },
      memories: {
        findMany: async () => memoryRows.map(fullMemory),
      },
    },
  },
}));

const { resolveMemoryHitScope } = await import('../memory-scope');

const TEAM = 'team-a';
const own = (over: Partial<Ws> = {}): Ws => ({
  id: 'ws-own', teamId: TEAM, repo: 'https://github.com/acme/widgets', name: 'widgets', dataClass: 'standard', ...over,
});

beforeEach(() => {
  workspaceRows = [];
  memoryRows = [];
  throwOnWorkspace = false;
});

describe('resolveMemoryHitScope', () => {
  it('resolves the workspace project key and a lookup that reports row projects', async () => {
    workspaceRows = [own()];
    memoryRows = [
      { id: 'm-own', teamId: TEAM, project: 'acme/widgets' },
      { id: 'm-foreign', teamId: TEAM, project: 'acme/other-thing' },
    ];
    const scope = await resolveMemoryHitScope('ws-own', TEAM);
    expect(scope?.project).toBe('acme/widgets');
    const { memories } = await scope!.lookup(['m-own', 'm-foreign']);
    expect(memories.map(m => [m.id, m.project])).toEqual([
      ['m-own', 'acme/widgets'],
      ['m-foreign', 'acme/other-thing'],
    ]);
  });

  it('is null when the workspace belongs to a different team than the namespace', async () => {
    workspaceRows = [own({ teamId: 'team-b' })];
    expect(await resolveMemoryHitScope('ws-own', TEAM)).toBeNull();
  });

  it('is null for a sensitive workspace', async () => {
    workspaceRows = [own({ dataClass: 'sensitive' })];
    expect(await resolveMemoryHitScope('ws-own', TEAM)).toBeNull();
  });

  it('is null when a sensitive workspace in the team shares the key', async () => {
    workspaceRows = [own(), own({ id: 'ws-sensitive', dataClass: 'sensitive' })];
    expect(await resolveMemoryHitScope('ws-own', TEAM)).toBeNull();
  });

  it('is null for an unknown workspace, missing ids, or a failed lookup', async () => {
    expect(await resolveMemoryHitScope('ws-missing', TEAM)).toBeNull();
    expect(await resolveMemoryHitScope(null, TEAM)).toBeNull();
    expect(await resolveMemoryHitScope('ws-own', null)).toBeNull();
    workspaceRows = [own()];
    throwOnWorkspace = true;
    expect(await resolveMemoryHitScope('ws-own', TEAM)).toBeNull();
  });
});
