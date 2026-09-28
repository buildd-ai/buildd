/**
 * resolveMemoryHitScope: the DB-backed scope for server-side memory reads
 * (claim-time and planning prior work, authoring prior work). Fails closed:
 * no key, a sensitive workspace, a key shared with a sensitive workspace, a
 * workspace outside the namespace's team, or a failed lookup all mean no memory.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

/** Render a drizzle predicate so the test sees the WHERE that was actually built. */
function render(where: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(where as any);
}

/** Team id bound by `"memories"."team_id" = $n`, or undefined when there is no such predicate. */
function teamParam(where: unknown, table: string): unknown {
  const q = render(where);
  const m = q.sql.match(new RegExp(`"${table}"\\."team_id" = \\$(\\d+)`));
  return m ? q.params[Number(m[1]) - 1] : undefined;
}

type Ws = { id: string; teamId: string; repo: string | null; name: string; dataClass: string };

let workspaceRows: Ws[] = [];
let memoryRows: Array<{ id: string; teamId: string; project: string | null }> = [];
let throwOnWorkspace = false;
const memoryWheres: unknown[] = [];
const siblingWheres: unknown[] = [];

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
        findMany: async ({ where }: { where: unknown }) => {
          siblingWheres.push(where);
          const team = teamParam(where, 'workspaces');
          return workspaceRows.filter(w => w.dataClass === 'sensitive' && w.teamId === team);
        },
      },
      memories: {
        // Answers by the team the predicate actually binds: a lookup that lost
        // its team filter would return the other team's rows here.
        findMany: async ({ where }: { where: unknown }) => {
          memoryWheres.push(where);
          const team = teamParam(where, 'memories');
          return memoryRows.filter(r => team === undefined || r.teamId === team).map(fullMemory);
        },
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
  memoryWheres.length = 0;
  siblingWheres.length = 0;
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

  it('the row lookup binds the namespace team in its WHERE', async () => {
    workspaceRows = [own()];
    memoryRows = [
      { id: 'm-own', teamId: TEAM, project: 'acme/widgets' },
      { id: 'm-other-team', teamId: 'team-b', project: 'acme/widgets' },
    ];
    const scope = await resolveMemoryHitScope('ws-own', TEAM);
    const { memories } = await scope!.lookup(['m-own', 'm-other-team']);

    expect(memoryWheres).toHaveLength(1);
    expect(teamParam(memoryWheres[0], 'memories')).toBe(TEAM);
    // Same project key in another team is not this caller's memory.
    expect(memories.map(m => m.id)).toEqual(['m-own']);
  });

  it('the sensitive-sibling check is bound to the workspace team', async () => {
    workspaceRows = [own()];
    await resolveMemoryHitScope('ws-own', TEAM);
    expect(siblingWheres).toHaveLength(1);
    expect(teamParam(siblingWheres[0], 'workspaces')).toBe(TEAM);
    expect(render(siblingWheres[0]).params).toContain('sensitive');
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

describe('caller with memoryScope omitted resolves the scope from the DB', () => {
  it('authoring prior work keeps only the caller team and project memory', async () => {
    const { buildAuthoringPriorWork } = await import('../prior-work-render');
    workspaceRows = [own()];
    memoryRows = [
      { id: 'm-own', teamId: TEAM, project: 'acme/widgets' },
      { id: 'm-foreign-project', teamId: TEAM, project: 'acme/other-thing' },
      { id: 'm-other-team', teamId: 'team-b', project: 'acme/widgets' },
    ];
    const hit = (id: string) => ({
      id, namespace: `${TEAM}:memory`, corpus: 'memory', sourceType: 'memory', sourcePath: null,
      sourceUrl: null, content: `body of ${id}`, metadata: { memoryId: id, type: 'gotcha' }, score: 0.9, createdAt: null,
    });
    const store = {
      query: async (ns: string) => ns === `${TEAM}:memory`
        ? [hit('m-own'), hit('m-foreign-project'), hit('m-other-team')]
        : [],
    };

    // No opts: memoryScope is omitted, so the resolver runs.
    const out = await buildAuthoringPriorWork('widgets', 'ws-own', TEAM, store as any);

    expect(out).toContain('body of m-own');
    expect(out).not.toContain('m-foreign-project');
    expect(out).not.toContain('m-other-team');
    expect(teamParam(memoryWheres[0], 'memories')).toBe(TEAM);
  });
});
