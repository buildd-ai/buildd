import { describe, expect, it } from 'bun:test';
import { truncateExcerpt, ERROR_EXCERPT_MAX } from './error-excerpt';

describe('truncateExcerpt — the failed phase shows a line, not the whole error', () => {
  it('returns null for no error', () => {
    expect(truncateExcerpt(null)).toBeNull();
    expect(truncateExcerpt(undefined)).toBeNull();
    expect(truncateExcerpt('   ')).toBeNull();
  });

  it('keeps a short error as-is', () => {
    expect(truncateExcerpt('Build failed: missing module')).toBe('Build failed: missing module');
  });

  it('cuts a long error at the limit with an ellipsis', () => {
    const out = truncateExcerpt('x'.repeat(ERROR_EXCERPT_MAX * 3))!;
    expect(out.length).toBe(ERROR_EXCERPT_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps only the first line of a multi-line error', () => {
    expect(truncateExcerpt('Tests failed\n  at foo.ts:1\n  at bar.ts:2')).toBe('Tests failed…');
  });
});
