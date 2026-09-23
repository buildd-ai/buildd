import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The /app/artifacts page used to load every artifact (full content) and
 * every worker the user's workspaces ever ran, then filter in memory. These
 * tests lock the bounds: a LIMIT on the artifact query, worker/task lookups
 * keyed only on the rows actually shown, and counts done in SQL.
 *
 * Only `db` is stubbed; the real schema and drizzle builders run, and WHERE
 * clauses are rendered through PgDialect so their shape is observable.
 */
const dialect = new PgDialect();
const render = (f: any) => {
  const q = dialect.sqlToQuery(f);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

let artifactRows: any[] = [];
let workerRows: any[] = [];
let taskRows: any[] = [];
let countRow: any = { total: 0, review: 0 };

const artifactsFindMany = mock(async (_args: any) => artifactRows);
const workersFindMany = mock(async (_args: any) => workerRows);
const tasksFindMany = mock(async (_args: any) => taskRows);
const workspacesFindMany = mock(async (_args: any) => [
  { id: 'ws-1', name: 'Alpha' },
]);
const countWhere = mock(async (_w: any) => [countRow]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: { findMany: artifactsFindMany },
      workers: { findMany: workersFindMany },
      tasks: { findMany: tasksFindMany },
      workspaces: { findMany: workspacesFindMany },
    },
    select: () => ({ from: () => ({ where: countWhere }) }),
  },
}));

import {
  loadArtifactsPage,
  parseArtifactLimit,
  parseArtifactScope,
  ARTIFACTS_PAGE_SIZE,
  ARTIFACTS_MAX_LIMIT,
} from './load-artifacts';

function artifact(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'report',
    title: id,
    content: 'body',
    shareToken: null,
    visibility: 'private',
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    key: null,
    missionId: null,
    initiativeId: null,
    workspaceId: null,
    workerId: null,
    ...over,
  };
}

describe('parseArtifactLimit', () => {
  it('defaults to one page', () => {
    expect(parseArtifactLimit(undefined)).toBe(ARTIFACTS_PAGE_SIZE);
    expect(parseArtifactLimit('garbage')).toBe(ARTIFACTS_PAGE_SIZE);
    expect(parseArtifactLimit('-5')).toBe(ARTIFACTS_PAGE_SIZE);
  });

  it('clamps to the hard maximum so a query string cannot unbound the page', () => {
    expect(parseArtifactLimit('999999')).toBe(ARTIFACTS_MAX_LIMIT);
  });

  it('accepts an in-range value and takes the first of repeated params', () => {
    expect(parseArtifactLimit(String(ARTIFACTS_PAGE_SIZE * 2))).toBe(ARTIFACTS_PAGE_SIZE * 2);
    expect(parseArtifactLimit([String(ARTIFACTS_PAGE_SIZE * 3), '1'])).toBe(ARTIFACTS_PAGE_SIZE * 3);
  });
});

describe('parseArtifactScope', () => {
  it('defaults to review and accepts only known values', () => {
    expect(parseArtifactScope(undefined)).toBe('review');
    expect(parseArtifactScope('bogus')).toBe('review');
    expect(parseArtifactScope('all')).toBe('all');
    expect(parseArtifactScope(['all', 'review'])).toBe('all');
  });
});

describe('loadArtifactsPage', () => {
  beforeEach(() => {
    artifactRows = [];
    workerRows = [];
    taskRows = [];
    countRow = { total: 0, review: 0 };
    for (const m of [artifactsFindMany, workersFindMany, tasksFindMany, countWhere]) m.mockClear();
  });

  it('bounds the artifact query with LIMIT n+1 and a workspace-anchored scope', async () => {
    await loadArtifactsPage(['ws-1'], 50);
    const args = artifactsFindMany.mock.calls[0][0];
    expect(args.limit).toBe(51);
    const { sql } = render(args.where);
    expect(sql).toContain('"artifacts"."workspace_id" in');
    expect(sql).toContain('select "id" from "workers" where "workers"."workspace_id" in');
  });

  it('pushes the review filter into SQL for the review scope', async () => {
    await loadArtifactsPage(['ws-1'], 50, 'review');
    const { sql } = render(artifactsFindMany.mock.calls[0][0].where);
    expect(sql).toContain('"artifacts"."workspace_id" in');
    expect(sql).toContain('"artifacts"."visibility" =');
    expect(sql).toContain('"artifacts"."type" in');
    // Counts stay unfiltered by scope: total is every visible artifact.
    const countSql = render(countWhere.mock.calls[0][0]).sql;
    expect(countSql).not.toContain('"artifacts"."visibility"');
  });

  it('does not apply the review filter for the all scope', async () => {
    await loadArtifactsPage(['ws-1'], 50, 'all');
    const { sql } = render(artifactsFindMany.mock.calls[0][0].where);
    expect(sql).not.toContain('"artifacts"."visibility"');
  });

  it('never loads the full worker list — only the workers behind shown artifacts', async () => {
    artifactRows = [
      artifact('a1', { workerId: 'w-1' }),
      artifact('a2', { workspaceId: 'ws-1' }),
      artifact('a3', { workerId: 'w-1' }),
    ];
    workerRows = [{ id: 'w-1', taskId: 't-1', workspaceId: 'ws-1' }];
    taskRows = [{ id: 't-1', title: 'Task one' }];

    const page = await loadArtifactsPage(['ws-1'], 50);

    expect(workersFindMany).toHaveBeenCalledTimes(1);
    const { sql, params } = render(workersFindMany.mock.calls[0][0].where);
    expect(sql).toContain('"workers"."id" in');
    expect(params).toEqual(['w-1']);
    expect(render(tasksFindMany.mock.calls[0][0].where).params).toEqual(['t-1']);

    expect(page.items[0].taskTitle).toBe('Task one');
    expect(page.items[0].workspaceName).toBe('Alpha');
    expect(page.items[1].workspaceName).toBe('Alpha');
  });

  it('skips worker and task lookups entirely when no shown artifact has a worker', async () => {
    artifactRows = [artifact('a1', { workspaceId: 'ws-1' })];
    await loadArtifactsPage(['ws-1'], 50);
    expect(workersFindMany).not.toHaveBeenCalled();
    expect(tasksFindMany).not.toHaveBeenCalled();
  });

  it('reports hasMore and trims the sentinel row', async () => {
    artifactRows = [artifact('a1'), artifact('a2'), artifact('a3')];
    countRow = { total: 7, review: 4 };
    const page = await loadArtifactsPage(['ws-1'], 2);
    expect(page.hasMore).toBe(true);
    expect(page.items.map(i => i.id)).toEqual(['a1', 'a2']);
    // Header counts come from SQL, not from the truncated in-memory list.
    expect(page.total).toBe(7);
    expect(page.reviewCount).toBe(4);
  });

  it('hasMore is false when the page is not full', async () => {
    artifactRows = [artifact('a1')];
    const page = await loadArtifactsPage(['ws-1'], 2);
    expect(page.hasMore).toBe(false);
  });
});
