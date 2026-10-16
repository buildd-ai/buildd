/**
 * The spec index (living-specs.md §19): a workspace's specs as one card per
 * area, each listing its own specs, grouped by product. Pure: no DB, so the page,
 * the dev fixture and the DOM tests all feed it the same shape.
 *
 * What it reads per spec is the list row plus three optional facts other
 * parts of buildd own, each rendered only when present:
 * - `imported`: an imported revision awaiting confirmation (§18 R-18/R-19).
 * - `failing`: why it is failing, in words (R-22: a failing governed outcome,
 *   a design changed since approval, or a stale repo file).
 * - `suggestion`: where an unfiled spec probably belongs (§17 R-7/R-9, else
 *   §14's `suggestParent`), and `filedBy: 'buildd'` for a filing buildd made.
 * Possible areas come from `new_area` suggestions sharing a title and from
 * taxonomy proposals (§17 R-4) passed in `options.proposals`.
 */

export type SpecMixState = 'approved' | 'draft' | 'imported' | 'failing';
/** Fill order of a status mix, left to right, and the order counts are said in. */
export const MIX_STATES: readonly SpecMixState[] = ['approved', 'draft', 'imported', 'failing'];

export type SpecSuggestion =
  /** Under an existing product or area. */
  | { kind: 'parent'; specId: string; title: string; reason: string; filingId?: string | null }
  /** A new area buildd would make (§17 R-6 `new_area`). */
  | { kind: 'new_area'; title: string; reason?: string | null; filingId?: string | null };

export interface SpecIndexInput {
  id: string;
  title: string;
  scope: string;
  parentSpecId: string | null;
  status: string;
  approvedRevision: number | null;
  headRevision: number;
  updatedAt: Date | string;
  imported?: boolean;
  failing?: string | null;
  filedBy?: 'buildd' | null;
  /** The `spec_filings` row behind "Filed by buildd", for its undo. */
  filingId?: string | null;
  /**
   * Where an unfiled spec probably belongs: an open `spec_filings` suggestion
   * (it carries `filingId`, so accept and dismiss are recorded), else
   * `suggestParent`.
   */
  suggestion?: SpecSuggestion | null;
}

/** An area of a taxonomy proposal no person has acted on (§17 R-4). */
export interface AreaProposal {
  /** The taxonomy proposal's key for this area: accepting sends it to organize. */
  key?: string | null;
  title: string;
  specIds: string[];
  /** Where a person accepts it; absent until the proposal flow exists. */
  acceptHref?: string | null;
  /** Which proposal it is from (organize's `proposedBy.source`), sent back on accept so the keys match. */
  source?: 'model' | 'words';
}

export interface SpecIndexOptions {
  proposals?: AreaProposal[];
  /** The taxonomy proposal, for the "none filed yet" line. */
  taxonomyHref?: string | null;
  now?: number;
}

export interface IndexRow {
  id: string;
  title: string;
  scope: string;
  /** Exclusive state for counting; null for a retired or superseded spec (not counted). */
  state: SpecMixState | null;
  standing: string;
  waiting: number | null;
  updatedAgo: string;
  imported: boolean;
  failing: string | null;
  filedBy: 'buildd' | null;
  filingId: string | null;
  suggestion: SpecSuggestion | null;
  children: IndexRow[];
}

export type Mix = Record<SpecMixState, number>;

export interface IndexArea {
  /** The area spec's id (or the product's, for the specs filed directly under a product). */
  id: string;
  title: string;
  kind: 'area' | 'product';
  productId: string | null;
  /** The area or product spec itself. */
  head: IndexRow;
  /** Its features, children nested. */
  rows: IndexRow[];
  /** Every spec it holds, at any depth (not the head). */
  specIds: string[];
  count: number;
  mix: Mix;
  /** "9 specs, 7 approved, 1 draft, 1 failing". */
  words: string;
}

export interface IndexProduct {
  /** Null for areas with no product above them. */
  head: IndexRow | null;
  areas: IndexArea[];
}

