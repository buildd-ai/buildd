import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionRequest, DecisionResponse, ModelVerdict } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import { tfidfRank, type SpecCard } from '@/lib/specs/card';
import { overrideActorId } from '@/lib/spec-duplicate-decision';
import type { AreaClassification, AreaClassifyInput, AreaInfo } from '@/lib/specs/areas';

/**
 * Spec areas (Living Specs §17, R-5 to R-9), the decisions-module half: the
 * classifier's state, the kind and the call. Core (lib/specs/organize.ts)
 * reaches it through the `SPEC_AREA_CLASSIFY` slot in modules.ts, lists the
 * areas itself and applies the answer by the rule in R-7.
 *
 * The state is the spec's card and the workspace's areas, numbered: the
 * product node, the areas most similar to the card, then every area holding
 * more than BIG_AREA_MEMBERS specs, until AREA_STATE_CHARS is spent or the
 * AREA_SLOTS are full, and how many it left out. The answer is a slot number,
 * `new_area` or `unsure`; a number past the list reads as `unsure`.
 *
 * Measured offline 2026-10-13 (knowledge base: buildd/reports/spec-area-
 * filing-eval-2026-10-13.md) before any answer is applied. The question text
 * and the state format are the ones measured: changing either voids
 * AREA_FILE_P, so re-run the eval first.
 */

export const SPEC_AREA_KIND = 'buildd.spec_area' as const;
export const SPEC_AREA_CAPABILITY = 'spec_area' as const;

/** Numbered entries the state can hold (and the question can name). */
export const AREA_SLOTS = 18;
/** Areas ranked by similarity to the card, after the product node. */
export const TOP_SIMILAR_AREAS = 15;
/** An area with more members than this is always shown, similar or not. */
export const BIG_AREA_MEMBERS = 8;
/** Member titles shown per area. */
export const MEMBER_TITLES = 5;
/** The areas part of the state stops here (characters, about 1.5k tokens). */
export const AREA_STATE_CHARS = 6000;
const CARD_CHARS = 2400;
const CHARTER_CHARS = 280;

/**
 * At or above, from a measured model, an area answer is applied (R-7). Set
 * from the eval: the lowest bar at which Jev's auto-filing was right at least
 * 95% of the time, counting a spec whose own area was missing and got filed
 * anywhere as wrong. Jev is over-confident when no area fits (it rarely says
 * `new_area`), which is what sets the bar this high; when the right area is
 * listed it is right far below it. Clef and Clef Flash were precise at lower
 * bars but never reach this one, so under them every answer is a suggestion.
 */
export const AREA_FILE_P = 0.97;

export const AREA_SLOT_LABELS = Array.from({ length: AREA_SLOTS }, (_, i) => `area_${i + 1}` as const);
export type AreaSlot = (typeof AREA_SLOT_LABELS)[number];
export const SPEC_AREA_DECISIONS = [...AREA_SLOT_LABELS, 'new_area', 'unsure'] as const;
export type SpecAreaDecision = (typeof SPEC_AREA_DECISIONS)[number];

export interface AreaStateEntry { id: string; title: string; scope: 'product' | 'domain'; charter: string; members: string[]; memberCount: number; domains?: string[] }
/**
 * `hint` is set only by a repo import (lib/specs/import.ts): the file's own
 * `domain:` and, on each entry, the domain values that area declares. Without
 * it the state is byte for byte the one measured; with it, two kinds of line
 * are added and the question text is unchanged.
 */
export interface SpecAreaFeatures { card: SpecCard; areas: AreaStateEntry[]; omitted: number; hint?: { domain: string | null } }

// ── The state ───────────────────────────────────────────────────────────────

const areaCard = (a: AreaInfo): SpecCard => ({ title: a.title, summary: a.charter, criteria: a.memberTitles });

