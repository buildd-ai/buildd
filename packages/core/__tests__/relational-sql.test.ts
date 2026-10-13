import { describe, it, expect } from 'bun:test';
import * as orm from 'drizzle-orm';
import { SQL, and, asc, desc, eq, inArray, is, isNull, sql } from 'drizzle-orm';
import { alias, pgTable, text, integer } from 'drizzle-orm/pg-core';
import { GroupingNormalisedPgDialect } from '../db/sql-grouping';
import {
  capturedExtras,
  capturedOrderBy,
  capturedWhere,
  capturedWhereFn,
  onQueryAlias,
  sqlExtras,
  sqlOrderBy,
  sqlOrderByFn,
  sqlWhere,
  sqlWhereFn,
} from '../db/relational-sql';

// Relational queries (db.query.<t>.findMany) alias the table they select from.
// drizzle 0.45 (RQB v1) aliased it as the table's TS key and re-pointed every
// column in a `where` / `orderBy` SQL fragment at that alias. drizzle v1
// (RQB v2) aliases it as "d0", "d1", ... and re-points nothing, so a filter
// built from the imported table object renders `"tasks"."id"` against
// `from "tasks" as "d0"`: a Postgres error, invisible to tsc. These helpers
// restore the v1 re-pointing for the query's own table. A relational query
// hands its callbacks the aliased table, which `alias(table, 'd0')` reproduces
// exactly, so these tests hold on both versions.

const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  workspaceId: text('workspace_id'),
  priority: integer('priority'),
});
const workers = pgTable('workers', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  workspaceId: text('workspace_id'),
});

const dialect = new GroupingNormalisedPgDialect();
const render = (q: SQL | undefined) => {
  if (!q) return undefined;
  const { sql: text, params } = dialect.sqlToQuery(q);
  return { sql: text, params };
};
const d0 = alias(tasks, 'd0');

describe('onQueryAlias', () => {
  it("re-points the query table's columns at its alias", () => {
    const q = onQueryAlias(d0, and(eq(tasks.id, 'x'), sql`${tasks.status} <> 'done'`));
    expect(render(q)).toEqual({ sql: `("d0"."id" = $1 and "d0"."status" <> 'done')`, params: ['x'] });
  });

  it("leaves another table's columns alone, unlike v1's re-pointing of every column", () => {
    const q = onQueryAlias(
      d0,
      inArray(tasks.id, sql`(select ${workers.taskId} from ${workers} where ${workers.workspaceId} = ${'w'})`),
    );
    expect(render(q)?.sql).toBe(
      `"d0"."id" in (select "workers"."task_id" from "workers" where "workers"."workspace_id" = $1)`,
    );
  });

  it('leaves a subquery builder alone, as v1 did', () => {
    // Stands in for db.select(...): a chunk that is not SQL but renders itself.
    const builder = { getSQL: () => sql`select ${tasks.id} from ${tasks}` };
    const q = onQueryAlias(d0, sql`${tasks.id} in (${builder as unknown as SQL})`);
    expect(render(q)?.sql).toBe(`"d0"."id" in (select "tasks"."id" from "tasks")`);
  });

  it('is idempotent on a column that is already aliased', () => {
    const q = onQueryAlias(d0, eq(d0.status, 'open'));
    expect(render(q)?.sql).toBe(`"d0"."status" = $1`);
  });

  it('keeps an aliased SQL field alias', () => {
    const q = onQueryAlias(d0, sql<number>`${tasks.priority} * 2`.as('double'));
    expect(is(q, SQL.Aliased)).toBe(true);
    expect((q as SQL.Aliased).fieldAlias).toBe('double');
    expect(render((q as SQL.Aliased).sql)?.sql).toBe(`"d0"."priority" * 2`);
  });

  it('maps a bare column to the aliased column', () => {
    const c = onQueryAlias(d0, tasks.priority);
    expect(render(sql`${c}`)?.sql).toBe(`"d0"."priority"`);
  });

  it('passes undefined through (an omitted filter stays omitted)', () => {
    expect(onQueryAlias(d0, undefined)).toBeUndefined();
  });

  it('matches the table by name and schema, so a same-named column of another table is untouched', () => {
    const otherTasks = pgTable('other', { id: text('id') });
    const q = onQueryAlias(d0, eq(otherTasks.id, 'x'));
    expect(render(q)?.sql).toBe(`"other"."id" = $1`);
  });
});

