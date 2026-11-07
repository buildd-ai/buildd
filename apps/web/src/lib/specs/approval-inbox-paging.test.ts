import { describe, it, expect } from 'bun:test';
import { inboxShownCount, INBOX_PAGE_SIZE } from './approval-inbox-paging';

describe('inboxShownCount', () => {
  it('defaults to one page', () => expect(inboxShownCount(undefined, 120)).toBe(INBOX_PAGE_SIZE));
  it('honours a larger request', () => expect(inboxShownCount('30', 120)).toBe(30));
  it('clamps to total', () => expect(inboxShownCount('500', 42)).toBe(42));
  it('ignores junk and small values', () => {
    expect(inboxShownCount('abc', 120)).toBe(INBOX_PAGE_SIZE);
    expect(inboxShownCount('-5', 120)).toBe(INBOX_PAGE_SIZE);
  });
  it('handles fewer rows than a page', () => expect(inboxShownCount(undefined, 3)).toBe(3));
});
