/**
 * A memory recorded as replaced (`memories.superseded_by`) is not served by the
 * store's own reads: search (the claim_task Relevant Memory reply, the runner's
 * workspace memory block and the dashboard list, all through the one door) and
 * getContext. The WHERE the store builds is rendered through the real PgDialect.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const wheres: unknown[] = [];
mock.module('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: (w: unknown) => { wheres.push(w); return Promise.resolve([{ total: 0 }]); } }) }),
    query: {
      memories: {
        findMany: async (args: { where: unknown }) => { wheres.push(args.where); return []; },
      },
    },
  },
}));

const { MemoryStore } = await import('../memory-store');
const dialect = new PgDialect();
const rendered = () => wheres.map(w => dialect.sqlToQuery(w as any).sql);

beforeEach(() => { wheres.length = 0; });

describe('superseded memories are not read', () => {
  it('search: every query (count and rows) excludes superseded rows', async () => {
    await new MemoryStore('team-1').search({ query: 'auth flow', project: 'acme/widgets', limit: 5 });
    expect(wheres).toHaveLength(2);
    for (const sql of rendered()) expect(sql).toContain('"memories"."superseded_by" is null');
  });

  it('search with a file scope and no query too', async () => {
    await new MemoryStore('team-1').search({ files: ['apps/a.ts'], project: 'acme/widgets' });
    for (const sql of rendered()) expect(sql).toContain('"memories"."superseded_by" is null');
  });

  it('getContext excludes superseded rows', async () => {
    await new MemoryStore('team-1').getContext('acme/widgets');
    expect(rendered()).toHaveLength(1);
    expect(rendered()[0]).toContain('"memories"."superseded_by" is null');
  });

  it('batch still hydrates by id (the index decides currency for hybrid hits)', async () => {
    await new MemoryStore('team-1').batch(['m1']);
    expect(rendered()[0]).not.toContain('superseded_by');
  });
});
