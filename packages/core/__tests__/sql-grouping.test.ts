import { describe, it, expect } from 'bun:test';
import { and, or, not, eq, isNull, inArray, notInArray, gt } from 'drizzle-orm';
import { PgDialect, pgTable, text, integer } from 'drizzle-orm/pg-core';
import { normaliseSqlGrouping } from '../db/sql-grouping';

// drizzle 0.45 renders and(a, b) as `(a and b)`; drizzle v1 wraps every
// operand, often twice: `((a) and (b))`. Both mean the same thing. These pairs
// were rendered by each version's PgDialect from the same predicates, so the
// normaliser is pinned against real output of both, not a guess at v1's.
const PAIRS: Array<[name: string, v0: string, v1: string]> = [
  ['and of two', '("t"."a" = $1 and "t"."b" = $2)', '(("t"."a" = $1) and ("t"."b" = $2))'],
  [
    'and of three',
    '("t"."a" = $1 and "t"."b" = $2 and "t"."c" is null)',
    '(("t"."a" = $1) and ("t"."b" = $2) and (("t"."c" is null)))',
  ],
  [
    'or inside and',
    '("t"."a" = $1 and ("t"."b" is null or "t"."b" = $2))',
    '(("t"."a" = $1) and (((("t"."b" is null)) or ("t"."b" = $2))))',
  ],
  [
    'and inside or',
    '(("t"."a" = $1 and "t"."b" = $2) or "t"."c" is null)',
    '(((("t"."a" = $1) and ("t"."b" = $2))) or (("t"."c" is null)))',
  ],
  [
    'in, not in, not',
    '("t"."a" in ($1, $2) and "t"."b" not in ($3) and not "t"."c" = $4)',
    '(("t"."a" in ($1, $2)) and ("t"."b" not in ($3)) and (not ("t"."c" = $4)))',
  ],
  [
    'nested and',
    '(("t"."a" = $1 and "t"."b" = $2) and "t"."c" > $3)',
    '(((("t"."a" = $1) and ("t"."b" = $2))) and ("t"."c" > $3))',
  ],
  ['single operand', '"t"."a" = $1', '"t"."a" = $1'],
];

describe('normaliseSqlGrouping', () => {
  for (const [name, v0, v1] of PAIRS) {
    it(`renders v0 and v1 the same: ${name}`, () => {
      expect(normaliseSqlGrouping(v1)).toBe(normaliseSqlGrouping(v0));
    });
    it(`is the identity on v0 output: ${name}`, () => {
      expect(normaliseSqlGrouping(v0)).toBe(v0);
    });
  }

  it('keeps the parentheses that carry precedence', () => {
    // An or under an and must stay grouped, or the assertion would accept a
    // predicate that means something else.
    expect(normaliseSqlGrouping('(("a" = $1) and ((("b" is null) or ("b" = $2))))')).toBe(
      '("a" = $1 and ("b" is null or "b" = $2))'
    );
  });

  it('keeps list and subquery parentheses', () => {
    expect(normaliseSqlGrouping('(("a" in ($1, $2)) and ("b" in (select "id" from "u")))')).toBe(
      '("a" in ($1, $2) and "b" in (select "id" from "u"))'
    );
    expect(normaliseSqlGrouping('("a" = any ($1))')).toBe('"a" = any ($1)');
  });

  it('ignores parentheses and keywords inside quoted identifiers and literals', () => {
    expect(normaliseSqlGrouping(`(("a" = 'x) or (y') and ("or(" = $1))`)).toBe(
      `("a" = 'x) or (y' and "or(" = $1)`
    );
  });

  it('is stable on the dialect installed here (whatever version that is)', () => {
    const t = pgTable('t', { a: text('a'), b: text('b'), c: integer('c') });
    const d = new PgDialect();
    const render = (s: Parameters<PgDialect['sqlToQuery']>[0]) => normaliseSqlGrouping(d.sqlToQuery(s).sql);
    expect(render(and(eq(t.a, 'x'), or(isNull(t.b), eq(t.b, 'y')))!)).toBe(
      '("t"."a" = $1 and ("t"."b" is null or "t"."b" = $2))'
    );
    expect(render(and(inArray(t.a, ['p', 'q']), notInArray(t.b, ['r']), not(eq(t.c, 1)))!)).toBe(
      '("t"."a" in ($1, $2) and "t"."b" not in ($3) and not "t"."c" = $4)'
    );
    expect(render(and(and(eq(t.a, 'x'), eq(t.b, 'y')), gt(t.c, 2))!)).toBe(
      '(("t"."a" = $1 and "t"."b" = $2) and "t"."c" > $3)'
    );
  });
});
