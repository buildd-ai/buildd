import { createHash } from 'node:crypto';
import { db } from '@buildd/core/db';
import { specRevisions, specs, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionRequest, DecisionResponse, ModelVerdict } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import { specCard, tfidfRank, type SpecCard } from '@/lib/specs/card';
import { getArtifactRevision } from '@/lib/artifact-revisions';
import { SPEC_RELATIONS, type DuplicateCandidate, type DuplicateCheck, type DuplicateCheckInput, type DuplicateOverride, type SpecRelation } from '@/lib/specs/duplicates';

export { SPEC_RELATIONS, type SpecRelation };
export { specCard, type SpecCard };

/**
 * Spec duplicates (Living Specs slice 5, R-22, D-13; docs/specs/living-specs.md
 * §13), the decisions-module half: the shortlist, the Jev kind and the check.
 * Core reaches it through the `SPEC_DUPLICATE_CHECK` slot in modules.ts. When a spec is created, the most similar approved specs in its
 * workspace are shortlisted by TF-IDF over their text, and the team's decision
 * model judges each pair: duplicate, overlap or distinct.
 *
 * - A duplicate at p >= DUPLICATE_BLOCK_P is refused unless the request says
 *   which spec it supersedes, or why it is distinct. Measured offline
 *   2026-10-12 (knowledge base: buildd/reports/spec-duplicate-detection-
 *   eval-2026-10-12.md): Jev 106 of 106 duplicates right at 0.9, Clef and Clef
 *   Flash no false duplicate. A model this was not measured on is recorded,
 *   never applied.
 * - An overlap, or a duplicate below the bar, is a warning.
 * - The shortlist never decides: it ranked lookalike criteria above true
 *   paraphrases in the eval. It only picks what the model reads.
 * - Fail-open: no key, the capability off, a provider error or a timeout lets
 *   the spec through with a note that the check did not run.
 *
 * The question text is the one the eval measured. Changing it voids the
 * threshold: re-run the eval first.
 */

export const SPEC_DUPLICATE_KIND = 'buildd.spec_duplicate' as const;
export const SPEC_DUPLICATE_CAPABILITY = 'spec_duplicate' as const;

/** At or above, a duplicate is refused (with an override). */
export const DUPLICATE_BLOCK_P = 0.9;
/** At or above, an overlap is worth a warning. */
export const OVERLAP_WARN_P = 0.5;
export const SHORTLIST_SIZE = 5;
/** Below this TF-IDF cosine a candidate is not worth a model call. */
export const SHORTLIST_FLOOR = 0.05;
const MAX_APPROVED_SCANNED = 300;
const CARD_CHARS = 3000;

export interface SpecPair { a: SpecCard; b: SpecCard }

const block = (label: string, c: SpecCard) => {
  let out = c.title ? `${label}: ${c.title}\n${c.summary}\n` : `${label}:\n`;
  for (const x of c.criteria) {
    const line = `- ${x}\n`;
    if (out.length + line.length > CARD_CHARS) break;
    out += line;
  }
  return out;
};

/** The model's state: the measured format, the existing spec as A and the new one as B. */
export const specPairState = (p: SpecPair): string => `${block('Spec A', p.a)}\n${block('Spec B', p.b)}`;

// ── Shortlist: TF-IDF cosine, in process ────────────────────────────────────

/** Rank `pool` by TF-IDF cosine to `query`, best first, above the floor, at most `k`. Pure. */
export function tfidfShortlist<T extends { card: SpecCard }>(query: SpecCard, pool: readonly T[], k = SHORTLIST_SIZE, floor = SHORTLIST_FLOOR): Array<T & { score: number }> {
  return tfidfRank(query, pool, k, floor);
}

// ── The decision kind ───────────────────────────────────────────────────────

const questions = {
  relation: choice(
    'Two specs (or two single requirements), A and B, from the same team. Decide how B relates to A by what they REQUIRE, not by topic or wording. Two texts about the same area can still require different things.',
    {
      duplicate: 'B requires the same things as A: the same requirements, possibly reworded, reordered, merged or split. Building one satisfies the other.',
      overlap: 'B shares some requirements with A (one to a few), but each also requires things the other does not.',
      distinct: 'B requires different things from A, even if it is about the same feature area or uses similar words.',
    },
  ),
};

