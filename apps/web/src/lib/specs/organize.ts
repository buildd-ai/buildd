import { randomUUID } from 'node:crypto';
import { db } from '@buildd/core/db';
import { specFilings, specs, workspaces } from '@buildd/core/db/schema';
import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { AREA_GONE_STATUSES, domainHintOf, headBodies, listAreas, proposeTaxonomy, type AreaClassification, type AreaClassifier, type AreaInfo, type TaxonomyProposal } from './areas';
import { specCard } from './card';
import { currentFiling, filingViews, insertFiling, setParentIfUnfiled, specsWithFilings, type FilingView } from './filings';
import { suggestParent } from './neighbours';
import { author, createSpecDraft, fail, reach, relateSpec, type SpecCaller, type SpecError } from './store';

/**
 * Organization (Living Specs §17): buildd places each spec of a workspace in
 * its product > area > feature tree itself, and a person reviews only what it
 * could not place or wants to change.
 *
 * - One spec, after its create response (R-7, R-9): the classifier (a decision,
 *   behind the `SPEC_AREA_CLASSIFY` slot) answers an area, `new_area` or
 *   `unsure`. A confident area answer from a measured model is applied: the
 *   parent is set and a `filed` row records it, with undo. Anything else is a
 *   `suggested` row. No areas, no key, an unmeasured model or an error: the
 *   similarity suggestion (§14) instead. Never fails the draft.
 * - A workspace with no product and no area (R-4): one proposed taxonomy, from
 *   every spec's card, `domain:` frontmatter as hints only. Nothing is created
 *   until a person accepts it; accepting creates the product and the areas
 *   (each through the duplicate check, like any spec) and files their members.
 * - A sweep (R-10): every unfiled spec with no filing row at all, bounded,
 *   one batch grouped by area, by the same rule. Idempotent: a second run with
 *   nothing changed finds nothing, and a spec a person moved is never touched.
 */

export const SWEEP_LIMIT = 50;
/** Specs whose placement is theirs to organize: not the tree's own nodes. */
const FILEABLE_SCOPES = ['feature', 'mission'] as const;

/** Overridable for tests: the classifier and the fallback suggestion. */
export const organizeDeps: { classify?: AreaClassifier; suggest?: typeof suggestParent } = {};

async function classifier(): Promise<AreaClassifier> {
  return organizeDeps.classify ?? (await import('@/modules')).SPEC_AREA_CLASSIFY;
}

export type FilingOutcome =
  | { outcome: 'filed'; areaId: string; p: number; filingId: string | null }
  | { outcome: 'suggested'; parentSpecId: string | null; answer: string; p: number | null; source: 'model' | 'similarity'; filingId: string | null; newArea?: { title: string; charter: string } }
  | { outcome: 'none'; reason: string }
  | { outcome: 'skipped'; reason: string };

type SpecRow = typeof specs.$inferSelect;

interface PlaceOpts {
  by: string;
  userId?: string | null;
  accountId?: string | null;
  batchId?: string | null;
  /** Compute what would happen and write nothing. */
  dryRun?: boolean;
  areas?: AreaInfo[];
  body?: string;
}

