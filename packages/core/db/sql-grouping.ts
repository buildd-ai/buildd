// Test helper: make a rendered SQL string independent of how the installed
// drizzle version parenthesises boolean operands.
//
// drizzle 0.45 renders and(a, b) as `(a and b)`. drizzle v1 renders it as
// `((a) and (b))`, and nests or() under and() as `((((x)) or (y)))`. The two
// mean the same thing, but a test asserting a substring of the rendered SQL
// pins one or the other. Run both the actual SQL and (if it is not already in
// this form) the expected fragment through this, and the assertion holds on
// either version.
//
// Canonical form = drizzle 0.45's output. Starting from the innermost group:
//   1. `((x))` collapses to `(x)`;
//   2. a group in operand position (start of a group, or after and / or / not
//      / where / on / having / when) is unwrapped when nothing inside it is a
//      top-level `and` / `or`.
// A group whose content does contain a top-level and/or keeps its parentheses,
// so precedence is still asserted. List and subquery parentheses (`in (...)`,
// `exists (...)`, function calls) are never in operand position and are kept.
// Quoted identifiers and string literals are opaque.

import { PgDialect } from 'drizzle-orm/pg-core';

type Node = string | Node[];

function parse(sql: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let text = '';
  const flush = () => {
    if (text) stack[stack.length - 1].push(text);
    text = '';
  };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '"' || ch === "'") {
      // Quoted identifier or literal; a doubled quote is an escaped quote.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      text += sql.slice(i, j + 1);
      i = j;
    } else if (ch === '(') {
      flush();
      const group: Node[] = [];
      stack[stack.length - 1].push(group);
      stack.push(group);
    } else if (ch === ')' && stack.length > 1) {
      flush();
      stack.pop();
    } else {
      text += ch;
    }
  }
  flush();
  // Unbalanced input: give back what we have rather than throwing in a test.
  return root;
}

function print(nodes: Node[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : `(${print(n)})`)).join('');
}

const unquoted = (s: string) => s.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'/g, ' ');

function hasTopLevelBoolean(nodes: Node[]): boolean {
  return nodes.some((n) => typeof n === 'string' && /\b(and|or)\b/i.test(unquoted(n)));
}

function isOperandPosition(before: string): boolean {
  const t = unquoted(before).trimEnd();
  return t === '' || /(^|\s)(and|or|not|where|on|having|when)$/i.test(t);
}

function normalise(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if (typeof node === 'string') {
      out.push(node);
      continue;
    }
    let inner = normalise(node);
    // ((x)) -> (x)
    for (;;) {
      const meaningful = inner.filter((n) => typeof n !== 'string' || n.trim() !== '');
      if (meaningful.length === 1 && typeof meaningful[0] !== 'string') inner = meaningful[0];
      else break;
    }
    if (isOperandPosition(print(out)) && !hasTopLevelBoolean(inner)) out.push(...inner);
    else out.push(inner);
  }
  return out;
}

export function normaliseSqlGrouping(sql: string): string {
  return print(normalise(parse(sql)));
}

/**
 * A PgDialect whose rendered SQL is already normalised: swap it in for
 * `new PgDialect()` in a test that asserts on `sqlToQuery(...).sql`.
 */
export class GroupingNormalisedPgDialect extends PgDialect {
  override sqlToQuery(...args: Parameters<PgDialect['sqlToQuery']>): ReturnType<PgDialect['sqlToQuery']> {
    const q = super.sqlToQuery(...args);
    return { ...q, sql: normaliseSqlGrouping(q.sql) };
  }
}
