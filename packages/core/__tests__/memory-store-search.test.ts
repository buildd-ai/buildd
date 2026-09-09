import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mocked drizzle-orm combinators build plain tuples (['op', ...args]) instead
// of real SQL fragments — evalCondition below interprets them against a row so
// the mock DB genuinely filters, rather than returning canned rows regardless
// of the `where` it was given. Without that, a test asserting on the returned
// rows can't actually catch a broken filter.
function evalCondition(cond: unknown, row: Record<string, unknown>): boolean {
  if (!Array.isArray(cond)) return true;
  const [op, ...args] = cond as [string, ...unknown[]];
  switch (op) {
    case 'and':
      return args.every(a => evalCondition(a, row));
    case 'or':
      return args.some(a => evalCondition(a, row));
    case 'eq': {
      const [col, val] = args as [string, unknown];
      return row[col] === val;
    }
    case 'ilike': {
      const [col, pattern] = args as [string, string];
      const haystack = String(row[col] ?? '').toLowerCase();
      const needle = pattern.replace(/^%/, '').replace(/%$/, '').toLowerCase();
      return haystack.includes(needle);
    }
    case 'inArray': {
      const [col, vals] = args as [string, unknown[]];
      return vals.includes(row[col]);
    }
    default:
      return true;
  }
}

let allRows: Array<Record<string, unknown>> = [];
let findManyArgs: Array<Record<string, unknown>> = [];

mock.module('../db', () => ({
  db: {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (where: unknown) =>
          Promise.resolve([{ total: allRows.filter(r => evalCondition(where, r)).length }]),
      }),
    }),
    query: {
      memories: {
        findMany: (args: Record<string, unknown>) => {
          findManyArgs.push(args);
          return Promise.resolve(allRows.filter(r => evalCondition(args.where, r)));
        },
      },
    },
  },
}));

mock.module('../db/schema', () => ({
  memories: {
    teamId: 'teamId',
    type: 'type',
    title: 'title',
    content: 'content',
    project: 'project',
    id: 'id',
    updatedAt: 'updatedAt',
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ['eq', a, b],
  and: (...a: unknown[]) => ['and', ...a],
  or: (...a: unknown[]) => ['or', ...a],
  ilike: (a: unknown, b: unknown) => ['ilike', a, b],
  desc: (a: unknown) => ['desc', a],
  inArray: (a: unknown, b: unknown) => ['inArray', a, b],
  count: () => ['count'],
  // memory-file-scope-sql.ts imports `sql` from this module too, so the named
  // export has to exist here or that file's top-level import throws before any
  // test body runs.
  //
  // The tagged template IS invoked now: search() builds a token match-count
  // expression for its `orderBy` on every query. `join` therefore has to exist
  // as well. The mock's findMany ignores `orderBy` — it only evaluates `where`
  // — so the shape these return is irrelevant; they just must not throw.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...exprs: unknown[]) => ['sql', strings, exprs],
    {
      param: (v: unknown) => ['param', v],
      join: (parts: unknown[], sep: unknown) => ['join', parts, sep],
    },
  ),
}));

const { MemoryStore } = await import('../memory-store');

function row(id: string, title: string, content: string) {
  return {
    id,
    teamId: 'team-1',
    type: 'gotcha',
    title,
    content,
    project: null,
    tags: [],
    files: [],
    source: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

beforeEach(() => {
  allRows = [];
  findManyArgs = [];
});

describe('MemoryStore.search — tokenized query', () => {
  it('matches when only one of two query terms appears (OR across tokens)', async () => {
    // Neither memory contains the literal phrase "scanner audit" anywhere —
    // the old single-ILIKE-on-the-whole-query behavior returned zero rows for
    // this. Each row matches exactly one of the two tokens.
    allRows = [
      row('m1', 'error-trace-scanner gotcha', 'Scanner pattern matched wrong'),
      row('m2', 'quarterly audit notes', 'Audit findings for the workspace'),
    ];

    const store = new MemoryStore('team-1');
    const result = await store.search({ query: 'scanner audit' });

    expect(result.results.map(r => r.id).sort()).toEqual(['m1', 'm2']);
  });

  it('still matches a single-token query and excludes non-matching rows', async () => {
    allRows = [
      row('m1', 'scanner gotcha', 'content'),
      row('m2', 'unrelated topic', 'nothing to do with it'),
    ];

    const store = new MemoryStore('team-1');
    const result = await store.search({ query: 'scanner' });

    expect(result.results.map(r => r.id)).toEqual(['m1']);
  });

  it('builds an OR condition per token against title and content', async () => {
    const store = new MemoryStore('team-1');
    await store.search({ query: 'runner deploy' });

    const where = JSON.stringify(findManyArgs[0]?.where);
    // Every token gets its own ilike against both columns, joined with OR —
    // not a single ilike over the concatenated phrase.
    expect(where).toContain('%runner%');
    expect(where).toContain('%deploy%');
    expect(where).not.toContain('%runner deploy%');
  });

  it('applies no query filter when the query is empty/whitespace', async () => {
    allRows = [row('m1', 'anything', 'anything')];

    const store = new MemoryStore('team-1');
    const result = await store.search({ query: '   ' });

    const where = JSON.stringify(findManyArgs[0]?.where);
    expect(where).not.toContain('ilike');
    expect(result.results.map(r => r.id)).toEqual(['m1']);
  });

  // Caught in production: `query=the` returned EVERY memory in the workspace.
  // Zero usable tokens adds no condition, which is indistinguishable from "no
  // query supplied" — so the corpus came back ordered by recency and the caller
  // took its limit off the top, reporting a populated match count. "Nothing
  // worth searching for" must mean nothing found, not everything found.
  it('a query whose tokens are all stopwords matches nothing, not everything', async () => {
    allRows = [
      row('m1', 'the runner', 'the thing'),
      row('m2', 'another', 'body'),
    ];

    const store = new MemoryStore('team-1');
    const result = await store.search({ query: 'the and for' });

    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
    // The query must not even reach the database — there is nothing to ask.
    expect(findManyArgs).toHaveLength(0);
  });

  it('still distinguishes that from an absent query, which lists the corpus', async () => {
    allRows = [row('m1', 'the runner', 'the thing')];

    const store = new MemoryStore('team-1');
    const absent = await store.search({});

    expect(absent.results.map(r => r.id)).toEqual(['m1']);
  });
});
