/**
 * The spec index (living-specs.md §19): a workspace's specs as a cluster map
 * above an outline grouped by product and area. Pure: no DB, so the page,
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
  | { kind: 'parent'; specId: string; title: string; reason: string }
  /** A new area buildd would make (§17 R-6 `new_area`). */
  | { kind: 'new_area'; title: string; reason?: string | null };

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
  suggestion?: SpecSuggestion | null;
}

/** An area of a taxonomy proposal no person has acted on (§17 R-4). */
export interface AreaProposal {
  title: string;
  specIds: string[];
  /** Where a person accepts it; absent until the proposal flow exists. */
  acceptHref?: string | null;
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
  title: string;
  specIds: string[];
  acceptHref: string | null;
}

export interface MapSegment { state: SpecMixState; count: number; pct: number }
export interface MapBlock {
  areaId: string;
  title: string;
  count: number;
  /** Share of all filed specs, the block's flex basis. */
  basisPct: number;
  segments: MapSegment[];
  /** "Runners · 9 specs, 7 approved, 1 failing". */
  label: string;
  words: string;
}

export type IndexMap =
  | { kind: 'map'; blocks: MapBlock[]; loose: IndexRow[]; possible: Array<PossibleArea & { rows: IndexRow[] }> }
  | { kind: 'line'; text: string; href: string | null };

export interface SpecIndexView {
  /** Specs counted (not products or areas, not retired or superseded). */
  total: number;
  products: IndexProduct[];
  areas: IndexArea[];
  /** Specs buildd could not place, in order. Empty means no Unfiled group. */
  unfiled: IndexRow[];
  possibleAreas: PossibleArea[];
  map: IndexMap;
  /** Every row by id, for filtering and lookups. */
  rowsById: Map<string, IndexRow>;
}

/** With two or more areas the map renders from about this many specs up (R-26). */
export const MAP_MIN_SPECS = 10;
/** Floor for a block: its label in two lines and a 44px tap target (R-23), and two fit side by side in 320px. */
export const MAP_BLOCK_MIN_WIDTH_PX = 136;
export const MAP_BLOCK_MIN_HEIGHT_PX = 88;

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
      filedBy: r.filedBy ?? null, suggestion: r.suggestion ?? null, children: [],
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
    possibleAreas.push({ key: `proposal:${p.title}`, title: p.title, specIds: members, acceptHref: p.acceptHref ?? null });
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
    possibleAreas.push({ key: `new_area:${k}`, title: g.title, specIds: g.ids, acceptHref: null });
  }

  const unfiledCounted = unfiled.filter((u) => u.state);
  const filed = areas.reduce((n, a) => n + a.count, 0);
  const total = filed + countDeep(unfiled);

  let map: IndexMap;
  const withSpecs = areas.filter((a) => a.count > 0);
  if (withSpecs.length >= 2 && total >= MAP_MIN_SPECS) {
    const blocks = withSpecs.map((a) => ({
      areaId: a.id, title: a.title, count: a.count,
      basisPct: Math.round((a.count / filed) * 1000) / 10,
      segments: MIX_STATES.filter((s) => a.mix[s]).map((s) => ({ state: s, count: a.mix[s], pct: (a.mix[s] / a.count) * 100 })),
      label: `${a.title} · ${a.words}`, words: a.words,
    }));
    map = {
      kind: 'map', blocks,
      loose: unfiledCounted.filter((u) => !claimed.has(u.id)),
      possible: possibleAreas.map((p) => ({ ...p, rows: p.specIds.map((id) => rowsById.get(id)!) })),
    };
  } else {
    map = { kind: 'line', ...collapsedLine(total, withSpecs, countDeep(unfiled), options.taxonomyHref ?? null) };
  }

  return { total, products, areas, unfiled, possibleAreas, map, rowsById };
}

function countDeep(rows: readonly IndexRow[]): number {
  let n = 0;
  for (const r of rows) { if (r.state) n++; n += countDeep(r.children); }
  return n;
}

/** R-26: one line of words when a picture would have one shape, or too few specs to cluster. */
function collapsedLine(total: number, areas: readonly IndexArea[], unfiled: number, taxonomyHref: string | null): { text: string; href: string | null } {
  const specs = plural(total, 'spec');
  if (total === 0) return { text: 'No specs yet', href: null };
  if (areas.length === 0) return { text: `${specs}, none filed yet`, href: taxonomyHref };
  const tail = unfiled ? `, ${unfiled} unfiled` : '';
  if (areas.length === 1) {
    return { text: unfiled ? `${specs}: ${areas[0].count} in ${areas[0].title}${tail}` : `${specs}, all in ${areas[0].title}`, href: null };
  }
  return { text: `${specs}: ${areas.map((a) => `${a.count} in ${a.title}`).join(', ')}${tail}`, href: null };
}

/** What the outline shows for a map selection (R-25). */
export type IndexFilter =
  | { kind: 'area'; id: string }
  | { kind: 'unfiled' }
  | { kind: 'possible'; key: string };

export const sameFilter = (a: IndexFilter | null, b: IndexFilter | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === 'area' ? a.id === (b as { id: string }).id : a.kind === 'possible' ? a.key === (b as { key: string }).key : true);

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
