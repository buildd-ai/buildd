/** The completed page's server-side title search (Surface IA AC-65). */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { completedTitleMatch, likePattern } from './mission-list-load';

describe('completed missions title search', () => {
  it('matches a substring and treats ILIKE wildcards as literal', () => {
    expect(likePattern('runner')).toBe('%runner%');
    expect(likePattern('100%_done\\')).toBe('%100\\%\\_done\\\\%');
  });

  it('an empty or blank query adds no filter', () => {
    expect(completedTitleMatch(null)).toBeUndefined();
    expect(completedTitleMatch('   ')).toBeUndefined();
    expect(completedTitleMatch('login')).toBeDefined();
  });

  it('renders as a case-insensitive title match with the escaped pattern bound as a parameter', () => {
    const q = new PgDialect().sqlToQuery(completedTitleMatch('50%')!);
    expect(q.sql).toMatch(/"missions"\."title" ilike \$1/);
    expect(q.params).toEqual(['%50\\%%']);
  });
});