const entryLine = (n: number, a: AreaStateEntry): string => {
  const kind = a.scope === 'product' ? ' (the whole product)' : '';
  const charter = a.charter ? ` ${a.charter.slice(0, CHARTER_CHARS)}` : '';
  const holds = a.memberCount === 0 ? ' Holds no specs yet.'
    : ` Holds ${a.memberCount} spec${a.memberCount === 1 ? '' : 's'}${a.members.length ? `, such as: ${a.members.join('; ')}` : ''}.`;
  const declares = a.domains?.length ? ` Declares domains: ${a.domains.join(', ')}.` : '';
  return `[${n}] ${a.title}${kind}:${charter}${holds}${declares}\n`;
};

const HINT_DOMAINS = 6;

/**
 * Pick the areas the model reads (R-6). Pure. Products first, then the most
 * similar areas, then every big area, each once, within the slot count and the
 * character budget; `omitted` counts the rest.
 */
export function selectAreasForState(card: SpecCard, areas: readonly AreaInfo[], opts: { workspaceId?: string } = {}): { areas: AreaStateEntry[]; omitted: number } {
  const pool = areas.filter((a) => !opts.workspaceId || a.workspaceId === opts.workspaceId);
  const products = pool.filter((a) => a.scope === 'product');
  const domains = pool.filter((a) => a.scope === 'domain');
  const similar = tfidfRank(card, domains.map((a) => ({ a, card: areaCard(a) })), TOP_SIMILAR_AREAS, -1).map((x) => x.a);
  const big = domains.filter((a) => a.memberCount > BIG_AREA_MEMBERS).sort((x, y) => y.memberCount - x.memberCount);
  const order: AreaInfo[] = [];
  const seen = new Set<string>();
  for (const a of [...products, ...similar, ...big]) if (!seen.has(a.id)) { seen.add(a.id); order.push(a); }
  const out: AreaStateEntry[] = [];
  let used = 0;
  for (const a of order) {
    if (out.length >= AREA_SLOTS) break;
    const entry: AreaStateEntry = { id: a.id, title: a.title, scope: a.scope, charter: a.charter.slice(0, CHARTER_CHARS), members: a.memberTitles.slice(0, MEMBER_TITLES), memberCount: a.memberCount };
    const len = entryLine(out.length + 1, entry).length;
    if (used + len > AREA_STATE_CHARS) continue;
    used += len;
    out.push(entry);
  }
  return { areas: out, omitted: pool.length - out.length };
}

/** The model's view: the card, then the numbered areas and how many were left out. */
export function specAreaState(f: SpecAreaFeatures): string {
  let card = `New spec: ${f.card.title}\n${f.card.summary}\n`;
  if (f.hint?.domain) card += `The repo file names its domain: ${f.hint.domain} (a hint only; place it by what it is about).\n`;
  for (const c of f.card.criteria) {
    const line = `- ${c}\n`;
    if (card.length + line.length > CARD_CHARS) break;
    card += line;
  }
  const shown = f.areas.length;
  const head = `Areas of this product (${shown} shown${f.omitted ? `, ${f.omitted} more not shown` : ''}):\n`;
  return `${card}\n${head}${f.areas.map((a, i) => entryLine(i + 1, a)).join('')}`;
}

// ── The decision kind ───────────────────────────────────────────────────────

const slotCriteria = Object.fromEntries(AREA_SLOT_LABELS.map((l, i) => [l, `The new spec belongs under entry [${i + 1}] of the list.`])) as Record<AreaSlot, string>;

const questions = {
  area: choice(
    'A team keeps its specs in one tree: the product, its areas, and the specs under each area. Decide which listed entry the New spec belongs under, by the part of the product it is about (the entry\'s description and the specs it already holds), not by shared words. Choose the whole-product entry only when no single area covers the spec. Choose a number only if that entry is in the list.',
    {
      ...slotCriteria,
      new_area: 'None of the listed entries fits: the spec is about a part of the product the list has no area for.',
      unsure: 'Two or more entries fit about equally well, or the spec says too little to place it.',
    },
  ),
};

