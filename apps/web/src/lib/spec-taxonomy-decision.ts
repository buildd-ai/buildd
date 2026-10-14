import { db } from '@buildd/core/db';
import { decisionRecords, workspaces } from '@buildd/core/db/schema';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { canonicalJson, choice, shortHash } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionRequest, ModelVerdict } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import { CROSS_CUTTING_DOMAINS, type ProposeTaxonomyInput, type TaxonomyItem, type TaxonomyProposal, type TaxonomyProposer } from '@/lib/specs/areas';

/**
 * The cold-start taxonomy (Living Specs §17, R-4), the decisions-module half:
 * the decision kind `buildd.spec_taxonomy` and the proposal it drives. Core
 * (lib/specs/organize.ts) reaches it through the `SPEC_TAXONOMY_PROPOSE` slot
 * in modules.ts and falls back to the word clustering in lib/specs/areas.ts
 * when it does not run.
 *
 * A decision model classifies: it picks one label of a fixed set and says how
 * sure it is; it cannot write a name. So the names come from a candidate list
 * a person would recognise (the specs' own `domain:` values, nouns that recur
 * in their titles, and a short list of generic product-area names), and the
 * model does what words cannot: for each spec, with every spec of the
 * workspace in view, it picks the area the spec belongs under by what it is
 * about.
 *
 *  1. Every spec is asked against all the candidates.
 *  2. While more names hold specs than the target (about 1.5 × √n, from
 *     MIN_AREAS to MAX_AREAS), the smallest are dropped and their specs asked
 *     again against the names still standing. A dropped name whose specs
 *     mostly moved to one area is folded into its title ("Tasks" and
 *     "Missions" read "Tasks and missions").
 *  3. The specs that answered `unsure` are asked once more against the final
 *     names. A spec still unsure, or below UNPLACED_P, is left unplaced.
 *
 * Every spec ends in exactly one area or in `unplaced`. Nothing is created:
 * the proposal is what a person accepts, edits or rejects.
 *
 * The model's answers are not exactly repeatable, and a person accepts the
 * proposal they read. So an answer recorded in the decision ledger for the
 * same input (same specs, same names, same spec to place) in the last
 * REUSE_DAYS is reused instead of asking again: the accept, and the spec
 * index re-reading the proposal, see the dry run's answers and spend nothing.
 * `cachedOnly` (the index page) never asks: a missing answer means no model
 * proposal yet, and the caller shows the word-based one.
 *
 * Measured offline 2026-10-13 (knowledge base: buildd/reports/spec-taxonomy-
 * eval/). The question text, the state and the candidate rules are the ones
 * measured; changing any of them means re-running that eval.
 */

export const SPEC_TAXONOMY_KIND = 'buildd.spec_taxonomy' as const;
export const SPEC_TAXONOMY_CAPABILITY = 'spec_taxonomy' as const;

/** Numbered candidate names the state can hold (and the question can name). */
export const NAME_SLOTS = 40;
/** At most this many candidates come from title words, the most frequent first. */
const TITLE_NAMES = 10;
/** The workspace's spec list stops here (characters, about 6k tokens): the token budget. */
export const SPEC_LIST_CHARS = 18_000;
const SUMMARY_CHARS = 160;
const FOCUS_CHARS = 1_200;
/** The proposal asks at least one question per spec; past this many specs the rest are left unplaced. */
export const MAX_TAXONOMY_SPECS = 200;
export const MIN_AREAS = 4;
export const MAX_AREAS = 8;
/** A final answer below this leaves the spec unplaced rather than filed by a weak pick. */
export const UNPLACED_P = 0.3;
/** A dropped name is folded into a kept area's title when at least this share of its specs moved there. */
export const FOLD_SHARE = 0.6;
const CONCURRENCY = 6;
/** A recorded answer for the same input is reused for this long. */
export const REUSE_DAYS = 7;

/** How many areas to aim for: about 1.5 × √n, from MIN_AREAS to MAX_AREAS. */
export const targetAreas = (n: number) => Math.min(MAX_AREAS, Math.max(MIN_AREAS, Math.round(1.5 * Math.sqrt(n))));