function parsePair(raw: unknown): { ok: true; features: SpecPair } | { ok: false; reason: string } {
  const r = raw as Partial<SpecPair> | null;
  const okCard = (c: unknown): c is SpecCard => !!c && typeof (c as SpecCard).title === 'string' && typeof (c as SpecCard).summary === 'string'
    && Array.isArray((c as SpecCard).criteria) && (c as SpecCard).criteria.every((x) => typeof x === 'string');
  return r && okCard(r.a) && okCard(r.b) ? { ok: true, features: { a: r.a, b: r.b } } : { ok: false, reason: 'a and b must be spec cards' };
}

/** The label the model put most weight on, and that weight. */
export function interpretRelation(answers: { relation: { choice: string; probabilities: Record<string, number> } }): ModelVerdict<SpecRelation> {
  const probs = answers.relation.probabilities;
  const label = (SPEC_RELATIONS as readonly string[]).includes(answers.relation.choice) ? (answers.relation.choice as SpecRelation) : 'distinct';
  return { decision: label, confidence: probs[label] ?? 0, reasonCode: `model_${label}` };
}

export const SPEC_DUPLICATE_CONFIG: DecisionKindConfig<typeof SPEC_DUPLICATE_KIND, SpecPair, SpecRelation, typeof questions> = {
  kind: SPEC_DUPLICATE_KIND,
  policyVersion: 'specdup-2026-10-12.a',
  featureSchemaVersion: 'specdup-features-v1',
  decisions: SPEC_RELATIONS,
  parseFeatures: parsePair as DecisionKindConfig<typeof SPEC_DUPLICATE_KIND, SpecPair, SpecRelation, typeof questions>['parseFeatures'],
  override: () => null,
  questions,
  state: specPairState,
  interpret: (a) => interpretRelation(a),
  // Every answer is applied and recorded; what blocks is decided here by the
  // measured bar, so an overlap below it still warns rather than vanishing.
  minConfidence: 0,
  fallback: (_f, cause) => ({ decision: 'distinct', reasonCode: `fallback_${cause}` }),
};

/**
 * Measured on the same 2026-10-12 set beside Jev (summary.json): Clef chose
 * duplicate for all 108 duplicates and for nothing else, 99 of them at
 * p >= 0.9 (ECE 0.045); Clef Flash also had no false duplicate but reached
 * 0.9 on only 10, so under it most duplicates warn. `clef` also covers
 * `clef-flash` (a dated or suffixed id matches by prefix).
 */
export const SPEC_DUPLICATE_MEASURED_MODELS = ['clef', '@cf/cloudflare/clef', 'cloudflare/clef'] as const;

export const SPEC_DUPLICATE_BINDING: BuilddDecisionKindBinding = {
  capability: SPEC_DUPLICATE_CAPABILITY,
  mode: 'live',
  measuredModels: SPEC_DUPLICATE_MEASURED_MODELS,
};

export const specDuplicateKind = defineBuilddDecisionKind(SPEC_DUPLICATE_CONFIG, SPEC_DUPLICATE_BINDING);

// ── The check ───────────────────────────────────────────────────────────────

export interface DuplicateCheckDeps {
  /** The approved specs to compare against, as cards. */
  approved?: (workspaceId: string) => Promise<Array<{ specId: string; title: string; card: SpecCard }>>;
  /** One model judgement, with the ledger row id it was recorded under. */
  judge?: (pair: SpecPair, scope: BuilddDecisionScope, subjectId: string) => Promise<{ response: DecisionResponse<string, SpecRelation>; recordId: string | null }>;
  teamOf?: (workspaceId: string) => Promise<string | null>;
}

async function approvedCards(workspaceId: string): Promise<Array<{ specId: string; title: string; card: SpecCard }>> {
  const rows = await db.select({ id: specs.id, title: specs.title, bodyArtifactId: specs.bodyArtifactId, artifactRevision: specRevisions.artifactRevision })
    .from(specs)
    .innerJoin(specRevisions, and(eq(specRevisions.specId, specs.id), eq(specRevisions.revision, specs.approvedRevision)))
    .where(and(eq(specs.workspaceId, workspaceId), isNotNull(specs.approvedRevision), isNotNull(specRevisions.approvedAt)))
    .limit(MAX_APPROVED_SCANNED);
  const out: Array<{ specId: string; title: string; card: SpecCard }> = [];
  for (const r of rows) {
    const body = await getArtifactRevision(r.bodyArtifactId, r.artifactRevision);
    if (typeof body?.content === 'string') out.push({ specId: r.id, title: r.title, card: specCard(r.title, body.content) });
  }
  return out;
}

