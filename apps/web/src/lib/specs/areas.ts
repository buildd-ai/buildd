import { db } from '@buildd/core/db';
import { specRevisions, specs } from '@buildd/core/db/schema';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { cardText, cardTokens, specCard, type SpecCard } from './card';

/**
 * Areas (Living Specs §17, R-2, R-4, R-30): the product and area specs that
 * structure a workspace's tree, as the classifier and the parent suggestion
 * read them, and the cold-start taxonomy proposed when a workspace has none.
 *
 * An area is a spec with scope `domain` (a product, scope `product`). It acts
 * as a parent from its first revision, approved or not: areas are structure,
 * not approved text, so every one counts except a retired or superseded one.
 *
 * Core: the classifier itself is a decision (lib/spec-area-decision.ts),
 * reached through the `SPEC_AREA_CLASSIFY` slot; these are the types it
 * answers in.
 */

export const AREA_SCOPES = ['product', 'domain'] as const;
/** The statuses an area stops counting at (R-30). */
export const AREA_GONE_STATUSES = ['retired', 'superseded'] as const;

export interface AreaInfo {
  id: string;
  workspaceId: string;
  title: string;
  scope: 'product' | 'domain';
  /** The opening line of the head revision: the area's one-paragraph charter. */
  charter: string;
  memberCount: number;
  /** Up to 5 member titles, newest first. */
  memberTitles: string[];
}

export interface AreaClassifyInput {
  workspaceId: string;
  specId: string;
  card: SpecCard;
  areas: readonly AreaInfo[];
  userId?: string | null;
  accountId?: string | null;
}

export type AreaClassification =
  | {
    ran: true;
    answer: 'area' | 'new_area' | 'unsure';
    /** The area answered, when `answer` is `area`. Always one of the areas in the state. */
    areaId: string | null;
    p: number;
    /** An area answer at or above the measured bar, from a measured model (R-7). */
    confident: boolean;
    model: string | null;
    decisionRecordId: string | null;
    shown: number;
    omitted: number;
  }
  | { ran: false; reason: string; decisionRecordId?: string | null };

export type AreaClassifier = (input: AreaClassifyInput) => Promise<AreaClassification>;

/** The head revision's body of each spec, by id. */
export async function headBodies(rows: ReadonlyArray<{ id: string; bodyArtifactId: string; headRevision: number }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rows.length === 0) return out;
  const revs = await db.select({ specId: specRevisions.specId, revision: specRevisions.revision, artifactRevision: specRevisions.artifactRevision })
    .from(specRevisions).where(inArray(specRevisions.specId, rows.map((r) => r.id)));
  const byKey = new Map(revs.map((r) => [`${r.specId}#${r.revision}`, r.artifactRevision]));
  for (const r of rows) {
    const ar = byKey.get(`${r.id}#${r.headRevision}`);
    if (ar === undefined) continue;
    const body = await getArtifactRevision(r.bodyArtifactId, ar);
    if (typeof body?.content === 'string') out.set(r.id, body.content);
  }
  return out;
}

/**
 * Every product and area in the workspace, whatever its approval state, with
 * its charter and members (R-30). Only this workspace (R-8).
 */
export async function listAreas(workspaceId: string): Promise<AreaInfo[]> {
  const rows = await db.select().from(specs)
    .where(and(eq(specs.workspaceId, workspaceId), inArray(specs.scope, [...AREA_SCOPES]), notInArray(specs.status, [...AREA_GONE_STATUSES])));
  if (rows.length === 0) return [];
  const bodies = await headBodies(rows);
  const members = await db.select({ id: specs.id, title: specs.title, parentSpecId: specs.parentSpecId, updatedAt: specs.updatedAt }).from(specs)
    .where(and(eq(specs.workspaceId, workspaceId), inArray(specs.parentSpecId, rows.map((r) => r.id))));
  return rows.map((r) => {
    const mine = members.filter((m) => m.parentSpecId === r.id).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return {
      id: r.id, workspaceId: r.workspaceId, title: r.title, scope: r.scope as 'product' | 'domain',
      charter: specCard(r.title, bodies.get(r.id) ?? '').summary,
      memberCount: mine.length, memberTitles: mine.slice(0, 5).map((m) => m.title),
    };
  });
}

// ── Cold start: a proposed taxonomy (R-4) ───────────────────────────────────

/**
 * `domain:` values that name a kind of code or a catch-all rather than a part
 * of the product. Never an area on their own: their specs are re-clustered.
 */