/** Place one spec by the R-7 rule. Never throws. */
async function place(spec: SpecRow, opts: PlaceOpts): Promise<FilingOutcome & { classifier?: string }> {
  try {
    const areas = (opts.areas ?? (await listAreas(spec.workspaceId))).filter((a) => a.id !== spec.id && a.workspaceId === spec.workspaceId);
    const body = opts.body ?? (await headBodies([spec])).get(spec.id) ?? '';
    const card = specCard(spec.title, body);
    let c: AreaClassification = { ran: false, reason: 'the workspace has no areas' };
    if (areas.length) {
      c = await (await classifier())({ workspaceId: spec.workspaceId, specId: spec.id, card, areas, userId: opts.userId ?? null, accountId: opts.accountId ?? null });
    }
    // The classifier may only name an area it was shown, in this workspace (R-6, R-8).
    if (c.ran) {
      const named = c.areaId;
      if (c.answer === 'area' && !areas.some((a) => a.id === named)) c = { ...c, answer: 'unsure', areaId: null, confident: false };
    }
    const proposal = c.ran ? { answer: c.answer, p: c.p, model: c.model, shown: c.shown, omitted: c.omitted } : null;

    if (c.ran && c.answer === 'area' && c.confident && c.areaId) {
      if (opts.dryRun) return { outcome: 'filed', areaId: c.areaId, p: c.p, filingId: null };
      if (await setParentIfUnfiled(spec.workspaceId, spec.id, c.areaId)) {
        const f = await insertFiling({
          workspaceId: spec.workspaceId, specId: spec.id, kind: 'filed', status: 'applied', source: 'model',
          previousParentId: null, parentSpecId: c.areaId, proposal, decisionRecordId: c.decisionRecordId, batchId: opts.batchId ?? null, createdBy: 'buildd',
        });
        return { outcome: 'filed', areaId: c.areaId, p: c.p, filingId: f.id };
      }
      return { outcome: 'skipped', reason: 'the spec was placed meanwhile' };
    }

    if (c.ran) {
      const newArea = c.answer === 'new_area' ? { title: card.title, charter: card.summary } : undefined;
      const parentSpecId = c.answer === 'area' ? c.areaId : null;
      const f = opts.dryRun ? null : await insertFiling({
        workspaceId: spec.workspaceId, specId: spec.id, kind: 'suggested', status: 'open', source: 'model',
        parentSpecId, proposal: { ...proposal, ...(newArea ?? {}) }, decisionRecordId: c.decisionRecordId, batchId: opts.batchId ?? null, createdBy: 'buildd',
      });
      return { outcome: 'suggested', parentSpecId, answer: c.answer, p: c.p, source: 'model', filingId: f?.id ?? null, ...(newArea ? { newArea } : {}) };
    }

    // R-9: the model is unavailable, unmeasured or errored: today's similarity suggestion.
    const s = await (organizeDeps.suggest ?? suggestParent)(spec.workspaceId, spec.id, `${spec.title}\n\n${body}`).catch(() => null);
    if (!s) return { outcome: 'none', reason: c.reason, classifier: c.reason };
    const f = opts.dryRun ? null : await insertFiling({
      workspaceId: spec.workspaceId, specId: spec.id, kind: 'suggested', status: 'open', source: 'similarity',
      parentSpecId: s.specId, proposal: { answer: 'similarity', reason: s.reason }, decisionRecordId: c.decisionRecordId ?? null, batchId: opts.batchId ?? null, createdBy: 'buildd',
    });
    return { outcome: 'suggested', parentSpecId: s.specId, answer: 'similarity', p: null, source: 'similarity', filingId: f?.id ?? null, classifier: c.reason };
  } catch (err) {
    console.warn('[living-specs] organize failed for a spec (it is unaffected):', (err as Error)?.message ?? err);
    return { outcome: 'none', reason: 'organize failed' };
  }
}

const isFileable = (s: SpecRow) => (FILEABLE_SCOPES as readonly string[]).includes(s.scope) && !(AREA_GONE_STATUSES as readonly string[]).includes(s.status);

/**
 * File a spec just created with no parent (R-7, R-9). Runs after the create
 * response; never throws and never changes the draft's body or version.
 */
export async function organizeNewSpec(specId: string, opts: { by: string; userId?: string | null; accountId?: string | null; body?: string }): Promise<FilingOutcome> {
  try {
    const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
    if (!spec) return { outcome: 'skipped', reason: 'not found' };
    if (spec.parentSpecId) return { outcome: 'skipped', reason: 'it has a parent' };
    if (!isFileable(spec)) return { outcome: 'skipped', reason: `a ${spec.scope} spec is not filed` };
    if ((await specsWithFilings([spec.id])).size) return { outcome: 'skipped', reason: 'already placed or reviewed' };
    return await place(spec, opts);
  } catch (err) {
    console.warn('[living-specs] organize after create failed (the draft stands):', (err as Error)?.message ?? err);
    return { outcome: 'none', reason: 'organize failed' };
  }
}

// ── Undo, accept, dismiss ───────────────────────────────────────────────────

/** The filing or suggestion a spec page shows, if the caller can read the spec. */
export async function readFiling(caller: SpecCaller, specId: string): Promise<{ ok: true; filing: FilingView | null } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select({ workspaceId: specs.workspaceId }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  return { ok: true, filing: await currentFiling(specId) };
}

