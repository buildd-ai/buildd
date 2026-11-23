/**
 * The workspace spec list's query: search text, order and status chips, kept
 * in the URL (`?q=`, `?sort=`, `?f=`). Pure: the page reads the URL, the store
 * finds the text matches, this decides what shows and in what order.
 */
import type { SpecIndexInput } from './index-view';

export const LIST_FILTERS = ['waiting', 'draft', 'approved', 'retired'] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];
export type ListSort = 'recent' | 'tree';
export const MAX_QUERY_CHARS = 200;

export interface ListQuery { q: string; sort: ListSort; filters: ListFilter[] }

type Param = string | string[] | undefined;

export function parseListQuery(params: Record<string, Param>): ListQuery {
  const first = (v: Param) => (Array.isArray(v) ? v[0] : v) ?? '';
  const raw = (Array.isArray(params.f) ? params.f : [params.f ?? '']).join(',').split(',').map((s) => s.trim());
  const filters = [...new Set(raw)].filter((f): f is ListFilter => (LIST_FILTERS as readonly string[]).includes(f));
  return { q: first(params.q).trim().slice(0, MAX_QUERY_CHARS), sort: first(params.sort) === 'tree' ? 'tree' : 'recent', filters };
}

/** The URL for a query on `path`: only what differs from the default is written. */
export function listHref(path: string, q: ListQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.sort !== 'recent') p.set('sort', q.sort);
  if (q.filters.length) p.set('f', q.filters.join(','));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** Escape LIKE wildcards so the text is matched literally (ESCAPE '\'). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const closed = (s: Pick<SpecIndexInput, 'status'>) => s.status === 'retired' || s.status === 'superseded';

/** A revision is waiting for a person's approval: in review, or the head is past the approved one. */
export function waitingOnYou(s: Pick<SpecIndexInput, 'status' | 'approvedRevision' | 'headRevision'>): boolean {
  if (closed(s)) return false;
  return s.status === 'in_review' || (s.approvedRevision != null && s.headRevision > s.approvedRevision);
}

function passes(s: SpecIndexInput, filters: readonly ListFilter[]): boolean {
  if (!filters.length) return !closed(s);
  return filters.some((f) => {
    if (f === 'retired') return closed(s);
    if (closed(s)) return false;
    if (f === 'waiting') return waitingOnYou(s);
    if (f === 'draft') return s.approvedRevision == null;
    return s.approvedRevision != null;
  });
}

const time = (s: SpecIndexInput) => new Date(s.changedAt ?? s.updatedAt).getTime();

/**
 * What the list shows. `matched` is the ids the text search found (null: no
 * search). Recent order is flat, newest head revision first; tree order keeps
 * the given order and adds the matched specs' ancestors so the outline holds.
 */
export function applyListQuery(rows: readonly SpecIndexInput[], q: ListQuery, matched: ReadonlySet<string> | null): SpecIndexInput[] {
  const kept = rows.filter((s) => (!matched || matched.has(s.id)) && passes(s, q.filters));
  if (q.sort === 'recent') return [...kept].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep = new Set(kept.map((r) => r.id));
  for (const s of kept) {
    const seen = new Set<string>([s.id]);
    let p = s.parentSpecId ? byId.get(s.parentSpecId) : undefined;
    while (p && !seen.has(p.id)) { keep.add(p.id); seen.add(p.id); p = p.parentSpecId ? byId.get(p.parentSpecId) : undefined; }
  }
  return rows.filter((r) => keep.has(r.id));
}