function parseFeatures(raw: unknown): { ok: true; features: SpecAreaFeatures } | { ok: false; message: string } {
  const r = raw as Partial<SpecAreaFeatures> | null;
  const c = r?.card;
  const okCard = !!c && typeof c.title === 'string' && typeof c.summary === 'string' && Array.isArray(c.criteria) && c.criteria.every((x) => typeof x === 'string');
  const okAreas = Array.isArray(r?.areas) && r!.areas.length > 0 && r!.areas.length <= AREA_SLOTS && r!.areas.every((a) => a && typeof a.id === 'string' && typeof a.title === 'string');
  const hint = r?.hint && (r.hint.domain === null || typeof r.hint.domain === 'string') ? { hint: { domain: r.hint.domain } } : {};
  return okCard && okAreas ? { ok: true, features: { card: c!, areas: r!.areas!, omitted: Number(r!.omitted) || 0, ...hint } } : { ok: false, message: 'card must be a spec card and areas 1 to 18 entries' };
}

/** The label the model put most weight on, and that weight; a slot past the list is `unsure`. */
export function interpretArea(answers: { area: { choice: string; probabilities: Record<string, number> } }, f: Pick<SpecAreaFeatures, 'areas'>): ModelVerdict<SpecAreaDecision> {
  const label = answers.area.choice;
  const p = answers.area.probabilities[label] ?? 0;
  const slot = /^area_(\d+)$/.exec(label);
  if (slot) {
    const n = Number(slot[1]);
    if (n >= 1 && n <= f.areas.length) return { decision: label as AreaSlot, confidence: p, reasonCode: 'model_area' };
    return { decision: 'unsure', confidence: p, reasonCode: 'model_out_of_list' };
  }
  if (label === 'new_area' || label === 'unsure') return { decision: label, confidence: p, reasonCode: `model_${label}` };
  return { decision: 'unsure', confidence: p, reasonCode: 'model_unknown_label' };
}

type Config = DecisionKindConfig<typeof SPEC_AREA_KIND, SpecAreaFeatures, SpecAreaDecision, typeof questions>;

export const SPEC_AREA_CONFIG: Config = {
  kind: SPEC_AREA_KIND,
  policyVersion: 'specarea-2026-10-13.a',
  featureSchemaVersion: 'specarea-features-v1',
  decisions: SPEC_AREA_DECISIONS,
  parseFeatures: parseFeatures as Config['parseFeatures'],
  override: () => null,
  questions,
  state: specAreaState,
  interpret: (a, f) => interpretArea(a, f),
  // Every answer is recorded; what files is decided here by the measured bar,
  // so a low answer still becomes a suggestion rather than vanishing.
  minConfidence: 0,
  fallback: (_f, cause) => ({ decision: 'unsure', reasonCode: `fallback_${cause}` }),
};

/**
 * Measured beside Jev on the same 2026-10-13 set: Clef at least 0.95 precise
 * from p 0.7, Clef Flash from 0.5, but neither reaches AREA_FILE_P, so they
 * only suggest until a per-model threshold is stored. `clef` also covers
 * `clef-flash` (a suffixed id matches by prefix).
 */
export const SPEC_AREA_MEASURED_MODELS = ['clef', '@cf/cloudflare/clef', 'cloudflare/clef'] as const;

export const SPEC_AREA_BINDING: BuilddDecisionKindBinding = {
  capability: SPEC_AREA_CAPABILITY,
  mode: 'live',
  measuredModels: SPEC_AREA_MEASURED_MODELS,
};

export const specAreaKind = defineBuilddDecisionKind(SPEC_AREA_CONFIG, SPEC_AREA_BINDING);

// ── The call ────────────────────────────────────────────────────────────────

