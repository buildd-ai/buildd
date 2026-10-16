// SQL-expression filters, orderings and extras for relational queries
// (db.query.<t>.findFirst / findMany) on drizzle's v2 relational API.
//
// A relational query aliases the table it selects from. RQB v1 (drizzle 0.45)
// re-pointed every column in a `where` / `orderBy` / `extras` SQL fragment at
// that alias, so a filter could be written against the imported table:
// `where: eq(tasks.workspaceId, id)`. RQB v2 (drizzle v1) aliases the root as
// "d0" (nested relations "d1", ...) and re-points nothing: the same filter
// renders `"tasks"."workspace_id"` against `from "tasks" as "d0"`, which
// Postgres rejects, and tsc cannot see it.
//
// `sqlWhere(expr)` / `sqlOrderBy(expr)` / `sqlExtras(obj)` take the v1-style
// expression unchanged and return the v2 shape (`{ RAW }` / callbacks), which
// re-point the query table's own columns at the alias drizzle passes in.
// `sqlWhereFn(cb)` / `sqlOrderByFn(cb)` do the same for v1 callbacks.
// Unlike v1 they leave other tables' columns alone, so a `sql` subquery on
// another table keeps its own columns (v1 rewrote those too, see
// apps/web/src/lib/artifact-scope.test.ts). Subquery builders (db.select(...)) are
// left untouched, as v1 left them.
//
// Everything here works on both versions; the call sites move to it with the
// drizzle v1 bump (scripts/codemods/rqb-v2.ts).

// Subpath imports, not 'drizzle-orm': many route tests mock.module('drizzle-orm')
// with just the operators they use, and every file reaching a relational
// query loads this module.
import type { AnyColumn } from 'drizzle-orm';
import { Column } from 'drizzle-orm/column';
import { is } from 'drizzle-orm/entity';
import { asc, desc } from 'drizzle-orm/sql/expressions/select';
import { SQL, sql } from 'drizzle-orm/sql/sql';
import { getTableName, type Table } from 'drizzle-orm/table';
import { getTableColumns } from 'drizzle-orm/utils';

// The aliased table a relational query passes to a v2 callback. Typed loosely:
// the helpers only read its name and columns.
type AliasedTable = Table;
type Expr = SQL | SQL.Aliased | AnyColumn;

// Table metadata keys. Both drizzle versions register them with Symbol.for
// under these names; v1 types `Table.Symbol` and `Column.table` as internal,
// so they are read through these instead.
const IS_ALIAS = Symbol.for('drizzle:IsAlias');
const ORIGINAL_NAME = Symbol.for('drizzle:OriginalName');
const SCHEMA = Symbol.for('drizzle:Schema');
type TableMeta = Record<symbol, unknown>;
const tableOf = (column: AnyColumn) => (column as unknown as { table: Table }).table;
// The expression a sqlWhere filter was built from (see capturedWhere).
const SOURCE = Symbol.for('buildd:relational-where-source');

function columnKeyByName(table: AliasedTable): Map<string, AnyColumn> {
  const byName = new Map<string, AnyColumn>();
  for (const col of Object.values(getTableColumns(table)) as AnyColumn[]) byName.set(col.name, col);
  return byName;
}

function sameTable(column: AnyColumn, aliased: AliasedTable): boolean {
  const own = tableOf(column) as unknown as TableMeta;
  const target = aliased as unknown as TableMeta;
  if (own[IS_ALIAS]) return false;
  return getTableName(tableOf(column)) === target[ORIGINAL_NAME] && own[SCHEMA] === target[SCHEMA];
}