export interface PossibleArea {
  key: string;
  /** The taxonomy proposal key, when it is one. */
  proposalKey: string | null;
  /** Which proposal the key is from, when it is one. */
  proposalSource?: 'model' | 'words';
  title: string;
  specIds: string[];
  acceptHref: string | null;
}

/** A possible area with its member rows, in the order given. */
export type PossibleGroup = PossibleArea & { rows: IndexRow[] };

export interface SpecIndexView {
  /** Specs counted (not products or areas, not retired or superseded). */
  total: number;
  products: IndexProduct[];
  areas: IndexArea[];
  /** Specs buildd could not place, in order. Empty means no Unfiled group. */
  unfiled: IndexRow[];
  possibleAreas: PossibleArea[];
  /** Possible areas with their rows: each renders as a dashed card holding its specs (R-24). */
  possible: PossibleGroup[];
  /** Unfiled specs in no possible area: the Unfiled card. */
  loose: IndexRow[];
  /** Specs with a revision waiting for approval, in outline order. */
  waiting: IndexRow[];
  /** Areas holding at least one spec. */
  areaCount: number;
  /** The one line of counts in words: "16 specs in 6 areas, 2 unfiled" (R-26). */
  line: { text: string; href: string | null };
  /** More than one product: the outline names each; with one it is said by the page. */
  manyProducts: boolean;
  /** Every row by id, for filtering and lookups. */
  rowsById: Map<string, IndexRow>;
}

const isArea = (scope: string) => scope === 'product' || scope === 'domain';
const isClosed = (status: string) => status === 'retired' || status === 'superseded';