/**
 * Act on a spec's current placement: `undo` a filing buildd made (the
 * previous parent comes back, the version does not move, and the ledger row
 * records the person's disagreement), `accept` a suggestion of an existing
 * area (a placement by hand), or `dismiss` it.
 */
export async function actOnFiling(caller: SpecCaller, specId: string, input: { action: unknown; filingId: unknown }): Promise<{ ok: true; filing: FilingView | null } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (typeof input.filingId !== 'string' || !isUuid(input.filingId)) return fail(400, 'filingId must be the id of the filing or suggestion you saw');
  if (input.action !== 'undo' && input.action !== 'accept' && input.action !== 'dismiss') return fail(400, 'action must be undo, accept or dismiss');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  const [f] = await db.select().from(specFilings).where(and(eq(specFilings.id, input.filingId), eq(specFilings.specId, specId))).limit(1);
  if (!f) return fail(404, 'No such filing on this spec');
  const by = author(caller).label;
  const now = new Date();

  if (input.action === 'undo') {
    if (f.kind !== 'filed' || f.status !== 'applied') return fail(409, 'Only a filing buildd made, still in effect, can be undone');
    if (spec.parentSpecId !== f.parentSpecId) return fail(409, 'The spec has moved since buildd filed it; nothing to undo');
    const rows = await db.update(specs).set({ parentSpecId: f.previousParentId, updatedAt: now })
      .where(and(eq(specs.id, specId), f.parentSpecId ? eq(specs.parentSpecId, f.parentSpecId) : isNull(specs.parentSpecId))).returning({ id: specs.id });
    if (rows.length === 0) return fail(409, 'The spec moved while undoing; re-read it');
    await db.update(specFilings).set({ status: 'undone', resolvedAt: now, resolvedBy: by }).where(eq(specFilings.id, f.id));
    if (f.decisionRecordId) {
      const { SPEC_AREA_OVERRIDE } = await import('@/modules');
      await SPEC_AREA_OVERRIDE(f.decisionRecordId, { parentSpecId: f.previousParentId, previousParentId: f.parentSpecId }, by);
    }
    return { ok: true, filing: null };
  }

  if (f.kind !== 'suggested' || f.status !== 'open') return fail(409, 'That suggestion is no longer open');
  if (input.action === 'dismiss') {
    await db.update(specFilings).set({ status: 'dismissed', resolvedAt: now, resolvedBy: by }).where(eq(specFilings.id, f.id));
    return { ok: true, filing: null };
  }
  if (!f.parentSpecId) return fail(409, 'This suggestion proposes a new area: create the area, then move the spec under it');
  const r = await relateSpec(caller, specId, { parentSpecId: f.parentSpecId });
  if (!r.ok) return r;
  return { ok: true, filing: null };
}

// ── The workspace run: taxonomy or sweep ────────────────────────────────────

export interface SweepRow { specId: string; title: string; outcome: FilingOutcome['outcome']; p: number | null; filingId: string | null; answer?: string; newArea?: { title: string; charter: string } }
export interface SweepGroup { area: { specId: string; title: string } | null; label: string; filed: SweepRow[]; suggested: SweepRow[] }

export type OrganizeResult =
  | { mode: 'taxonomy'; dryRun: true; proposal: TaxonomyProposal; specs: number }
  | { mode: 'taxonomy'; dryRun: false; batchId: string; product: { specId: string; title: string } | null; created: Array<{ key: string; specId: string; title: string; filed: number }>; refused: Array<{ key: string; title: string; reason: string }> }
  | { mode: 'sweep'; dryRun: boolean; batchId: string | null; scanned: number; remaining: number; skipped: number; groups: SweepGroup[]; classifier: string | null };

export interface OrganizeInput {
  workspaceId: unknown;
  dryRun?: unknown;
  limit?: unknown;
  /** Taxonomy accept: the proposed areas to create, by key. Omitted: all of them. */
  areas?: unknown;
  /** Taxonomy accept: a person's edits, by key: `{ title?, charter? }`. */
  edits?: unknown;
}