function remap<T>(value: T, aliased: AliasedTable, cols: () => Map<string, AnyColumn>): T {
  if (is(value, Column)) {
    const col = value as unknown as AnyColumn;
    return (sameTable(col, aliased) ? (cols().get(col.name) ?? col) : col) as T;
  }
  if (is(value, SQL)) {
    const src = value as unknown as SQL;
    const queryChunks = src.queryChunks.map((c) => remap(c, aliased, cols));
    // A copy, not `new SQL(chunks)`: it keeps what the caller set on the
    // fragment (mapWith decoder, inlined params).
    return Object.assign(Object.create(Object.getPrototypeOf(src)), src, { queryChunks }) as T;
  }
  if (is(value, SQL.Aliased)) {
    const src = value as unknown as SQL.Aliased;
    const out = new SQL.Aliased(remap(src.sql, aliased, cols), src.fieldAlias);
    // Internal flag on both versions; carried over so the copy behaves the same.
    const flag = (src as unknown as { isSelectionField?: boolean }).isSelectionField;
    if (flag) (out as unknown as { isSelectionField: boolean }).isSelectionField = true;
    return out as T;
  }
  return value;
}

/**
 * Re-point the columns of `aliased`'s underlying table inside `expr` at
 * `aliased`. Columns of other tables, params, raw strings and subquery
 * builders are returned as they are. `undefined` stays `undefined`.
 */
export function onQueryAlias<T extends Expr | undefined>(aliased: AliasedTable, expr: T): T {
  if (expr === undefined) return expr;
  let cols: Map<string, AnyColumn> | undefined;
  return remap(expr, aliased, () => (cols ??= columnKeyByName(aliased)));
}

/**
 * A v1-style SQL filter as a v2 relational `where`. The filter is built once,
 * here, as v1 built it; an undefined filter means no `where`.
 *
 * The callback's return type is `SQL`, which is what RQB v2 declares, although
 * it can return undefined when `expr` is an `and()` / `or()` of nothing. RQB v2
 * drops an undefined RAW part (relationsFilterToSQL pushes it into an `and()`,
 * which skips undefined operands), so the query is unfiltered on that branch,
 * exactly as v1 treated `where: undefined`.
 *
 * The returned object's only own key is `RAW`, which is all RQB v2 reads (it
 * walks `Object.entries(where)`). Its prototype is `expr` itself, so code that
 * inspects a captured filter, such as a test rendering the `where` a mocked
 * db.query received with PgDialect, still sees the SQL it was built from.
 */
export function sqlWhere(expr: SQL | undefined): { RAW: (table: any, operators: any) => SQL } | undefined {
  if (expr === undefined) return undefined;
  // A test's stand-in operator can return a primitive; it gets a plain object.
  const proto = typeof expr === 'object' && expr !== null ? expr : Object.prototype;
  const filter = Object.create(proto) as { RAW: (table: any, operators: any) => SQL };
  Object.defineProperty(filter, 'RAW', {
    value: (table: AliasedTable) => onQueryAlias(table, expr),
    enumerable: true,
  });
  // Non-enumerable, so RQB v2 never sees them. JSON.stringify of the filter
  // reads as the expression did.
  Object.defineProperty(filter, SOURCE, { value: expr });
  Object.defineProperty(filter, 'toJSON', { value: () => expr });
  return filter;
}

/**
 * A v1 `where` callback as a v2 `RAW` callback. Both receive the aliased
 * table and the operators, so the body is unchanged. The result is re-pointed
 * like `sqlWhere`'s, since v1 re-pointed a callback's result too (a body may
 * mix the parameter with the imported table). The declared return is widened
 * to allow undefined (`and()` / `or()` return `SQL | undefined`), which RQB v2
 * drops as described above. The parameter types come from the `RAW` slot.
 */
export function sqlWhereFn<T, O>(fn: (table: T, operators: O) => SQL | undefined): (table: T, operators: O) => SQL {
  return (table, operators) => onQueryAlias(table as unknown as AliasedTable, fn(table, operators)) as SQL;
}

type OrderTerm = SQL | AnyColumn;

/** A v1-style `orderBy` value (one term or an array) as a v2 orderBy callback. */
export function sqlOrderBy(
  expr: OrderTerm | OrderTerm[],
): (table: any, operators: any) => OrderTerm | OrderTerm[] {
  return (table: AliasedTable) =>
    Array.isArray(expr) ? expr.map((term) => onQueryAlias(table, term)) : onQueryAlias(table, expr);
}

