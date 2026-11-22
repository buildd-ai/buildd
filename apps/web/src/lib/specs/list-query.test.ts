/**
 * The spec list's query: search text, order and status chips, read from the URL.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/specs/list-query.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { applyListQuery, escapeLike, listHref, parseListQuery, waitingOnYou } from './list-query';
import type { SpecIndexInput } from './index-view';

const spec = (id: string, over: Partial<SpecIndexInput> = {}): SpecIndexInput => ({
  id, title: id, scope: 'feature', parentSpecId: null, status: 'draft', approvedRevision: null, headRevision: 1,
  updatedAt: '2026-10-01T00:00:00Z', changedAt: '2026-10-01T00:00:00Z', ...over,
});

describe('parseListQuery', () => {
  it('defaults to recent order, no text, no chips', () => {
    expect(parseListQuery({})).toEqual({ q: '', sort: 'recent', filters: [] });
  });
  it('reads q, sort and chips, ignoring unknown values and repeats', () => {
    expect(parseListQuery({ q: '  T3 Code ', sort: 'tree', f: 'waiting,draft,bogus,draft' })).toEqual({ q: 'T3 Code', sort: 'tree', filters: ['waiting', 'draft'] });
    expect(parseListQuery({ f: ['approved', 'retired'], sort: 'x' })).toEqual({ q: '', sort: 'recent', filters: ['approved', 'retired'] });
  });
  it('caps the text', () => {
    expect(parseListQuery({ q: 'a'.repeat(500) }).q.length).toBe(200);
  });
});

describe('listHref', () => {
  it('writes only what differs from the default', () => {
    expect(listHref('/p', { q: '', sort: 'recent', filters: [] })).toBe('/p');
    expect(listHref('/p', { q: 'a b', sort: 'tree', filters: ['draft', 'waiting'] })).toBe('/p?q=a+b&sort=tree&f=draft%2Cwaiting');
  });
});

describe('escapeLike', () => {
  it('escapes wildcards so the text matches literally', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

describe('waitingOnYou', () => {
  it('is a revision waiting for approval, never a closed spec', () => {
    expect(waitingOnYou(spec('a', { status: 'in_review' }))).toBe(true);
    expect(waitingOnYou(spec('b', { status: 'approved', approvedRevision: 1, headRevision: 2 }))).toBe(true);
    expect(waitingOnYou(spec('c', { status: 'approved', approvedRevision: 2, headRevision: 2 }))).toBe(false);
    expect(waitingOnYou(spec('d', { status: 'retired', approvedRevision: 1, headRevision: 2 }))).toBe(false);
    expect(waitingOnYou(spec('e'))).toBe(false);
  });
});

describe('applyListQuery', () => {
  const rows = [
    spec('old', { changedAt: '2026-09-01T00:00:00Z' }),
    spec('new', { changedAt: '2026-10-09T00:00:00Z', status: 'approved', approvedRevision: 1 }),
    spec('mid', { changedAt: '2026-10-05T00:00:00Z', status: 'in_review' }),
    spec('gone', { changedAt: '2026-10-10T00:00:00Z', status: 'retired' }),
  ];
  const ids = (q: Parameters<typeof applyListQuery>[1], match: Set<string> | null = null) => applyListQuery(rows, q, match).map((r) => r.id);

  it('orders by head revision time, newest first, and hides retired', () => {
    expect(ids({ q: '', sort: 'recent', filters: [] })).toEqual(['new', 'mid', 'old']);
  });
  it('keeps the given (tree) order for sort=tree', () => {
    expect(ids({ q: '', sort: 'tree', filters: [] })).toEqual(['old', 'new', 'mid']);
    expect(applyListQuery([spec('p', { status: 'retired' }), spec('c', { parentSpecId: 'p' })], { q: '', sort: 'tree', filters: [] }, null).map((r) => r.id)).toEqual(['p', 'c']);
  });
  it('falls back to updatedAt when no head time is known', () => {
    const r = [spec('a', { changedAt: undefined, updatedAt: '2026-01-01T00:00:00Z' }), spec('b', { changedAt: undefined, updatedAt: '2026-02-01T00:00:00Z' })];
    expect(applyListQuery(r, { q: '', sort: 'recent', filters: [] }, null).map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('chips are a union; retired shows only when asked', () => {
    expect(ids({ q: '', sort: 'recent', filters: ['waiting'] })).toEqual(['mid']);
    expect(ids({ q: '', sort: 'recent', filters: ['approved', 'draft'] })).toEqual(['new', 'mid', 'old']);
    expect(ids({ q: '', sort: 'recent', filters: ['retired'] })).toEqual(['gone']);
  });
  it('keeps only the specs the search matched', () => {
    expect(ids({ q: 'x', sort: 'recent', filters: [] }, new Set(['old', 'gone']))).toEqual(['old']);
    expect(ids({ q: 'x', sort: 'recent', filters: ['retired'] }, new Set(['old', 'gone']))).toEqual(['gone']);
  });
  it('tree order keeps the matched specs\' ancestors so the outline still hangs together', () => {
    const t = [
      spec('prod', { scope: 'product', status: 'approved', approvedRevision: 1 }),
      spec('area', { scope: 'domain', parentSpecId: 'prod', status: 'approved', approvedRevision: 1 }),
      spec('leaf', { parentSpecId: 'area' }),
      spec('other', { parentSpecId: 'area' }),
    ];
    expect(applyListQuery(t, { q: 'l', sort: 'tree', filters: [] }, new Set(['leaf'])).map((r) => r.id)).toEqual(['prod', 'area', 'leaf']);
  });
});