/**
 * Generic names for parts of a software product, in a person's words. Only
 * candidates: a name is proposed only when the model files specs under it.
 */
export const GENERIC_AREA_NAMES = [
  'Accounts and access', 'Teams and permissions', 'Settings', 'Billing and cost', 'Notifications',
  'Integrations', 'Search', 'Onboarding', 'Platform and operations', 'Releases and deployment',
  'Data and storage', 'Reporting and analytics', 'Security', 'Quality and testing', 'Documentation',
  'Knowledge', 'Automation', 'Messaging', 'Dashboard', 'Administration', 'Developer tools',
  'Models and AI', 'Agents', 'Scheduling', 'Workflow', 'Projects', 'Product copy', 'Monitoring',
] as const;

/** Title words that describe a document, a screen or a property rather than a part of the product. */
const TITLE_NOISE = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'one', 'its', 'are', 'not', 'per', 'via', 'what', 'when', 'how', 'past', 'single',
  'page', 'pages', 'overview', 'view', 'views', 'selection', 'copy', 'surface', 'surfaces', 'flow', 'flows', 'lifecycle', 'spec', 'specs', 'test', 'probe', 'duplicate', 'new', 'old',
  'redirect', 'display', 'state', 'states', 'mode', 'modes', 'contract', 'contracts', 'rule', 'rules', 'policy', 'basic', 'simple', 'professional', 'liveness', 'quality', 'shape',
  'ordering', 'orderings', 'scoping', 'resolution', 'composition', 'classification', 'enforcement', 'remediation', 'operation', 'operations', 'class', 'gate', 'guard', 'library', 'host',
]);

export interface TaxonomySpecEntry { title: string; summary: string; domain: string | null }
export interface SpecTaxonomyFeatures {
  /** Every spec of the workspace (title, a short summary, its `domain:`), within SPEC_LIST_CHARS. */
  specs: TaxonomySpecEntry[];
  omitted: number;
  /** The spec being placed: title, summary, `domain:` and criteria as its card holds them. */
  focus: { title: string; summary: string; domain: string | null; criteria: string[] };
  /** The candidate area names, numbered from 1 in the state. */
  names: string[];
}

export const NAME_SLOT_LABELS = Array.from({ length: NAME_SLOTS }, (_, i) => `name_${i + 1}` as const);
export type NameSlot = (typeof NAME_SLOT_LABELS)[number];
export const SPEC_TAXONOMY_DECISIONS = [...NAME_SLOT_LABELS, 'unsure'] as const;
export type SpecTaxonomyDecision = (typeof SPEC_TAXONOMY_DECISIONS)[number];

// ── Candidate names ─────────────────────────────────────────────────────────

