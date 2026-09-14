/**
 * GET /api/workspaces/[id]/artifacts — the `review=true` prominence filter.
 *
 * WHY THIS FILE IS SEPARATE FROM `route.test.ts`
 * ----------------------------------------------
 * `route.test.ts` does `mock.module('drizzle-orm')` and mocks the schema as
 * bare strings, so every column in a predicate is a string literal and the
 * generated WHERE clause is unobservable — a filter assertion written there
 * would assert nothing. Here only the db *client* is stubbed: the real drizzle
 * builders run and the real `PgDialect` renders the captured `where` to SQL, so
 * the filter (and the workspace scoping it must never replace) is visible.
 *
 * Run: bun run scripts/run-unit-tests.ts 'apps/web/src/app/api/workspaces/[id]/artifacts/review-filter.test.ts'
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

function render(fragment: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
}

async function get(query: string) {
  capturedArgs = null;
  const res = await GET(
    new NextRequest(`http://localhost:3000/api/workspaces/ws-1/artifacts${query}`),
    { params: Promise.resolve({ id: 'ws-1' }) },
  );
  expect(res.status).toBe(200);
  expect(capturedArgs).not.toBeNull();
  return render(capturedArgs.where);
}

describe('GET ?review=true', () => {
  beforeEach(() => {
    capturedArgs = null;
  });

  it('keeps the workspace scope and ANDs the prominence rule onto it', async () => {
    const { sql, params } = await get('?review=true');
    // Tenancy first: the review filter must narrow, never replace, the scope.
    expect(sql).toContain('"artifacts"."workspace_id" =');
    expect(params).toContain('ws-1');
    // Prominence: type buckets + the keyed/container arm.
    expect(sql).toContain('"artifacts"."type" in');
    expect(sql).toContain('"artifacts"."type" not in');
    expect(sql).toContain('"artifacts"."key" is not null');
    expect(sql).toContain('"artifacts"."mission_id" is not null');
    expect(sql).toContain('"artifacts"."initiative_id" is not null');
    expect(params).toContain('public');
    expect(params).toContain('report');
    expect(params).toContain('screenshot');
  });

  it('leaves the query untouched without the param (default stays everything)', async () => {
    const { sql } = await get('');
    expect(sql).toContain('"artifacts"."workspace_id" =');
    expect(sql).not.toContain('"artifacts"."key" is not null');
    expect(sql).not.toContain('"artifacts"."type" not in');
  });

  it('treats any value other than "true" as off', async () => {
    for (const value of ['false', '1', 'yes', '']) {
      const { sql } = await get(`?review=${value}`);
      expect(sql).not.toContain('"artifacts"."type" not in');
    }
  });

  it('composes with the type filter rather than overriding it', async () => {
    const { sql, params } = await get('?review=true&type=report');
    expect(sql).toContain('"artifacts"."type" =');
    expect(params).toContain('report');
    expect(sql).toContain('"artifacts"."type" not in');
  });

  it('applies the filter in SQL, so limit counts matching rows', async () => {
    await get('?review=true&limit=25');
    expect(capturedArgs.limit).toBe(25);
  });
});