export interface AreaClassifyDeps {
  judge?: (features: SpecAreaFeatures, scope: BuilddDecisionScope, subjectId: string) => Promise<{ response: DecisionResponse<string, SpecAreaDecision>; recordId: string | null }>;
  teamOf?: (workspaceId: string) => Promise<string | null>;
}

async function judgeOnce(features: SpecAreaFeatures, scope: BuilddDecisionScope, subjectId: string) {
  const { recordDecision } = await import('@buildd/core/decision-ledger');
  let recordId: string | null = null;
  const request: DecisionRequest<SpecAreaFeatures> = { features, subjectRef: { type: 'spec', id: subjectId } };
  const response = await runBuilddDecision(specAreaKind, request, scope, {
    record: async (input) => { recordId = await recordDecision(input); return recordId; },
  });
  return { response, recordId };
}

async function teamOfWorkspace(workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return ws?.teamId ?? null;
}

/**
 * Ask which area a spec belongs in. Never throws: any failure, an unmeasured
 * model or no areas comes back as `{ ran: false, reason }`, and the caller
 * falls back to the similarity suggestion (R-9).
 */
export async function classifySpecArea(input: AreaClassifyInput, deps: AreaClassifyDeps = {}): Promise<AreaClassification> {
  try {
    const { areas, omitted } = selectAreasForState(input.card, input.areas, { workspaceId: input.workspaceId });
    if (areas.length === 0) return { ran: false, reason: 'the workspace has no areas' };
    const teamId = await (deps.teamOf ?? teamOfWorkspace)(input.workspaceId);
    if (!teamId) return { ran: false, reason: 'the workspace has no team' };
    const scope: BuilddDecisionScope = { teamId, workspaceId: input.workspaceId, userId: input.userId ?? null, accountId: input.accountId ?? null };
    // An import's hint: its `domain:` on the card, each area's declared domains on its line. Absent, the measured state.
    const features: SpecAreaFeatures = input.hint
      ? {
        card: input.card, omitted, hint: { domain: input.hint.domain },
        areas: areas.map((a) => {
          const domains = (input.areas.find((x) => x.id === a.id)?.domains ?? []).slice(0, HINT_DOMAINS);
          return domains.length ? { ...a, domains } : a;
        }),
      }
      : { card: input.card, areas, omitted };
    const { response, recordId } = await (deps.judge ?? judgeOnce)(features, scope, input.specId);
    if (response.source !== 'model' || response.confidence === null) {
      const cause = response.fallbackCause ?? 'unavailable';
      return {
        ran: false, decisionRecordId: recordId,
        reason: cause === 'disabled' ? 'spec area filing is off for this team'
          : cause === 'no_provider' ? 'this team has no decision-model key'
            : cause === 'unmeasured_model' ? 'the team\'s decision model was not measured for filing'
              : `the decision model did not answer (${cause})`,
      };
    }
    const slot = /^area_(\d+)$/.exec(response.decision);
    const area = slot ? areas[Number(slot[1]) - 1] : undefined;
    return {
      ran: true,
      answer: area ? 'area' : response.decision === 'new_area' ? 'new_area' : 'unsure',
      areaId: area?.id ?? null,
      p: response.confidence,
      confident: !!area && response.confidence >= AREA_FILE_P,
      model: response.model,
      decisionRecordId: recordId,
      shown: areas.length,
      omitted,
    };
  } catch (err) {
    console.warn('[living-specs] area classify failed (spec unaffected):', (err as Error)?.message ?? err);
    return { ran: false, reason: 'the area check failed' };
  }
}

/** A person moved or un-filed a spec buildd filed: record it on the filing's ledger row (R-11). Never throws. */
export async function recordAreaOverride(decisionRecordId: string, override: { parentSpecId: string | null; previousParentId: string | null }, by: string): Promise<void> {
  const { recordHumanOverride } = await import('@buildd/core/decision-ledger');
  await recordHumanOverride(decisionRecordId, { decision: override.parentSpecId ? 'moved' : 'unfiled', ...override, by }, overrideActorId(by));
}