async function judgeOnce(pair: SpecPair, scope: BuilddDecisionScope, subjectId: string) {
  const { recordDecision } = await import('@buildd/core/decision-ledger');
  let recordId: string | null = null;
  const request: DecisionRequest<SpecPair> = { features: pair, subjectRef: { type: 'spec_pair', id: subjectId } };
  const response = await runBuilddDecision(specDuplicateKind, request, scope, {
    record: async (input) => { recordId = await recordDecision(input); return recordId; },
  });
  return { response, recordId };
}

async function teamOfWorkspace(workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return ws?.teamId ?? null;
}

const digest = (c: SpecCard) => createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);

/**
 * Compare a new spec with its workspace's approved specs. Never throws: any
 * failure comes back as `{ ran: false, reason }`.
 */
export async function checkSpecDuplicates(
  input: DuplicateCheckInput,
  deps: DuplicateCheckDeps = {},
): Promise<DuplicateCheck> {
  try {
    const teamId = await (deps.teamOf ?? teamOfWorkspace)(input.workspaceId);
    if (!teamId) return { ran: false, reason: 'the workspace has no team' };
    const pool = (await (deps.approved ?? approvedCards)(input.workspaceId)).filter((p) => p.specId !== input.excludeSpecId);
    const card = specCard(input.title, input.body);
    const shortlist = tfidfShortlist(card, pool);
    if (shortlist.length === 0) return { ran: true, blocking: [], warnings: [], compared: 0 };
    const scope: BuilddDecisionScope = { teamId, workspaceId: input.workspaceId, userId: input.userId ?? null, accountId: input.accountId ?? null };
    const judge = deps.judge ?? judgeOnce;
    const results = await Promise.all(shortlist.map(async (c) => {
      const { response, recordId } = await judge({ a: c.card, b: card }, scope, `${c.specId}:${digest(card)}`);
      return { c, response, recordId };
    }));
    // Nothing answered: the capability is off, there is no key, or the provider failed.
    if (results.every((r) => r.response.source !== 'model')) {
      const cause = results[0]?.response.fallbackCause ?? 'unavailable';
      return { ran: false, reason: cause === 'disabled' ? 'spec duplicate checks are off for this team' : cause === 'no_provider' ? 'this team has no decision-model key' : `the decision model did not answer (${cause})` };
    }
    const blocking: DuplicateCandidate[] = [];
    const warnings: DuplicateCandidate[] = [];
    for (const { c, response, recordId } of results) {
      if (response.source !== 'model' || response.confidence === null) continue;
      const cand: DuplicateCandidate = { specId: c.specId, title: c.title, relation: response.decision, p: response.confidence, similarity: Number(c.score.toFixed(3)), decisionRecordId: recordId };
      if (response.decision === 'duplicate' && response.confidence >= DUPLICATE_BLOCK_P) blocking.push(cand);
      else if (response.decision === 'duplicate' || (response.decision === 'overlap' && response.confidence >= OVERLAP_WARN_P)) warnings.push(cand);
    }
    return { ran: true, blocking, warnings, compared: results.length };
  } catch (err) {
    console.warn('[living-specs] duplicate check failed (spec allowed):', (err as Error)?.message ?? err);
    return { ran: false, reason: 'the duplicate check failed' };
  }
}

/**
 * The id in an author label (`user:<uuid>` or `account:<uuid>`), for the
 * ledger's uuid `overridden_by`, as the decisions override route writes it.
 * The label itself goes in the override, so an agent's reads as one.
 */
export const overrideActorId = (by: string): string | null => /^(?:user|account):([0-9a-f-]{36})$/i.exec(by)?.[1] ?? null;

/**
 * Record a person's override on each blocking judgement's ledger row, so the
 * bar can be re-measured. `by` is the author label. Never throws.
 */
export async function recordDuplicateOverride(blocking: readonly DuplicateCandidate[], override: DuplicateOverride, by: string): Promise<void> {
  const { recordHumanOverride } = await import('@buildd/core/decision-ledger');
  for (const d of blocking) {
    if (!d.decisionRecordId) continue;
    const decision = override.supersedes === d.specId ? 'duplicate_superseded' : override.supersedes ? 'superseded_other' : 'distinct';
    await recordHumanOverride(d.decisionRecordId, { decision, ...override, by }, overrideActorId(by));
  }
}