const singular = (w: string) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y`
  : w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) && w !== 'settings' ? w.slice(0, -1) : w);
const plural = (w: string) => (w === 'settings' || /s$|a$|ing$|ness$/.test(w) ? w : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /(sh|ch|x)$/.test(w) ? `${w}es` : `${w}s`);
/** "mcp" reads "MCP"; anything else, sentence case. */
const display = (s: string) => s.split(' ').map((w, i) => (w.length <= 3 && i === 0 && !/^(and|the)$/.test(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
const nameWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== 'and').map(singular);

/**
 * The candidate names, in order: the `domain:` values (not cross-cutting
 * ones), then up to TITLE_NAMES nouns that recur in two or more titles (as
 * plurals), then the generic names, each once, at most NAME_SLOTS. A generic
 * name is skipped when a word of it is already a candidate ("Models and AI"
 * after "Models"). Pure.
 */
export function candidateAreaNames(items: ReadonlyArray<{ title: string; domain: string | null }>): string[] {
  return candidateAreas(items).map((c) => c.name);
}

export type CandidateSource = 'domain' | 'title' | 'generic';

/** The candidate names with where each came from. Pure. */
export function candidateAreas(items: ReadonlyArray<{ title: string; domain: string | null }>): Array<{ name: string; source: CandidateSource }> {
  const out: Array<{ name: string; source: CandidateSource }> = [];
  const words = new Set<string>();
  const keys = new Set<string>();
  const add = (n: string, source: CandidateSource) => {
    const ws = nameWords(n);
    const key = ws.join(' ');
    if (!key || keys.has(key) || out.length >= NAME_SLOTS) return false;
    if (source === 'generic' && ws.some((w) => words.has(w))) return false;
    keys.add(key);
    for (const w of ws) words.add(w);
    out.push({ name: n, source });
    return true;
  };
  const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); };
  const domains = items.map((i) => i.domain?.trim().toLowerCase()).filter((d): d is string => !!d && !CROSS_CUTTING_DOMAINS.has(d));
  for (const [d] of count(domains)) add(display(d.replace(/[-_]+/g, ' ')), 'domain');
  const titleWords = items.flatMap((i) => [...new Set(i.title.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !TITLE_NOISE.has(w)).map(singular))]);
  let fromTitles = 0;
  for (const [w, n] of count(titleWords)) {
    if (n < 2 || fromTitles >= TITLE_NAMES) break;
    if (add(display(plural(w)), 'title')) fromTitles++;
  }
  for (const g of GENERIC_AREA_NAMES) add(g, 'generic');
  return out;
}

// ── The state ───────────────────────────────────────────────────────────────

const entryLine = (s: TaxonomySpecEntry) => `- ${s.title}${s.summary ? `: ${s.summary.slice(0, SUMMARY_CHARS)}` : ''}${s.domain ? ` (domain: ${s.domain})` : ''}\n`;

/** The workspace's specs within the budget, and how many it left out. Pure. */
export function specListForState(items: readonly TaxonomySpecEntry[]): { specs: TaxonomySpecEntry[]; omitted: number } {
  const specs: TaxonomySpecEntry[] = [];
  let used = 0;
  for (const s of items) {
    const len = entryLine(s).length;
    if (used + len > SPEC_LIST_CHARS) continue;
    used += len;
    specs.push(s);
  }
  return { specs, omitted: items.length - specs.length };
}

/** The model's view: every spec, the one to place, then the numbered names. */
export function taxonomyState(f: SpecTaxonomyFeatures): string {
  const list = `Specs in this workspace (${f.specs.length} shown${f.omitted ? `, ${f.omitted} more not shown` : ''}):\n${f.specs.map(entryLine).join('')}`;
  let focus = `Spec to place: ${f.focus.title}\n${f.focus.summary}\n`;
  if (f.focus.domain) focus += `The repo file names its domain: ${f.focus.domain} (a hint only).\n`;
  for (const c of f.focus.criteria) {
    const line = `- ${c}\n`;
    if (focus.length + line.length > FOCUS_CHARS) break;
    focus += line;
  }
  const names = `Area names (${f.names.length}):\n${f.names.map((n, i) => `[${i + 1}] ${n}\n`).join('')}`;
  return `${list}\n${focus}\n${names}`;
}

// ── The decision kind ───────────────────────────────────────────────────────

const slotCriteria = Object.fromEntries(NAME_SLOT_LABELS.map((l, i) => [l, `The spec belongs in the area named [${i + 1}] in the list.`])) as Record<NameSlot, string>;

const questions = {
  area: choice(
    'A person is sorting this product\'s specs into a handful of areas, four to eight, each named in a few plain words for a part of the product, the way the team talks about it. Decide which listed area name the Spec to place belongs under, by the part of the product it is about and where the other specs in the list would go, not by words it shares with a name. Choose a number only if that entry is in the list.',
    {
      ...slotCriteria,
      unsure: 'No listed area fits the spec, or it says too little to place it (a test, a probe or a placeholder).',
    },
  ),
};

function parseFeatures(raw: unknown): { ok: true; features: SpecTaxonomyFeatures } | { ok: false; message: string } {
  const r = raw as Partial<SpecTaxonomyFeatures> | null;
  const okSpec = (s: unknown) => !!s && typeof (s as TaxonomySpecEntry).title === 'string' && typeof (s as TaxonomySpecEntry).summary === 'string';
  const okFocus = okSpec(r?.focus) && Array.isArray(r!.focus!.criteria) && r!.focus!.criteria.every((c) => typeof c === 'string');
  const okSpecs = Array.isArray(r?.specs) && r!.specs.every(okSpec);
  const okNames = Array.isArray(r?.names) && r!.names.length >= 2 && r!.names.length <= NAME_SLOTS && r!.names.every((n) => typeof n === 'string' && n.trim().length > 0);
  return okFocus && okSpecs && okNames
    ? { ok: true, features: { specs: r!.specs!, omitted: Number(r!.omitted) || 0, focus: r!.focus!, names: r!.names! } }
    : { ok: false, message: 'focus must be a spec, specs a list of specs and names 2 to 40 area names' };
}

/** The label the model put most weight on, and that weight; a slot past the list is `unsure`. */
export function interpretName(answers: { area: { choice: string; probabilities: Record<string, number> } }, f: Pick<SpecTaxonomyFeatures, 'names'>): ModelVerdict<SpecTaxonomyDecision> {
  const label = answers.area.choice;
  const p = answers.area.probabilities[label] ?? 0;
  const slot = /^name_(\d+)$/.exec(label);
  if (slot) {
    const n = Number(slot[1]);
    if (n >= 1 && n <= f.names.length) return { decision: label as NameSlot, confidence: p, reasonCode: 'model_name' };
    return { decision: 'unsure', confidence: p, reasonCode: 'model_out_of_list' };
  }
  if (label === 'unsure') return { decision: 'unsure', confidence: p, reasonCode: 'model_unsure' };
  return { decision: 'unsure', confidence: p, reasonCode: 'model_unknown_label' };
}

type Config = DecisionKindConfig<typeof SPEC_TAXONOMY_KIND, SpecTaxonomyFeatures, SpecTaxonomyDecision, typeof questions>;

export const SPEC_TAXONOMY_CONFIG: Config = {
  kind: SPEC_TAXONOMY_KIND,
  policyVersion: 'spectaxonomy-2026-10-13.a',
  featureSchemaVersion: 'spectaxonomy-features-v1',
  decisions: SPEC_TAXONOMY_DECISIONS,
  parseFeatures: parseFeatures as Config['parseFeatures'],
  override: () => null,
  questions,
  state: taxonomyState,
  interpret: (a, f) => interpretName(a, f),
  // Every answer is used: a low one leaves the spec unplaced (UNPLACED_P), it is not dropped.
  minConfidence: 0,
  fallback: (_f, cause) => ({ decision: 'unsure', reasonCode: `fallback_${cause}` }),
};

/**
 * Models beyond Jev measured on the taxonomy eval (Jev always counts as
 * measured). Set from the eval; see the knowledge-base report.
 */
export const SPEC_TAXONOMY_MEASURED_MODELS: readonly string[] = [];

export const SPEC_TAXONOMY_BINDING: BuilddDecisionKindBinding = {
  capability: SPEC_TAXONOMY_CAPABILITY,
  mode: 'live',
  measuredModels: SPEC_TAXONOMY_MEASURED_MODELS,
};

export const specTaxonomyKind = defineBuilddDecisionKind(SPEC_TAXONOMY_CONFIG, SPEC_TAXONOMY_BINDING);

// ── Grouping (pure) ─────────────────────────────────────────────────────────

/** One spec's answer: the name it picked (null for `unsure`) and how sure. */
export interface NamePick { specId: string; name: string | null; p: number }

/**
 * The name to drop this step, while more names hold specs than `target`: the
 * smallest group; among groups of one spec, a generic name before one the
 * workspace's own specs gave (its `domain:` or titles); then the least
 * confidence, then the latest candidate. One at a time, so the specs re-asked
 * from one dropped name can grow another before the next is chosen. Pure.
 */
export function namesToDrop(picks: ReadonlyMap<string, NamePick>, alive: readonly string[], target: number, generic: ReadonlySet<string> = new Set()): string[] {
  const size = new Map(alive.map((n) => [n, 0]));
  const mass = new Map(alive.map((n) => [n, 0]));
  for (const p of picks.values()) if (p.name && size.has(p.name)) { size.set(p.name, size.get(p.name)! + 1); mass.set(p.name, mass.get(p.name)! + p.p); }
  const holding = alive.filter((n) => size.get(n)! > 0);
  const excess = holding.length - target;
  if (excess <= 0) return [];
  const own = (n: string) => (size.get(n)! < 2 && generic.has(n) ? 0 : 1);
  const order = [...holding].sort((a, b) => size.get(a)! - size.get(b)! || own(a) - own(b) || mass.get(a)! - mass.get(b)! || alive.indexOf(b) - alive.indexOf(a));
  return [order[0]!];
}

/** Fold a dropped name into a kept one: "Tasks" + "Missions" reads "Tasks and missions", never past four words or two "and"s. */
export function foldedTitle(kept: string, dropped: string): string {
  if (/\band\b/i.test(kept) || /\band\b/i.test(dropped)) return kept;
  const lower = dropped.length > 3 || dropped !== dropped.toUpperCase() ? `${dropped.charAt(0).toLowerCase()}${dropped.slice(1)}` : dropped;
  const title = `${kept} and ${lower}`;
  return title.split(/\s+/).length <= 4 ? title : kept;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'area';

/**
 * The proposal from the final answers. Pure. A spec with no answer, `unsure`,
 * a name no longer standing or an answer below UNPLACED_P is unplaced.
 */
export function assembleTaxonomy(
  items: readonly TaxonomyItem[],
  product: { title: string },
  final: ReadonlyMap<string, NamePick>,
  alive: readonly string[],
  titles: ReadonlyMap<string, string>,
): TaxonomyProposal {
  const members = new Map<string, Array<{ specId: string; title: string }>>(alive.map((k) => [k, []]));
  const unplaced: Array<{ specId: string; title: string }> = [];
  for (const it of items) {
    const p = final.get(it.specId);
    if (!p || !p.name || !members.has(p.name) || p.p < UNPLACED_P) unplaced.push({ specId: it.specId, title: it.title });
    else members.get(p.name)!.push({ specId: it.specId, title: it.title });
  }
  const used = new Set<string>();
  const areas = alive.filter((k) => members.get(k)!.length > 0).map((k) => {
    const t = titles.get(k) ?? k;
    let key = slug(t); let i = 2;
    while (used.has(key)) key = `${slug(t)}-${i++}`;
    used.add(key);
    const m = members.get(k)!;
    const such = m.slice(0, 3).map((x) => `"${x.title}"`);
    const list = such.length > 1 ? `${such.slice(0, -1).join(', ')} and ${such[such.length - 1]}` : such[0];
    const hint = items.find((i) => i.specId === m[0]!.specId)?.domainHint ?? null;
    return { key, title: t, charter: `Specs about ${t.charAt(0).toLowerCase()}${t.slice(1)}, such as ${list}.`, members: m, hint };
  }).sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
  return { product: { title: product.title, charter: `Everything ${product.title} does, area by area.` }, areas, unplaced };
}

// ── The call ────────────────────────────────────────────────────────────────

export type TaxonomyJudge = (features: SpecTaxonomyFeatures, subjectId: string) => Promise<{ decision: SpecTaxonomyDecision; confidence: number | null; source: string; fallbackCause: string | null; model: string | null }>;

export interface TaxonomyDeps {
  /** One answer for one spec. Default: the decision kind through the team's decision model, recorded in the ledger. */
  judge?: TaxonomyJudge;
  teamOf?: (workspaceId: string) => Promise<string | null>;
  /** How many areas to aim for. Default: `targetAreas` of the spec count. */
  target?: number;
  /** Answers already recorded for this workspace, by feature digest. Default: the decision ledger, last REUSE_DAYS. */
  recorded?: (scope: BuilddDecisionScope) => Promise<ReadonlyMap<string, RecordedAnswer>>;
}

export interface RecordedAnswer { decision: string; confidence: number; model: string | null }

/** The digest the ledger records an answer under (`fingerprint`): the kind's hash of its parsed features. */
export const featureDigestOf = (f: SpecTaxonomyFeatures) => shortHash(canonicalJson(f));

/** Answers recorded for this workspace under the current policy, newest first per digest. Fails open (none). */
async function recordedAnswers(scope: BuilddDecisionScope): Promise<ReadonlyMap<string, RecordedAnswer>> {
  const since = new Date(Date.now() - REUSE_DAYS * 24 * 3600 * 1000);
  const rows = await db.select({ fingerprint: decisionRecords.fingerprint, verdict: decisionRecords.verdict, confidence: decisionRecords.confidence, model: decisionRecords.model, createdAt: decisionRecords.createdAt })
    .from(decisionRecords)
    .where(and(
      eq(decisionRecords.teamId, scope.teamId), eq(decisionRecords.workspaceId, scope.workspaceId!), eq(decisionRecords.capability, SPEC_TAXONOMY_CAPABILITY),
      eq(decisionRecords.policyVersion, SPEC_TAXONOMY_CONFIG.policyVersion), eq(decisionRecords.status, 'applied'),
      isNotNull(decisionRecords.verdict), isNotNull(decisionRecords.confidence), gt(decisionRecords.createdAt, since),
    ));
  const out = new Map<string, RecordedAnswer>();
  for (const r of rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (!out.has(r.fingerprint)) out.set(r.fingerprint, { decision: r.verdict!, confidence: r.confidence!, model: r.model });
  }
  return out;
}

class NotRecorded extends Error {}

async function teamOfWorkspace(workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return ws?.teamId ?? null;
}

const judgeWith = (scope: BuilddDecisionScope): TaxonomyJudge => async (features, subjectId) => {
  const { recordDecision } = await import('@buildd/core/decision-ledger');
  const request: DecisionRequest<SpecTaxonomyFeatures> = { features, subjectRef: { type: 'spec', id: subjectId } };
  const r = await runBuilddDecision(specTaxonomyKind, request, scope, { record: async (input) => recordDecision(input) });
  return { decision: r.decision, confidence: r.confidence, source: r.source, fallbackCause: r.fallbackCause, model: r.model };
};

const fallbackReason = (cause: string | null) => (cause === 'disabled' ? 'the taxonomy proposal is off for this team'
  : cause === 'no_provider' ? 'this team has no decision-model key'
    : cause === 'unmeasured_model' ? 'the team\'s decision model was not measured for the taxonomy'
      : `the decision model did not answer (${cause ?? 'unavailable'})`);

async function pool<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/**
 * Propose a taxonomy with the team's decision model (R-4). Never throws: no
 * key, an unmeasured model, a failed first answer, or more than half of the
 * first round missing comes back as `{ ran: false, reason }`, and the caller
 * uses the word-based fallback.
 */
export async function proposeSpecTaxonomy(input: ProposeTaxonomyInput, deps: TaxonomyDeps = {}): ReturnType<TaxonomyProposer> {
  try {
    const items = input.items.slice(0, MAX_TAXONOMY_SPECS);
    if (items.length < 2) return { ran: false, reason: 'too few specs to sort' };
    let judge = deps.judge;
    if (!judge) {
      const teamId = await (deps.teamOf ?? teamOfWorkspace)(input.workspaceId);
      if (!teamId) return { ran: false, reason: 'the workspace has no team' };
      const scope: BuilddDecisionScope = { teamId, workspaceId: input.workspaceId, userId: input.userId ?? null, accountId: input.accountId ?? null };
      const live = judgeWith(scope);
      const recorded = await (deps.recorded ?? recordedAnswers)(scope).catch(() => new Map<string, RecordedAnswer>());
      judge = async (features, subjectId) => {
        const hit = recorded.get(featureDigestOf(features));
        if (hit) return { decision: hit.decision as SpecTaxonomyDecision, confidence: hit.confidence, source: 'model', fallbackCause: null, model: hit.model };
        if (input.cachedOnly) throw new NotRecorded();
        return live(features, subjectId);
      };
    }
    const { specs, omitted } = specListForState(items.map((i) => ({ title: i.title, summary: i.card.summary.slice(0, SUMMARY_CHARS), domain: i.domainHint ?? null })));
    let model: string | null = null;
    const ask = async (it: TaxonomyItem, names: string[]): Promise<NamePick | { failed: string }> => {
      const r = await judge!({ specs, omitted, names, focus: { title: it.title, summary: it.card.summary, domain: it.domainHint ?? null, criteria: it.card.criteria } }, it.specId);
      if (r.source !== 'model' || r.confidence === null) return { failed: r.fallbackCause ?? 'unavailable' };
      model ??= r.model;
      const slot = /^name_(\d+)$/.exec(r.decision);
      return { specId: it.specId, name: slot ? names[Number(slot[1]) - 1] ?? null : null, p: r.confidence };
    };
    const final = new Map<string, NamePick>();
    const askAll = async (its: readonly TaxonomyItem[], names: string[]) => {
      let failed = 0;
      await pool(its, CONCURRENCY, async (it) => {
        const r = await ask(it, names);
        if ('failed' in r) failed++; else final.set(it.specId, r);
      });
      return failed;
    };

    // 1. Every spec against every candidate. The first answer says whether a model runs at all.
    const candidates = candidateAreas(items.map((i) => ({ title: i.title, domain: i.domainHint ?? null })));
    const names = candidates.map((c) => c.name);
    const generic = new Set(candidates.filter((c) => c.source === 'generic').map((c) => c.name));
    const head = await ask(items[0]!, names);
    if ('failed' in head) return { ran: false, reason: fallbackReason(head.failed) };
    final.set(head.specId, head);
    if ((await askAll(items.slice(1), names)) * 2 > items.length) return { ran: false, reason: fallbackReason('provider_failure') };

    // 2. Drop the smallest names until the target is reached, re-asking their specs.
    const target = deps.target ?? targetAreas(items.length);
    let alive = names.filter((n) => [...final.values()].some((p) => p.name === n));
    const titles = new Map(alive.map((n) => [n, n]));
    for (let step = 0; step < NAME_SLOTS; step++) {
      const drop = namesToDrop(final, alive, target, generic);
      if (drop.length === 0 || alive.length - drop.length < 2) break;
      alive = alive.filter((n) => !drop.includes(n));
      for (const d of drop) {
        const moving = items.filter((it) => final.get(it.specId)?.name === d);
        await askAll(moving, alive);
        const went = new Map<string, number>();
        for (const it of moving) { const to = final.get(it.specId); if (to?.name && to.name !== d && to.p >= UNPLACED_P) went.set(to.name, (went.get(to.name) ?? 0) + 1); }
        const [to, n] = [...went].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
        if (to && moving.length >= 2 && n / moving.length >= FOLD_SHARE) titles.set(to, foldedTitle(titles.get(to)!, titles.get(d) ?? d));
        // A spec whose re-ask failed keeps a name that no longer stands: it is left unplaced.
      }
    }

    // 3. The unsure and the weak, once more against the final names.
    const again = items.filter((it) => { const p = final.get(it.specId); return !p || !p.name || p.p < UNPLACED_P; });
    if (again.length && alive.length >= 2) await askAll(again, alive);

    const proposal = assembleTaxonomy(items, input.product, final, alive, titles);
    // Specs past the cap were never asked: a person places them.
    for (const it of input.items.slice(MAX_TAXONOMY_SPECS)) proposal.unplaced!.push({ specId: it.specId, title: it.title });
    return { ran: true, proposal, model };
  } catch (err) {
    if (err instanceof NotRecorded) return { ran: false, reason: 'no model proposal yet: run organize to ask the decision model' };
    console.warn('[living-specs] taxonomy proposal failed (falling back to words):', (err as Error)?.message ?? err);
    return { ran: false, reason: 'the taxonomy proposal failed' };
  }
}