export function ago(at: Date | string, now = Date.now()): string {
  const mins = Math.floor((now - new Date(at).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function standingOf(s: Pick<SpecIndexInput, 'status' | 'approvedRevision' | 'headRevision'>): { standing: string; waiting: number | null } {
  if (isClosed(s.status)) return { standing: s.status, waiting: null };
  if (s.approvedRevision == null) return { standing: 'draft, never approved', waiting: null };
  return { standing: `approved at revision ${s.approvedRevision}`, waiting: s.headRevision > s.approvedRevision ? s.headRevision : null };
}

/** One state per spec, so a mix's segments add up: failing, then imported, then draft, then approved. */
export function mixState(s: Pick<SpecIndexInput, 'status' | 'approvedRevision' | 'imported' | 'failing'>): SpecMixState | null {
  if (isClosed(s.status)) return null;
  if (s.failing) return 'failing';
  if (s.imported) return 'imported';
  return s.approvedRevision == null ? 'draft' : 'approved';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "9 specs, 7 approved, 1 draft, 1 failing"; zero counts are left out. */
export function mixWords(count: number, mix: Mix): string {
  const parts = [plural(count, 'spec')];
  for (const s of MIX_STATES) if (mix[s]) parts.push(`${mix[s]} ${s}`);
  return parts.join(', ');
}

const emptyMix = (): Mix => ({ approved: 0, draft: 0, imported: 0, failing: 0 });

function collect(rows: readonly IndexRow[], into: { ids: string[]; mix: Mix }) {
  for (const r of rows) {
    if (r.state) { into.ids.push(r.id); into.mix[r.state]++; }
    else into.ids.push(r.id);
    collect(r.children, into);
  }
}

function areaOf(head: IndexRow, kind: IndexArea['kind'], productId: string | null, rows: IndexRow[]): IndexArea {
  const acc = { ids: [] as string[], mix: emptyMix() };
  collect(rows, acc);
  const count = MIX_STATES.reduce((n, s) => n + acc.mix[s], 0);
  return { id: head.id, title: head.title, kind, productId, head, rows, specIds: acc.ids, count, mix: acc.mix, words: mixWords(count, acc.mix) };
}

export function specIndexView(input: readonly SpecIndexInput[], options: SpecIndexOptions = {}): SpecIndexView {
  const now = options.now ?? Date.now();
  const ids = new Set(input.map((r) => r.id));
  const rowsById = new Map<string, IndexRow>();
  for (const r of input) {
    rowsById.set(r.id, {
      id: r.id, title: r.title, scope: r.scope, state: isArea(r.scope) ? null : mixState(r), ...standingOf(r),
      updatedAgo: ago(r.updatedAt, now), imported: !!r.imported, failing: r.failing || null,
      filedBy: r.filedBy ?? null, filingId: r.filingId ?? null, suggestion: r.suggestion ?? null, children: [],
    });
  }
  const roots: IndexRow[] = [];
  for (const r of input) {
    const row = rowsById.get(r.id)!;
    if (r.parentSpecId && ids.has(r.parentSpecId) && r.parentSpecId !== r.id) rowsById.get(r.parentSpecId)!.children.push(row);
    else roots.push(row);
  }

  const products: IndexProduct[] = [];
  const looseAreas: IndexArea[] = [];
  const unfiled: IndexRow[] = [];
  for (const root of roots) {
    if (root.scope === 'product') {
      const areas: IndexArea[] = [];
      const direct: IndexRow[] = [];
      for (const c of root.children) {
        if (c.scope === 'domain') areas.push(areaOf(c, 'area', root.id, c.children));
        else direct.push(c);
      }
      // Specs filed straight under the product, with no area, are the product's own group.
      if (direct.length) areas.unshift(areaOf(root, 'product', root.id, direct));
      products.push({ head: root, areas });
    } else if (root.scope === 'domain') {
      looseAreas.push(areaOf(root, 'area', null, root.children));
    } else {
      unfiled.push(root);
    }
  }
  if (looseAreas.length) products.push({ head: null, areas: looseAreas });
  const areas = products.flatMap((p) => p.areas);

  // Possible areas (R-24): two or more unfiled specs answered new_area with one title, or a taxonomy proposal's area.
  const unfiledIds = new Set(unfiled.map((u) => u.id));
  const possibleAreas: PossibleArea[] = [];
  const claimed = new Set<string>();
  for (const p of options.proposals ?? []) {
    const members = p.specIds.filter((id) => unfiledIds.has(id) && !claimed.has(id));
    if (!members.length) continue;
    members.forEach((id) => claimed.add(id));
    possibleAreas.push({ key: `proposal:${p.key ?? p.title}`, proposalKey: p.key ?? null, ...(p.source ? { proposalSource: p.source } : {}), title: p.title, specIds: members, acceptHref: p.acceptHref ?? null });
  }
  const byTitle = new Map<string, { title: string; ids: string[] }>();
  for (const u of unfiled) {
    if (claimed.has(u.id) || u.suggestion?.kind !== 'new_area') continue;
    const k = u.suggestion.title.trim().toLowerCase();
    if (!k) continue;
    const g = byTitle.get(k) ?? { title: u.suggestion.title.trim(), ids: [] };
    g.ids.push(u.id);
    byTitle.set(k, g);
  }
  for (const [k, g] of byTitle) {
    if (g.ids.length < 2) continue;
    g.ids.forEach((id) => claimed.add(id));
    possibleAreas.push({ key: `new_area:${k}`, proposalKey: null, title: g.title, specIds: g.ids, acceptHref: null });
  }

  const withRows = (ps: PossibleArea[]) => ps.map((p) => ({ ...p, rows: p.specIds.map((id) => rowsById.get(id)!) }));
  const filed = areas.reduce((n, a) => n + a.count, 0);
  const unfiledCount = countDeep(unfiled);
  const total = filed + unfiledCount;
  const areaCount = areas.filter((a) => a.count > 0).length;
  const waiting: IndexRow[] = [];
  const walk = (rows: readonly IndexRow[]) => { for (const r of rows) { if (r.waiting && r.state) waiting.push(r); walk(r.children); } };
  for (const a of areas) walk(a.rows);
  walk(unfiled);
  const line = indexLine(total, areaCount, unfiledCount, options.taxonomyHref ?? null);
  const manyProducts = products.filter((p) => p.head).length > 1;
  return { total, products, areas, unfiled, possibleAreas, possible: withRows(possibleAreas), loose: unfiled.filter((u) => !claimed.has(u.id)), waiting, areaCount, line, manyProducts, rowsById };
}

function countDeep(rows: readonly IndexRow[]): number {
  let n = 0;
  for (const r of rows) { if (r.state) n++; n += countDeep(r.children); }
  return n;
}

/** R-26: the counts in one line of words; the cards below carry each area's own. */
function indexLine(total: number, areas: number, unfiled: number, taxonomyHref: string | null): { text: string; href: string | null } {
  const specs = plural(total, 'spec');
  if (total === 0) return { text: 'No specs yet', href: null };
  if (areas === 0) return { text: `${specs}, none filed yet`, href: taxonomyHref };
  return { text: `${specs} in ${plural(areas, 'area')}${unfiled ? `, ${unfiled} unfiled` : ''}`, href: null };
}

/** The neighbour graph's cap on neighbours (R-28), and on siblings so it stays readable. */
export const GRAPH_MAX_NEIGHBOURS = 8;
export const GRAPH_MAX_SIBLINGS = 6;

export interface GraphNode { id: string; title: string; relation: string; href: string | null }
export interface NeighbourGraph {
  self: GraphNode;
  parent: GraphNode | null;
  siblings: GraphNode[];
  neighbours: GraphNode[];
  /** Entries the graph left out, said under it. */
  omittedSiblings: number;
  omittedNeighbours: number;
}

/** A graph node's title in at most `lines` lines of `max` characters, broken at words, "…" where it was cut. Pure. */
export function titleLines(title: string, max = 22, lines = 2): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (out.length < lines && i < words.length) {
    let line = words[i++];
    while (i < words.length && `${line} ${words[i]}`.length <= max) line = `${line} ${words[i++]}`;
    out.push(line.length > max ? `${line.slice(0, max - 1)}…` : line);
  }
  if (i < words.length && out.length) {
    const last = out[out.length - 1].replace(/…$/, '');
    out[out.length - 1] = `${last.length >= max ? last.slice(0, max - 1) : last}…`;
  }
  return out;
}

const KIND_WORDS: Record<string, string> = { overlaps: 'overlaps', shares_files: 'shares files', similar: 'similar' };

/** The spec, its parent, siblings and up to 8 neighbours, each edge's kind in words. Pure. */
export function neighbourGraph(input: {
  spec: { id: string; title: string };
  parent: { id: string; title: string } | null;
  siblings: ReadonlyArray<{ id: string; title: string }>;
  nearby: ReadonlyArray<{ specId: string; title: string; kind: string }>;
}): NeighbourGraph {
  const seen = new Set([input.spec.id, ...(input.parent ? [input.parent.id] : [])]);
  const sibs = input.siblings.filter((s) => !seen.has(s.id));
  sibs.forEach((s) => seen.add(s.id));
  const near = input.nearby.filter((n) => !seen.has(n.specId));
  return {
    self: { id: input.spec.id, title: input.spec.title, relation: 'this spec', href: null },
    parent: input.parent ? { id: input.parent.id, title: input.parent.title, relation: 'part of', href: `/app/specs/${input.parent.id}` } : null,
    siblings: sibs.slice(0, GRAPH_MAX_SIBLINGS).map((s) => ({ id: s.id, title: s.title, relation: 'sibling', href: `/app/specs/${s.id}` })),
    neighbours: near.slice(0, GRAPH_MAX_NEIGHBOURS).map((n) => ({ id: n.specId, title: n.title, relation: KIND_WORDS[n.kind] ?? n.kind, href: `/app/specs/${n.specId}` })),
    omittedSiblings: Math.max(0, sibs.length - GRAPH_MAX_SIBLINGS),
    omittedNeighbours: Math.max(0, near.length - GRAPH_MAX_NEIGHBOURS),
  };
}

/** The part of a `spec_filings` view (§17) the index reads; structural so this file stays free of DB imports. */
export interface IndexFiling {
  id: string;
  kind: 'filed' | 'suggested';
  status: string;
  parent: { specId: string; title: string } | null;
  source: string;
  p: number | null;
  newArea: { title: string; charter: string } | null;
}

/**
 * What a spec's live filing says on the index (§17 R-7): a filing still in
 * effect is "Filed by buildd" with its undo; an open suggestion on a spec
 * with no parent is the inline suggestion, with its id so accept and dismiss
 * are recorded. Pure.
 */
export function filingFacts(spec: { parentSpecId: string | null }, f: IndexFiling | null | undefined): Pick<SpecIndexInput, 'filedBy' | 'filingId' | 'suggestion'> {
  if (!f) return {};
  if (f.kind === 'filed' && f.status === 'applied' && f.parent && f.parent.specId === spec.parentSpecId) return { filedBy: 'buildd', filingId: f.id };
  if (f.kind !== 'suggested' || f.status !== 'open' || spec.parentSpecId) return {};
  const reason = f.source === 'similarity' ? 'Closest area by what it asks for' : f.p != null ? `buildd's area check, ${Math.round(f.p * 100)}% sure` : "buildd's area check";
  if (f.parent) return { suggestion: { kind: 'parent', specId: f.parent.specId, title: f.parent.title, reason, filingId: f.id } };
  if (f.newArea) return { suggestion: { kind: 'new_area', title: f.newArea.title, reason: f.newArea.charter || null, filingId: f.id } };
  return {};
}

/** A cold-start taxonomy proposal (§17 R-4) as possible areas, each accepted by its key. Pure. */
export function proposalAreas(proposal: { areas: ReadonlyArray<{ key: string; title: string; members: ReadonlyArray<{ specId: string }> }> } | null | undefined, source?: 'model' | 'words'): AreaProposal[] {
  return (proposal?.areas ?? []).map((a) => ({ key: a.key, title: a.title, specIds: a.members.map((m) => m.specId), ...(source ? { source } : {}) }));
}

/** One area's imported specs waiting for a person's confirmation (§18, R-19). */
export interface ImportedGroup {
  /** The area spec's id; null for imported specs not filed under one. */
  areaId: string | null;
  title: string;
  specs: Array<{ id: string; title: string }>;
}

/**
 * The imported, unconfirmed specs grouped by the area above them (their
 * nearest `domain` ancestor), areas in title order and Unfiled last, so a
 * person confirms one area's batch in one act. Retired and superseded specs
 * are left out. Pure.
 */
export function importedByArea(input: readonly SpecIndexInput[]): ImportedGroup[] {
  const byId = new Map(input.map((r) => [r.id, r]));
  const areaOf = (r: SpecIndexInput): SpecIndexInput | null => {
    const seen = new Set<string>();
    let p = r.parentSpecId ? byId.get(r.parentSpecId) : undefined;
    while (p && !seen.has(p.id)) {
      if (p.scope === 'domain') return p;
      seen.add(p.id);
      p = p.parentSpecId ? byId.get(p.parentSpecId) : undefined;
    }
    return null;
  };
  const groups = new Map<string, ImportedGroup>();
  for (const r of input) {
    if (!r.imported || isClosed(r.status) || isArea(r.scope)) continue;
    const a = areaOf(r);
    const key = a?.id ?? '';
    const g = groups.get(key) ?? { areaId: a?.id ?? null, title: a?.title ?? 'Unfiled', specs: [] };
    g.specs.push({ id: r.id, title: r.title });
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, specs: [...g.specs].sort((x, y) => x.title.localeCompare(y.title)) }))
    .sort((x, y) => (x.areaId === null ? 1 : 0) - (y.areaId === null ? 1 : 0) || x.title.localeCompare(y.title));
}