async function unfiledSpecs(workspaceId: string): Promise<SpecRow[]> {
  return db.select().from(specs)
    .where(and(eq(specs.workspaceId, workspaceId), isNull(specs.parentSpecId), inArray(specs.scope, [...FILEABLE_SCOPES]), notInArray(specs.status, [...AREA_GONE_STATUSES])))
    .orderBy(asc(specs.createdAt));
}

/**
 * Organize a workspace (R-4, R-10): with no product or area, propose a
 * taxonomy (dry run) or create the accepted one; otherwise sweep the unfiled
 * specs into one batch. `dryRun` defaults to true: nothing is written to the
 * tree, and the batch says what would happen. Needs write access to the
 * workspace's specs either way: it asks the decision model.
 */
export async function organizeWorkspace(caller: SpecCaller, input: OrganizeInput): Promise<{ ok: true; result: OrganizeResult } | SpecError> {
  const { workspaceId } = input;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) return fail(400, 'workspaceId must be a UUID');
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') return fail(400, 'dryRun must be true or false');
  const dryRun = input.dryRun !== false;
  const limit = input.limit === undefined ? SWEEP_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(400, 'limit must be an integer from 1 to 200');
  if (!(await reach(caller, workspaceId, true))) return fail(404, 'Workspace not found');
  const who = author(caller);
  const ids = caller.kind === 'user' ? { userId: caller.userId, accountId: null } : { userId: null, accountId: caller.account.id };

  const areas = await listAreas(workspaceId);
  if (areas.length === 0) return taxonomy(caller, workspaceId, dryRun, input, who.label);

  const all = await unfiledSpecs(workspaceId);
  const placed = await specsWithFilings(all.map((s) => s.id));
  const todo = all.filter((s) => !placed.has(s.id));
  const batch = todo.slice(0, limit);
  const batchId = dryRun ? null : randomUUID();
  const bodies = await headBodies(batch);
  const groups = new Map<string, SweepGroup>();
  const areaTitle = new Map(areas.map((a) => [a.id, a.title]));
  let classifierNote: string | null = null;
  for (const spec of batch) {
    const r = await place(spec, { by: 'buildd', ...ids, batchId, dryRun, areas, body: bodies.get(spec.id) ?? '' });
    if ('classifier' in r && r.classifier) classifierNote ??= r.classifier;
    if (r.outcome === 'none' || r.outcome === 'skipped') continue;
    const areaId = r.outcome === 'filed' ? r.areaId : r.parentSpecId;
    const label = areaId ? (areaTitle.get(areaId) ?? 'Elsewhere') : r.outcome === 'suggested' && r.answer === 'new_area' ? 'A new area' : 'Unsure';
    const key = areaId ?? label;
    const g = groups.get(key) ?? { area: areaId ? { specId: areaId, title: areaTitle.get(areaId) ?? '' } : null, label, filed: [], suggested: [] };
    const row: SweepRow = { specId: spec.id, title: spec.title, outcome: r.outcome, p: r.p, filingId: r.filingId, ...(r.outcome === 'suggested' ? { answer: r.answer, ...(r.newArea ? { newArea: r.newArea } : {}) } : {}) };
    (r.outcome === 'filed' ? g.filed : g.suggested).push(row);
    groups.set(key, g);
  }
  return {
    ok: true,
    result: {
      mode: 'sweep', dryRun, batchId, scanned: batch.length, remaining: todo.length - batch.length, skipped: placed.size,
      groups: [...groups.values()].sort((a, b) => (b.filed.length + b.suggested.length) - (a.filed.length + a.suggested.length)),
      classifier: classifierNote,
    },
  };
}

function readEdits(raw: unknown): Map<string, { title?: string; charter?: string }> {
  const out = new Map<string, { title?: string; charter?: string }>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    out.set(k, {
      ...(typeof e.title === 'string' && e.title.trim() ? { title: e.title.trim().slice(0, 200) } : {}),
      ...(typeof e.charter === 'string' && e.charter.trim() ? { charter: e.charter.trim().slice(0, 1000) } : {}),
    });
  }
  return out;
}

const areaBody = (title: string, charter: string) => `# ${title}\n\n${charter}\n`;

