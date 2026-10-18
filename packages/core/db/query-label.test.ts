import { describe, it, expect } from 'bun:test';
import { neon } from '@neondatabase/serverless';
import {
  withLoaderLabel,
  currentLoaderLabel,
  recordNeonQueries,
  summarizeSql,
  neonQueryAttributes,
  callerSiteFromStack,
  labelledFetch,
} from './query-label';

// A fake Neon HTTP endpoint: echoes one row, and remembers what it was sent.
function fakeFetch(rows = [['1']]) {
  const calls: Array<{ url: string; init: RequestInit & { opentelemetry?: { attributes?: Record<string, unknown> } } }> = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    const body = String(init.body);
    const one = { fields: [{ name: 'x', dataTypeID: 25 }], rows, command: 'SELECT', rowCount: rows.length };
    const payload = body.startsWith('{"queries"') ? { results: (JSON.parse(body).queries as unknown[]).map(() => one) } : one;
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { fn, calls };
}

describe('withLoaderLabel', () => {
  it('scopes a label to the async work inside it, and nests', async () => {
    expect(currentLoaderLabel()).toBeUndefined();
    await withLoaderLabel('home', async () => {
      expect(currentLoaderLabel()).toBe('home');
      await Promise.resolve();
      await withLoaderLabel('home.missions', async () => {
        await new Promise(r => setTimeout(r, 1));
        expect(currentLoaderLabel()).toBe('home.missions');
      });
      expect(currentLoaderLabel()).toBe('home');
    });
    expect(currentLoaderLabel()).toBeUndefined();
  });
});

describe('summarizeSql', () => {
  it('names the operation and the top-level table, not a subquery table', () => {
    const s = summarizeSql('select "d0"."id", (select count(*) from "workers" w where w.task_id = "d0"."id") from "tasks" as "d0" where "d0"."workspace_id" = $1');
    expect(s.operation).toBe('select');
    expect(s.table).toBe('tasks');
  });

  it('reads insert / update / delete targets', () => {
    expect(summarizeSql('insert into "missions" ("title") values ($1)')).toMatchObject({ operation: 'insert', table: 'missions' });
    expect(summarizeSql('update "workers" set "status" = $1')).toMatchObject({ operation: 'update', table: 'workers' });
    expect(summarizeSql('delete from "tasks" where id = $1')).toMatchObject({ operation: 'delete', table: 'tasks' });
  });

  it('never carries a literal value into the head', () => {
    const s = summarizeSql(`select * from "tasks" where title = 'secret-title' and n = 42 and x = $3 and s = 'it''s'`);
    expect(s.head).not.toContain('secret');
    expect(s.head).not.toContain('42');
    expect(s.head).not.toContain("it''s");
    expect(s.head).toContain('$3');
  });

  it('keeps the head short and single-line', () => {
    const s = summarizeSql(`select\n  ${Array.from({ length: 200 }, (_, i) => `"c${i}"`).join(',\n  ')}\nfrom "t"`);
    expect(s.head.length).toBeLessThanOrEqual(120);
    expect(s.head).not.toContain('\n');
    // A long column list still finds its table.
    expect(s.table).toBe('t');
  });
});

describe('neonQueryAttributes', () => {
  it('reads a single query body without its params', () => {
    const body = JSON.stringify({ query: 'select * from "tasks" where id = $1', params: ['very-private-value'] });
    const a = neonQueryAttributes(body, { label: 'home.tasks', source: 'label' });
    expect(a['buildd.db.loader']).toBe('home.tasks');
    expect(a['buildd.db.loader_source']).toBe('label');
    expect(a['db.collection.name']).toBe('tasks');
    expect(a['db.operation.batch.size']).toBe(1);
    expect(JSON.stringify(a)).not.toContain('very-private-value');
  });

  it('reads a batch body: first statement, statement count', () => {
    const body = JSON.stringify({ queries: [
      { query: 'select pg_advisory_xact_lock($1)', params: ['k'] },
      { query: 'insert into "path_claims" ("a") values ($1)', params: ['{"query":"x"}'] },
    ] });
    const a = neonQueryAttributes(body, { label: 'x', source: 'label' });
    expect(a['db.operation.batch.size']).toBe(2);
    expect(a['db.operation.name']).toBe('select');
  });
});