export const CROSS_CUTTING_DOMAINS = new Set(['surfaces', 'surface', 'ui', 'api', 'frontend', 'backend', 'misc', 'general', 'other', 'shared', 'common', 'core']);
/** No proposed area may hold more than this share of all specs (R-4, "about a quarter"). */
export const MAX_AREA_SHARE = 0.25;

export interface TaxonomyItem { specId: string; title: string; card: SpecCard; domainHint?: string | null }
export interface ProposedArea { key: string; title: string; charter: string; members: Array<{ specId: string; title: string }>; hint: string | null }
export interface TaxonomyProposal { product: { title: string; charter: string }; areas: ProposedArea[] }

/** The `domain:` value in a spec body's frontmatter, if it opens with one. Pure. */
export function domainHintOf(body: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(body);
  if (!m) return null;
  const d = /^domain:\s*(.+)$/m.exec(m[1]!);
  const v = d?.[1]?.split('#')[0]?.trim().replace(/^["']|["']$/g, '').toLowerCase();
  return v ? v : null;
}

type Vec = Map<string, number>;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'then', 'given', 'must', 'are', 'its', 'not', 'one', 'each', 'every', 'only', 'never', 'spec', 'specs', 'into', 'has', 'have', 'was', 'were', 'any', 'all', 'can', 'may', 'own', 'out', 'but', 'than', 'they', 'what', 'who', 'which', 'their', 'there', 'them', 'more', 'does', 'say', 'says', 'set', 'run', 'new']);