describe('sqlWhere', () => {
  it('is undefined for an undefined filter, so the query has no where', () => {
    expect(sqlWhere(undefined)).toBeUndefined();
  });

  it('wraps a filter as a RAW callback that renders against the alias', () => {
    const w = sqlWhere(and(eq(tasks.workspaceId, 'w'), isNull(tasks.priority)));
    expect(typeof w?.RAW).toBe('function');
    expect(render(w!.RAW(d0, {}))).toEqual({
      sql: '("d0"."workspace_id" = $1 and "d0"."priority" is null)',
      params: ['w'],
    });
  });

  it('has RAW as its only own key, which is all RQB v2 reads', () => {
    expect(Object.entries(sqlWhere(eq(tasks.id, 'x'))!).map(([k]) => k)).toEqual(['RAW']);
  });

  it('still reads as the SQL it wraps, for code inspecting a captured filter', () => {
    const expr = eq(tasks.id, 'x');
    const w = sqlWhere(expr)!;
    expect(is(w, SQL)).toBe(true);
    expect(render(w as unknown as SQL)).toEqual(render(expr));
  });

  it('evaluates the filter eagerly, once, like v1', () => {
    let built = 0;
    const filter = () => {
      built++;
      return eq(tasks.id, 'x');
    };
    const w = sqlWhere(filter());
    w!.RAW(d0, {});
    w!.RAW(d0, {});
    expect(built).toBe(1);
  });
});

describe('sqlWhereFn', () => {
  it('passes the aliased table and operators through to the callback', () => {
    const raw = sqlWhereFn((t: typeof d0, ops: { eq: typeof eq }) => ops.eq(t.id, 'x'));
    expect(render(raw(d0, { eq }))?.sql).toBe(`"d0"."id" = $1`);
  });

  it("re-points the imported table's columns in the callback's result, as v1 did", () => {
    const raw = sqlWhereFn((t: typeof d0) => and(eq(t.id, 'x'), isNull(tasks.priority)));
    expect(render(raw(d0, {}))?.sql).toBe(`("d0"."id" = $1 and "d0"."priority" is null)`);
  });

  it('lets an empty and() through as undefined', () => {
    const raw = sqlWhereFn(() => and());
    expect(raw(d0, {})).toBeUndefined();
  });
});

describe('sqlOrderByFn', () => {
  it("re-points the callback's terms", () => {
    const o = sqlOrderByFn((t: typeof d0, { desc: d }: { desc: typeof desc }) => [d(t.priority), asc(tasks.id)]);
    const out = o(d0, { desc }) as SQL[];
    expect(out.map((s) => render(s)?.sql)).toEqual([`"d0"."priority" desc`, `"d0"."id" asc`]);
  });
});

describe('sqlOrderBy', () => {
  it('re-points a single order expression', () => {
    const o = sqlOrderBy(desc(tasks.priority));
    expect(render(o(d0, {}) as SQL)?.sql).toBe(`"d0"."priority" desc`);
  });

  it('re-points every entry of an array, keeping its order', () => {
    const o = sqlOrderBy([desc(tasks.priority), asc(tasks.id)]);
    const out = o(d0, {}) as SQL[];
    expect(out.map((s) => render(s)?.sql)).toEqual([`"d0"."priority" desc`, `"d0"."id" asc`]);
  });

  it('re-points a bare column', () => {
    const o = sqlOrderBy(tasks.id);
    expect(render(sql`${o(d0, {}) as SQL}`)?.sql).toBe(`"d0"."id"`);
  });
});

describe('sqlExtras', () => {
  it('turns v1 aliased extras into per-key callbacks that render against the alias', () => {
    const e = sqlExtras({ double: sql<number>`${tasks.priority} * 2`.as('double') });
    expect(Object.keys(e)).toEqual(['double']);
    expect(render(e.double(d0, {}).getSQL())?.sql).toBe(`"d0"."priority" * 2`);
  });
});

