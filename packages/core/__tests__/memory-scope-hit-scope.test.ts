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
/** The WHERE of every workspaces lookup: one per resolution since task d1997424. */
const workspaceWheres: unknown[] = [];

const fullMemory = (r: { id: string; teamId: string; project: string | null }) => ({
  ...r, type: 'gotcha', title: 'T', content: 'C', tags: [], files: [], source: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

mock.module('../db', () => ({
  db: {
    query: {
      workspaces: {
        // ONE query answers both halves: the workspace itself, and its team's
        // sensitive set. Answered by what the rendered predicate binds (the
        // workspace id and the team), so a WHERE that lost its team filter
        // would hand the resolver another team's sensitive rows here.
        findMany: async ({ where }: { where: unknown }) => {
          workspaceWheres.push(where);
          if (throwOnWorkspace) throw new Error('db down');
          const q = render(where);
          const id = q.params[0];
          const team = teamParam(where, 'workspaces');
          return workspaceRows.filter(w => w.id === id || (w.teamId === team && w.dataClass === 'sensitive'));
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

const { resolveMemoryHitScope, memoryScopeWorkspacesWhere } = await import('../memory-scope');

const TEAM = 'team-a';
const own = (over: Partial<Ws> = {}): Ws => ({
  id: 'ws-own', teamId: TEAM, repo: 'https://github.com/acme/widgets', name: 'widgets', dataClass: 'standard', ...over,
});

beforeEach(() => {
  workspaceRows = [];
  memoryRows = [];
  throwOnWorkspace = false;
  memoryWheres.length = 0;
  workspaceWheres.length = 0;
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
    expect(workspaceWheres).toHaveLength(1);
    expect(teamParam(workspaceWheres[0], 'workspaces')).toBe(TEAM);
    expect(render(workspaceWheres[0]).params).toContain('sensitive');
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

describe('one workspace query, not two', () => {
  it('resolves scope with a single lookup', async () => {
    workspaceRows = [own()];
    expect((await resolveMemoryHitScope('ws-own', TEAM))?.project).toBe('acme/widgets');
    expect(workspaceWheres).toHaveLength(1);
  });

  it('ignores a sensitive workspace in ANOTHER team that shares the key', async () => {
    workspaceRows = [own(), own({ id: 'ws-elsewhere', teamId: 'team-b', dataClass: 'sensitive' })];
    expect((await resolveMemoryHitScope('ws-own', TEAM))?.project).toBe('acme/widgets');
  });
});

describe('memoryScopeWorkspacesWhere renders', () => {
  it("the workspace, or that team's sensitive workspaces", () => {
    const q = render(memoryScopeWorkspacesWhere('ws-1', 'team-1'));
    expect(q.sql).toBe('("workspaces"."id" = $1 or ("workspaces"."team_id" = $2 and "workspaces"."data_class" = $3))');
    expect(q.params).toEqual(['ws-1', 'team-1', 'sensitive']);
  });
});