/**
 * A v1 `orderBy` callback as a v2 one, its result re-pointed as v1 did. The
 * callback signatures already match; this only adds the re-pointing.
 */
export function sqlOrderByFn<T, O>(
  fn: (table: T, operators: O) => OrderTerm | OrderTerm[],
): (table: T, operators: O) => OrderTerm | OrderTerm[] {
  return (table, operators) => {
    const out = fn(table, operators);
    const aliased = table as unknown as AliasedTable;
    return Array.isArray(out) ? out.map((term) => onQueryAlias(aliased, term)) : onQueryAlias(aliased, out);
  };
}

type ExtraValue = SQL.Aliased | SQL;
type ExtraData<V> = V extends SQL.Aliased<infer U> ? U : V extends SQL<infer U> ? U : unknown;

/**
 * v1 `extras` (`{ key: sql`...`.as('key') }`) as v2 extras, one callback per
 * key. v2 names the field after the key, so the `.as()` alias is dropped.
 */
export function sqlExtras<E extends Record<string, ExtraValue>>(
  extras: E,
): { [K in keyof E]: (table: any, operators: any) => SQL<ExtraData<E[K]>> } {
  const out = {} as Record<string, (table: any, operators: any) => SQL>;
  for (const [key, value] of Object.entries(extras)) {
    const body = is(value, SQL.Aliased) ? (value as SQL.Aliased).sql : (value as SQL);
    out[key] = (table: AliasedTable) => onQueryAlias(table, body);
  }
  return out as { [K in keyof E]: (table: any, operators: any) => SQL<ExtraData<E[K]>> };
}

// ── Reading a captured config ───────────────────────────────────────────────
//
// For tests that mock db.query and assert on the config it was called with.
// Each accessor reads the RQB v1 shape (SQL, v1 callbacks) and the shape the
// helpers above produce, so such a test passes before and after the move.

/** The filter expression of a captured `where`: v1 SQL itself, or what sqlWhere wrapped. */
export function capturedWhere(where: unknown): any {
  if (where && typeof where === 'object' && SOURCE in where) return (where as Record<symbol, unknown>)[SOURCE];
  return where;
}

/** A captured `where` as a callable `(table, operators) => SQL`, whatever its form. */
export function capturedWhereFn(where: unknown): (table: any, operators: any) => any {
  if (typeof where === 'function') return where as (table: any, operators: any) => any;
  const raw = where && typeof where === 'object' ? (where as { RAW?: unknown }).RAW : undefined;
  if (typeof raw === 'function') return raw as (table: any, operators: any) => any;
  const source = capturedWhere(where);
  return () => source;
}

/**
 * The terms of a captured `orderBy`, as an array: v1 SQL / column / array, a
 * v1 callback, or a sqlOrderBy / sqlOrderByFn callback, called with `table`
 * and `operators` (drizzle's asc / desc / sql unless a test passes stand-ins).
 */
export function capturedOrderBy(orderBy: unknown, table: unknown, operators: object = { asc, desc, sql }): any[] {
  if (orderBy === undefined) return [];
  const value = typeof orderBy === 'function' ? (orderBy as (t: unknown, o: unknown) => unknown)(table, operators) : orderBy;
  return Array.isArray(value) ? value : [value];
}

/**
 * The fields of captured `extras`, as SQL by key: a v1 object or callback of
 * `.as()` fields, or v2 per-key callbacks, called with `table`.
 */
export function capturedExtras(extras: unknown, table: unknown): Record<string, SQL> {
  if (!extras) return {};
  const record = (typeof extras === 'function' ? (extras as (t: unknown, o: unknown) => unknown)(table, { sql }) : extras) as Record<string, unknown>;
  const out: Record<string, SQL> = {};
  for (const [key, value] of Object.entries(record)) {
    const field = typeof value === 'function' ? (value as (t: unknown, o: unknown) => unknown)(table, { sql }) : value;
    out[key] = (is(field, SQL.Aliased) ? (field as SQL.Aliased).sql : field) as SQL;
  }
  return out;
}