describe('reading a captured config, before and after the move', () => {
  const sqlOf = (q: unknown) => render(q as SQL)?.sql;

  it('capturedWhere gives the filter expression for v1 SQL and for sqlWhere', () => {
    const expr = eq(tasks.id, 'x');
    expect(capturedWhere(expr)).toBe(expr);
    expect(capturedWhere(sqlWhere(expr))).toBe(expr);
    expect(capturedWhere(undefined)).toBeUndefined();
  });

  it('JSON.stringify of a sqlWhere filter reads as the expression', () => {
    const expr = { op: 'eq', column: 'workspaceId', value: 'w' } as unknown as SQL;
    expect(JSON.stringify({ where: sqlWhere(expr) })).toBe(JSON.stringify({ where: expr }));
  });

  it('capturedWhereFn calls a v1 callback, a RAW callback, or returns the SQL', () => {
    const v1 = (t: typeof tasks, o: { eq: typeof eq }) => o.eq(t.id, 'x');
    for (const where of [v1, { RAW: sqlWhereFn(v1) }, eq(tasks.id, 'x'), sqlWhere(eq(tasks.id, 'x'))]) {
      expect(sqlOf(capturedWhereFn(where)(tasks, { eq }))).toBe(`"tasks"."id" = $1`);
    }
  });

  it('capturedOrderBy gives the terms of v1 values, v1 callbacks and the v2 callbacks', () => {
    const forms: unknown[] = [
      [desc(tasks.priority), asc(tasks.id)],
      (t: typeof tasks, o: { desc: typeof desc; asc: typeof asc }) => [o.desc(t.priority), o.asc(t.id)],
      sqlOrderBy([desc(tasks.priority), asc(tasks.id)]),
      sqlOrderByFn((t: typeof tasks, o: { desc: typeof desc }) => [o.desc(t.priority), asc(tasks.id)]),
    ];
    for (const orderBy of forms) {
      expect(capturedOrderBy(orderBy, tasks).map(sqlOf)).toEqual([`"tasks"."priority" desc`, `"tasks"."id" asc`]);
    }
    expect(capturedOrderBy(desc(tasks.id), tasks).map(sqlOf)).toEqual([`"tasks"."id" desc`]);
    expect(capturedOrderBy(undefined, tasks)).toEqual([]);
  });

  it('capturedExtras gives SQL by key for every extras form', () => {
    const v1Object = { double: sql<number>`${tasks.priority} * 2`.as('double') };
    const v1Callback = (t: typeof tasks, o: { sql: typeof sql }) => ({ double: o.sql`${t.priority} * 2`.as('double') });
    const v2Callbacks = { double: (t: typeof tasks, o: { sql: typeof sql }) => o.sql`${t.priority} * 2`.as('double') };
    for (const extras of [v1Object, v1Callback, v2Callbacks, sqlExtras(v1Object)]) {
      const out = capturedExtras(extras, tasks);
      expect(Object.keys(out)).toEqual(['double']);
      expect(sqlOf(out.double)).toBe(`"tasks"."priority" * 2`);
    }
  });
});

// The helpers exist for RQB v2. On drizzle 0.45 there is no defineRelations,
// so this block only runs once the version bump lands; it checks the real
// relational query, not a reproduction of its aliasing.
const defineRelations = (orm as Record<string, unknown>).defineRelations as
  | ((schema: object, fn: (r: any) => object) => object)
  | undefined;

describe.skipIf(!defineRelations)('through a real RQB v2 query (drizzle v1 only)', () => {
  it('renders a filter built from the imported table against the root alias', async () => {
    const { drizzle } = await import('drizzle-orm/neon-http');
    const { neon } = await import('@neondatabase/serverless');
    const relations = defineRelations!({ tasks, workers }, (r) => ({
      tasks: { workers: r.many.workers({ from: r.tasks.id, to: r.workers.taskId }) },
    }));
    const db: any = drizzle({ client: neon('postgres://u:p@localhost/db'), relations } as any);
    const q = db.query.tasks
      .findMany({
        where: sqlWhere(and(eq(tasks.workspaceId, 'w'), sql`${tasks.priority} > 1`)),
        orderBy: sqlOrderBy(desc(tasks.priority)),
        with: {
          workers: {
            where: { RAW: sqlWhereFn((w: any, ops: any) => ops.and(ops.eq(w.taskId, 't'), ops.eq(workers.workspaceId, 'w'))) },
            orderBy: sqlOrderByFn((w: any, ops: any) => [ops.desc(w.id), workers.taskId]),
          },
        },
      })
      .toSQL();
    expect(q.sql).not.toContain('"tasks"."');
    // `"workers"."r"` is the lateral join's own alias; no workers column may
    // be rendered against the bare table name.
    expect(q.sql).not.toMatch(/"workers"\."(id|task_id|workspace_id)"/);
    expect(q.sql).toContain('"d0"."workspace_id" = $');
    expect(q.sql).toContain('"d0"."priority" > 1');
    expect(q.sql).toContain('order by "d0"."priority" desc');
    expect(q.sql).toContain('"d1"."workspace_id" = $');
    expect(q.sql).toContain('order by "d1"."id" desc, "d1"."task_id"');
  });
});