describe('callerSiteFromStack', () => {
  it('skips driver and db-module frames and names the first app frame', () => {
    const stack = [
      'Error',
      '    at labelledFetch (/repo/packages/core/db/query-label.ts:10:5)',
      '    at dr.execute (/repo/node_modules/@neondatabase/serverless/index.mjs:1292:19)',
      '    at async NeonHttpPreparedQuery.execute (/repo/node_modules/.bun/drizzle-orm@1/node_modules/drizzle-orm/neon-http/session.js:50:3)',
      '    at async loadHomeFleet (/repo/apps/web/src/lib/home-fleet.ts:120:17)',
      '    at async HomePage (/repo/apps/web/src/app/app/home/page.tsx:9:1)',
    ].join('\n');
    expect(callerSiteFromStack(stack)).toBe('apps/web/src/lib/home-fleet.ts:120 loadHomeFleet');
  });

  it('returns undefined when no app frame is on the stack', () => {
    expect(callerSiteFromStack('Error\n    at processTicksAndRejections (native:7:39)')).toBeUndefined();
  });
});

describe('labelledFetch through a real neon client', () => {
  it('stamps the loader and query summary on the fetch span options', async () => {
    const fake = fakeFetch();
    const sql = neon('postgres://u:p@127.0.0.1:1/db', { fetchOptions: {} });
    const fetchFn = labelledFetch(fake.fn);
    // neonConfig is global; drive the wrapper directly with neon's own body.
    const { neonConfig } = await import('@neondatabase/serverless');
    const prev = neonConfig.fetchFunction;
    neonConfig.fetchFunction = fetchFn;
    try {
      await withLoaderLabel('home.missions', () => sql.query('select * from "missions" where id = $1', ['m-1']));
    } finally {
      neonConfig.fetchFunction = prev;
    }
    const attrs = fake.calls[0].init.opentelemetry?.attributes ?? {};
    expect(attrs['buildd.db.loader']).toBe('home.missions');
    expect(attrs['db.collection.name']).toBe('missions');
    expect(JSON.stringify(attrs)).not.toContain('m-1');
  });

  it('recordNeonQueries counts queries and bytes returned, batch included', async () => {
    const fake = fakeFetch([['abcdef'], ['ghijkl']]);
    const sql = neon('postgres://u:p@127.0.0.1:1/db');
    const { neonConfig } = await import('@neondatabase/serverless');
    const prev = neonConfig.fetchFunction;
    neonConfig.fetchFunction = labelledFetch(fake.fn);
    try {
      const rec = await recordNeonQueries(async () => {
        const rows = await withLoaderLabel('a', () => sql.query('select x from "t"'));
        await sql.transaction([sql.query('select 1'), sql.query('select 2')]);
        return rows;
      });
      expect(rec.result).toHaveLength(2);
      expect(rec.count).toBe(2);
      expect(rec.statements).toBe(3);
      expect(rec.bytes).toBeGreaterThan(0);
      expect(rec.queries[0].label).toBe('a');
      expect(rec.queries[0].table).toBe('t');
      expect(rec.byLabel.a.count).toBe(1);
    } finally {
      neonConfig.fetchFunction = prev;
    }
  });

  it('does not buffer the response when nothing is recording', async () => {
    const fake = fakeFetch();
    const res = await labelledFetch(fake.fn)('http://x/sql', { method: 'POST', body: JSON.stringify({ query: 'select 1', params: [] }) });
    expect(res.bodyUsed).toBe(false);
  });
});

describe('installNeonQueryLabels', () => {
  it('wraps neonConfig.fetchFunction once, around whatever was there', async () => {
    const { neonConfig } = await import('@neondatabase/serverless');
    const { installNeonQueryLabels } = await import('./query-label');
    const prev = neonConfig.fetchFunction;
    const fake = fakeFetch();
    neonConfig.fetchFunction = fake.fn;
    try {
      installNeonQueryLabels();
      const wrapped = neonConfig.fetchFunction;
      installNeonQueryLabels();
      expect(neonConfig.fetchFunction).toBe(wrapped);
      await withLoaderLabel('x', () => neon('postgres://u:p@127.0.0.1:1/db').query('select 1'));
      expect(fake.calls[0].init.opentelemetry?.attributes?.['buildd.db.loader']).toBe('x');
    } finally {
      neonConfig.fetchFunction = prev;
    }
  });
});
