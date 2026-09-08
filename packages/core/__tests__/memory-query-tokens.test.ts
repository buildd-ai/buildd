import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  MAX_QUERY_TOKENS,
  MIN_TOKEN_LENGTH,
  tokenizeMemoryQuery,
} from '../memory-query-tokens';
import { tokenMatchScoreSql } from '../memory-query-tokens-sql';

/**
 * The failure this prevents is specific and was measured in production: an
 * unfiltered `split(/\s+/)` on a task title yields tokens like `the` and `for`,
 * `MemoryStore.search` matches if ANY token appears, and results are ordered by
 * recency — so the caller receives "the N most recently updated memories"
 * with a populated match count that looks like retrieval working.
 */
describe('tokenizeMemoryQuery', () => {
  it('keeps the meaningful tokens of a real task title', () => {
    expect(tokenizeMemoryQuery('error-trace scanner: audit the remaining slugs for requiresError'))
      .toEqual(['error-trace', 'scanner', 'audit', 'remaining', 'slugs', 'requiresError']);
  });

  // `%the%` matches almost any prose. This is the whole point of the module.
  it('drops stopwords', () => {
    expect(tokenizeMemoryQuery('the and for with from that this')).toEqual([]);
    expect(tokenizeMemoryQuery('fix the runner')).toEqual(['fix', 'runner']);
  });

  it('a title made only of stopwords searches nothing, not everything', () => {
    expect(tokenizeMemoryQuery('the and for')).toEqual([]);
  });

  // `scanner:` as a pattern is `%scanner:%`, which does not match the word
  // `scanner` in prose — so the token would silently contribute nothing.
  it('strips edge punctuation that would break the pattern', () => {
    expect(tokenizeMemoryQuery('scanner: audit')).toEqual(['scanner', 'audit']);
    expect(tokenizeMemoryQuery('(parenthesised) "quoted" trailing.')).toEqual(['parenthesised', 'quoted', 'trailing']);
  });

  // Separators inside identifiers are load-bearing and must survive.
  it('preserves punctuation inside identifiers', () => {
    expect(tokenizeMemoryQuery('worker_action_events and error-trace')).toEqual(['worker_action_events', 'error-trace']);
    expect(tokenizeMemoryQuery('apps/runner/src/index.ts')).toEqual(['apps/runner/src/index.ts']);
  });

  it('drops tokens too short to be worth a corpus scan', () => {
    expect(MIN_TOKEN_LENGTH).toBe(3);
    expect(tokenizeMemoryQuery('a bc def')).toEqual(['def']);
  });

  it('de-duplicates case-insensitively but keeps the first casing', () => {
    expect(tokenizeMemoryQuery('Runner runner RUNNER')).toEqual(['Runner']);
  });

  it('caps the token count', () => {
    const many = Array.from({ length: MAX_QUERY_TOKENS * 3 }, (_, i) => `token${i}`).join(' ');
    expect(tokenizeMemoryQuery(many)).toHaveLength(MAX_QUERY_TOKENS);
  });

  it('handles junk without throwing', () => {
    expect(tokenizeMemoryQuery(null)).toEqual([]);
    expect(tokenizeMemoryQuery(undefined)).toEqual([]);
    expect(tokenizeMemoryQuery('')).toEqual([]);
    expect(tokenizeMemoryQuery('   ')).toEqual([]);
    expect(tokenizeMemoryQuery(42 as unknown as string)).toEqual([]);
    expect(tokenizeMemoryQuery('--- !!! ***')).toEqual([]);
  });

  it('keeps domain verbs that genuinely narrow the corpus', () => {
    // These are common in titles but NOT in most memory bodies, so unlike
    // `the` they carry signal and must not be filtered.
    expect(tokenizeMemoryQuery('fix add remove surface migration')).toEqual(
      ['fix', 'add', 'remove', 'surface', 'migration']);
  });
});

/**
 * Rendered with the real dialect, not a mock. The sibling file-scope fragment
 * shipped invalid SQL that only this technique caught, and the store's mocked
 * test ignores `orderBy` entirely — so it would never evaluate this expression.
 */
describe('tokenMatchScoreSql', () => {
  const dialect = new PgDialect();
  const render = (frag: unknown) => {
    const q = dialect.sqlToQuery(frag as never);
    return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
  };

  it('returns null with no tokens, so the caller falls back to recency', () => {
    expect(tokenMatchScoreSql([])).toBeNull();
  });

  it('scores one point per token across title and content', () => {
    const { sql: text, params } = render(tokenMatchScoreSql(['alpha', 'beta']));
    expect(text).toContain('case when');
    expect(text).toContain('ilike');
    expect(text).toContain('+');
    // Two tokens x (title, content) = four patterns bound as params.
    expect(params).toEqual(['%alpha%', '%alpha%', '%beta%', '%beta%']);
  });

  it('is a single summed expression, one term per token', () => {
    const one = render(tokenMatchScoreSql(['alpha']));
    const three = render(tokenMatchScoreSql(['alpha', 'beta', 'gamma']));
    expect((one.sql.match(/case when/g) ?? []).length).toBe(1);
    expect((three.sql.match(/case when/g) ?? []).length).toBe(3);
    expect((three.sql.match(/\+/g) ?? []).length).toBe(2);
  });

  it('binds the patterns rather than interpolating them', () => {
    const { sql: text } = render(tokenMatchScoreSql(["o'brien"]));
    expect(text).not.toContain("o'brien");
  });
});
