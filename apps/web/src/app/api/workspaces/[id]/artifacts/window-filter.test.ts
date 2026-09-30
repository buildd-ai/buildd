/**
 * GET /api/workspaces/[id]/artifacts — `keyPrefix`, `since` and `before`.
 *
 * These exist so a keyed family of artifacts (the cloud runner's
 * `cloud-run-report:<workerId>`, one per run) can be listed over a time window
 * and paged: `limit` is capped at 50, results are newest `updatedAt` first, and
 * the next page is `before=<oldest updatedAt seen>`.
 *
 * Same technique as review-filter.test.ts: only the db client is stubbed, the
 * real drizzle builders run and PgDialect renders the WHERE clause.
 *
 * Run: bun run scripts/run-unit-tests.ts 'apps/web/src/app/api/workspaces/[id]/artifacts/window-filter.test.ts'
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

let capturedArgs: any = null;

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: async () => ({ id: 'user-1' }),
}));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async () => null,
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => true,
  verifyAccountWorkspaceAccess: async () => true,
}));
mock.module('@/lib/app-url', () => ({
  appBaseUrl: () => 'https://buildd.test',
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      artifacts: {
        findMany: async (args: any) => {
          capturedArgs = args;
          return [];
        },
        findFirst: async () => null,
      },
    },
  },
}));

const { GET } = await import('./route');

const dialect = new PgDialect();

async function get(query: string) {
  capturedArgs = null;
  const res = await GET(
    new NextRequest(`http://localhost:3000/api/workspaces/ws-1/artifacts${query}`),
    { params: Promise.resolve({ id: 'ws-1' }) },
  );
  return { res, rendered: capturedArgs ? render(capturedArgs.where) : null };
}

function render(fragment: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
}

describe('GET keyPrefix / since / before', () => {
  beforeEach(() => {
    capturedArgs = null;
  });

  it('keyPrefix is a LIKE prefix inside the workspace scope, with wildcards escaped', async () => {
    const { res, rendered } = await get('?keyPrefix=cloud-run_report%25:');
    expect(res.status).toBe(200);
    const { sql, params } = rendered!;
    expect(sql).toContain('"artifacts"."workspace_id" =');
    expect(params).toContain('ws-1');
    expect(sql).toContain('"artifacts"."key" like');
    // `_` and `%` in the prefix are literal, not wildcards.
    expect(params).toContain('cloud-run\\_report\\%:%');
  });

  it('since and before bound updated_at (>= since, < before)', async () => {
    const { rendered } = await get('?since=2026-01-01T00:00:00.000Z&before=2026-01-02T00:00:00.000Z');
    const { sql, params } = rendered!;
    expect(sql).toContain('"artifacts"."updated_at" >=');
    expect(sql).toContain('"artifacts"."updated_at" <');
    const iso = params.map(p => (p instanceof Date ? p.toISOString() : p));
    expect(iso).toContain('2026-01-01T00:00:00.000Z');
    expect(iso).toContain('2026-01-02T00:00:00.000Z');
  });

  it('an unparseable time is a 400, not a query', async () => {
    for (const q of ['?since=yesterday', '?before=not-a-date']) {
      const { res } = await get(q);
      expect(res.status).toBe(400);
      expect(capturedArgs).toBeNull();
    }
  });

  it('without the params the query is unchanged', async () => {
    const { rendered } = await get('');
    expect(rendered!.sql).not.toContain(' like ');
    expect(rendered!.sql).not.toContain('updated_at');
  });
});