function vectors(cards: readonly SpecCard[]): { vecs: Vec[]; idf: Map<string, number> } {
  // Code in backticks names identifiers, not parts of the product: left out of the words areas are named by.
  const docs = cards.map((c) => cardTokens(cardText(c).replace(/`[^`]*`/g, ' ')).filter((t) => !STOP.has(t) && !/^\d+$/.test(t)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = new Map([...df].map(([t, f]) => [t, Math.log((1 + n) / (1 + f)) + 1]));
  const vecs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vec = new Map();
    for (const [t, f] of tf) v.set(t, (1 + Math.log(f)) * idf.get(t)!);
    return normalize(v);
  });
  return { vecs, idf };
}
function normalize(v: Vec): Vec {
  const n = Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
  return new Map([...v].map(([t, x]) => [t, x / n]));
}
const cos = (a: Vec, b: Vec) => { let s = 0; for (const [t, x] of a) s += x * (b.get(t) ?? 0); return s; };
function centroid(vs: readonly Vec[]): Vec {
  const c: Vec = new Map();
  for (const v of vs) for (const [t, x] of v) c.set(t, (c.get(t) ?? 0) + x);
  return normalize(c);
}

/** Deterministic k-means over unit vectors: farthest-first seeds, a fixed number of rounds. Returns the cluster of each index. */
function cluster(vs: readonly Vec[], k: number): number[] {
  if (vs.length <= k) return vs.map((_, i) => i);
  const seeds = [0];
  while (seeds.length < k) {
    let best = -1; let bestD = Infinity;
    vs.forEach((v, i) => {
      if (seeds.includes(i)) return;
      const near = Math.max(...seeds.map((s) => cos(v, vs[s]!)));
      if (near < bestD) { bestD = near; best = i; }
    });
    seeds.push(best);
  }
  let cents = seeds.map((s) => vs[s]!);
  let assign = vs.map(() => 0);
  for (let round = 0; round < 12; round++) {
    assign = vs.map((v) => { let b = 0; let bs = -Infinity; cents.forEach((c, j) => { const s = cos(v, c); if (s > bs) { bs = s; b = j; } }); return b; });
    // An empty cluster keeps its seed, so k stays k.
    cents = cents.map((c, j) => { const m = vs.filter((_, i) => assign[i] === j); return m.length ? centroid(m) : c; });
  }
  return assign;
}

const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'area';

/** The terms that set a group apart from the rest. */
function distinctiveTerms(group: readonly Vec[], all: readonly Vec[], n: number, exclude: ReadonlySet<string>): string[] {
  const g = centroid(group);
  const a = centroid(all);
  return [...g].map(([t, x]) => [t, x - 0.5 * (a.get(t) ?? 0)] as const)
    .filter(([t]) => !exclude.has(t) && t.length > 3)
    .sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))
    .slice(0, n).map(([t]) => t);
}

/**
 * Propose a product and its areas from every spec's card (R-4). Pure and
 * deterministic: the same specs give the same proposal, so an accept matches
 * the dry run a person reviewed.
 *
 * `domain:` hints seed the groups. A cross-cutting value is not an area: its
 * specs are clustered among themselves into at least two. A group holding more
 * than about a quarter of all specs is split, again by clustering. Specs with
 * no hint join the nearest group, or form their own clusters when nothing is
 * near. Titles and charters are drawn from the members' words, for a person to
 * edit.
 */
export function proposeTaxonomy(items: readonly TaxonomyItem[], product: { title: string }): TaxonomyProposal {
  const out: TaxonomyProposal = { product: { title: product.title, charter: `Everything ${product.title} does, area by area.` }, areas: [] };
  if (items.length === 0) return out;
  const { vecs } = vectors(items.map((i) => i.card));
  // "About a quarter": a group at the quarter mark is split too, so an overloaded value never just squeaks under it.
  const cap = Math.max(3, Math.floor(items.length * MAX_AREA_SHARE) - 1);

  // 1. Seed groups by hint; cross-cutting and missing hints wait.
  const groups = new Map<string, number[]>();
  const loose: number[] = [];
  const crossCut = new Map<string, number[]>();
  items.forEach((it, i) => {
    const h = it.domainHint?.trim().toLowerCase();
    if (!h) loose.push(i);
    else if (CROSS_CUTTING_DOMAINS.has(h)) crossCut.set(h, [...(crossCut.get(h) ?? []), i]);
    else groups.set(h, [...(groups.get(h) ?? []), i]);
  });

  // 2. Unhinted specs join the nearest hinted group when one is clearly near.
  const seeded = [...groups.entries()].map(([h, idx]) => ({ h, c: centroid(idx.map((i) => vecs[i]!)) }));
  const stillLoose: number[] = [];
  for (const i of loose) {
    let best: string | null = null; let bs = 0;
    for (const s of seeded) { const x = cos(vecs[i]!, s.c); if (x > bs) { bs = x; best = s.h; } }
    if (best && bs >= 0.2) groups.get(best)!.push(i); else stillLoose.push(i);
  }

  // 3. Raw groups: hinted, each cross-cutting value (always split), the rest of the loose.
  const raw: Array<{ hint: string | null; idx: number[]; mustSplit: boolean }> = [...groups.entries()].map(([hint, idx]) => ({ hint, idx, mustSplit: false }));
  for (const [, idx] of crossCut) raw.push({ hint: null, idx, mustSplit: idx.length >= 2 });
  if (stillLoose.length) raw.push({ hint: null, idx: stillLoose, mustSplit: stillLoose.length > cap || groups.size === 0 });

  // 4. Split what is cross-cutting or too big, until every group fits.
  const final: Array<{ hint: string | null; idx: number[]; parentHint: string | null }> = [];
  const queue = raw.map((r) => ({ ...r, parentHint: r.hint }));
  while (queue.length) {
    const g = queue.shift()!;
    const tooBig = g.idx.length > cap;
    if (!(g.mustSplit || tooBig) || g.idx.length < 2) { final.push({ hint: g.hint, idx: g.idx, parentHint: g.parentHint }); continue; }
    const k = Math.max(2, Math.ceil(g.idx.length / cap));
    const assign = cluster(g.idx.map((i) => vecs[i]!), k);
    const parts = Array.from({ length: k }, (_, j) => g.idx.filter((_, n) => assign[n] === j)).filter((p) => p.length);
    if (parts.length < 2) { // could not separate: split in halves by order, so the rule still holds
      const half = Math.ceil(g.idx.length / 2);
      parts.splice(0, parts.length, g.idx.slice(0, half), g.idx.slice(half));
    }
    for (const p of parts) queue.push({ hint: null, idx: p, mustSplit: false, parentHint: g.parentHint });
  }

  // 5. Name them.
  const used = new Set<string>();
  for (const g of final.sort((a, b) => b.idx.length - a.idx.length || a.idx[0]! - b.idx[0]!)) {
    const terms = distinctiveTerms(g.idx.map((i) => vecs[i]!), vecs, 2, new Set(g.parentHint ? [g.parentHint] : []));
    const base = g.hint ? titleCase(g.hint) : g.parentHint ? `${titleCase(g.parentHint)}: ${terms.map(titleCase).join(' and ') || 'Other'}` : (terms.map(titleCase).join(' and ') || 'Other');
    let title = base; let n = 2;
    while (used.has(slug(title))) title = `${base} ${n++}`;
    used.add(slug(title));
    const members = g.idx.map((i) => ({ specId: items[i]!.specId, title: items[i]!.title }));
    const about = distinctiveTerms(g.idx.map((i) => vecs[i]!), vecs, 4, new Set());
    const charter = `Specs about ${about.join(', ') || title.toLowerCase()}, such as ${members.slice(0, 3).map((m) => `"${m.title}"`).join(', ')}.`;
    out.areas.push({ key: slug(title), title, charter, members, hint: g.hint ?? g.parentHint });
  }
  return out;
}
