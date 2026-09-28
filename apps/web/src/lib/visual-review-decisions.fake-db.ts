/**
 * A recording fake of `@buildd/core/db` for the visual review decision tests
 * (the lib and both routes). Test-only: nothing in the app imports it.
 *
 * Every builder chain is a thenable that records one `Call` when awaited, in
 * execution order, and resolves to whatever `fake.respond` returns for it.
 * WHERE clauses are kept as drizzle SQL so a test renders them through
 * PgDialect: a mocked db that returns canned rows hides every predicate.
 */
import { getTableName, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

export type FakeCall = {
  op: 'select' | 'insert' | 'update' | 'findFirst' | 'findMany';
  table: string;
  values?: any;
  set?: any;
  where?: any;
  cols?: any;
  returning?: boolean;
};

const dialect = new PgDialect();
export const renderSql = (w: any) => dialect.sqlToQuery(w);

export const fake = {
  calls: [] as FakeCall[],
  respond: ((_c: FakeCall) => []) as (c: FakeCall) => any,
  reset(respond: (c: FakeCall) => any) {
    fake.calls = [];
    fake.respond = respond;
  },
};

function thenable(c: FakeCall) {
  const o: any = {
    where(w: any) { c.where = w; return o; },
    limit() { return o; },
    orderBy() { return o; },
    returning() { c.returning = true; return o; },
    then(res: any, rej: any) {
      fake.calls.push(c);
      return Promise.resolve().then(() => fake.respond(c)).then(res, rej);
    },
  };
  return o;
}

const nameOf = (t: unknown) => getTableName(t as Table);
const query = (table: string) => ({
  findFirst: (q: any) => thenable({ op: 'findFirst', table, where: q?.where, cols: q?.columns }),
  findMany: (q: any) => thenable({ op: 'findMany', table, where: q?.where, cols: q?.columns }),
});

export const fakeDb = {
  select: (cols?: any) => ({ from: (t: unknown) => thenable({ op: 'select', table: nameOf(t), cols }) }),
  insert: (t: unknown) => ({ values: (v: any) => thenable({ op: 'insert', table: nameOf(t), values: v }) }),
  update: (t: unknown) => ({ set: (v: any) => thenable({ op: 'update', table: nameOf(t), set: v }) }),
  query: {
    tasks: query('tasks'),
    workspaces: query('workspaces'),
    missions: query('missions'),
    visualShotReviews: query('visual_shot_reviews'),
  },
};