async function taxonomy(caller: SpecCaller, workspaceId: string, dryRun: boolean, input: OrganizeInput, by: string): Promise<{ ok: true; result: OrganizeResult } | SpecError> {
  const products = await db.select({ id: specs.id }).from(specs).where(and(eq(specs.workspaceId, workspaceId), eq(specs.scope, 'product'), notInArray(specs.status, [...AREA_GONE_STATUSES]))).limit(1);
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const all = await unfiledSpecs(workspaceId);
  const bodies = await headBodies(all);
  const proposal = proposeTaxonomy(all.map((s) => {
    const body = bodies.get(s.id) ?? '';
    return { specId: s.id, title: s.title, card: specCard(s.title, body.replace(/^---\n[\s\S]*?\n---\n?/, '')), domainHint: domainHintOf(body) };
  }), { title: ws?.name ?? 'Product' });
  if (dryRun) return { ok: true, result: { mode: 'taxonomy', dryRun: true, proposal, specs: all.length } };

  let keys: Set<string> | null = null;
  if (input.areas !== undefined) {
    if (!Array.isArray(input.areas) || !input.areas.every((k) => typeof k === 'string')) return fail(400, 'areas must be the keys of the proposed areas to create');
    keys = new Set(input.areas as string[]);
    const unknown = [...keys].filter((k) => !proposal.areas.some((a) => a.key === k));
    if (unknown.length) return fail(409, `The proposal has changed since you read it: no proposed area ${unknown.map((k) => `"${k}"`).join(', ')}. Run organize again with dryRun and review it.`);
  }
  const edits = readEdits(input.edits);
  const batchId = randomUUID();
  const created: Array<{ key: string; specId: string; title: string; filed: number }> = [];
  const refused: Array<{ key: string; title: string; reason: string }> = [];

  // At most one product (R-4): the existing one, else the proposal's.
  let productId: string | null = products[0]?.id ?? null;
  let productOut: { specId: string; title: string } | null = null;
  if (!productId) {
    const p = await createSpecDraft(caller, { workspaceId, title: proposal.product.title, scope: 'product', body: areaBody(proposal.product.title, proposal.product.charter), changeSummary: 'Proposed by buildd organize, accepted by a person' });
    if (!p.ok) refused.push({ key: '(product)', title: proposal.product.title, reason: p.error });
    else { productId = p.spec.id; productOut = { specId: p.spec.id, title: p.spec.title }; }
  }

  for (const a of proposal.areas) {
    if (keys && !keys.has(a.key)) continue;
    const e = edits.get(a.key) ?? {};
    const title = e.title ?? a.title;
    const charter = e.charter ?? a.charter;
    // An area is a spec like any other: it passes the duplicate check (R-2).
    const d = await createSpecDraft(caller, { workspaceId, title, scope: 'domain', parentSpecId: productId, body: areaBody(title, charter), changeSummary: 'Proposed by buildd organize, accepted by a person' });
    if (!d.ok) { refused.push({ key: a.key, title, reason: d.error }); continue; }
    let filed = 0;
    for (const m of a.members) {
      // A person accepted this area with these members: filed with undo, never over a placement made meanwhile.
      if (!(await setParentIfUnfiled(workspaceId, m.specId, d.spec.id))) continue;
      await insertFiling({
        workspaceId, specId: m.specId, kind: 'filed', status: 'applied', source: 'taxonomy',
        previousParentId: null, parentSpecId: d.spec.id, proposal: { answer: 'taxonomy', key: a.key }, batchId, createdBy: by,
      });
      filed++;
    }
    created.push({ key: a.key, specId: d.spec.id, title, filed });
  }
  return { ok: true, result: { mode: 'taxonomy', dryRun: false, batchId, product: productOut, created, refused } };
}

/** The filings of one organize run, for a reviewer. */
export async function batchFilings(caller: SpecCaller, workspaceId: string, batchId: string): Promise<{ ok: true; filings: FilingView[] } | SpecError> {
  if (!isUuid(workspaceId) || !isUuid(batchId) || !(await reach(caller, workspaceId, false))) return fail(404, 'Not found');
  const rows = await db.select().from(specFilings).where(and(eq(specFilings.workspaceId, workspaceId), eq(specFilings.batchId, batchId)));
  return { ok: true, filings: await filingViews(rows) };
}
