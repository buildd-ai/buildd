import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionRequest, DecisionResponse, ModelVerdict, DecisionVerdict } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import { scanForProdData } from '@/lib/specs/no-prod-data-scan';
import { POLICY_LINE_SLOTS, publicationReason, type PolicyLine, type PolicyLineGroup, type PublicationMark } from '@/lib/specs/publication';
import { overrideActorId } from '@/lib/spec-duplicate-decision';

/**
 * Which text leaves buildd (Living Specs Slice 14, D-22, R-67): the decision
 * kind `buildd.spec_publication`. The core half (the policy, the mark, the
 * sentence) is lib/specs/publication.ts; core reaches this through the
 * `SPEC_PUBLICATION_DECIDE` slot in modules.ts.
 *
 * The input is general (a text, where it is going, the policy), so PR bodies,
 * commit messages and the docs site can use the same kind later.
 *
 * Fixed rules answer first, in order, and a model never overrules them
 * (`publicationOverride`):
 *   1. a production-data hit in the text keeps it private, naming the hit;
 *   2. no approved policy keeps it private (D-21);
 *   3. a person's mark decides (private, or public);
 *   4. a private destination (a private repo) publishes;
 *   5. a text too long to read whole keeps it private.
 * Otherwise the model reads the policy and the text and answers publish, keep
 * private or unsure, and names the numbered policy line it relied on.
 *
 * Every doubt keeps it private, so the kind is live from the start: its worst
 * case is publication off. A model answer publishes only at or above
 * PUBLICATION_PUBLISH_P, which is null until an offline eval over a
 * workspace's own specs, labelled by a person, sets it (R-69): until then every
 * answer is recorded and nothing the rules leave open is published.
 */

export const SPEC_PUBLICATION_KIND = 'buildd.spec_publication' as const;
export const SPEC_PUBLICATION_CAPABILITY = 'spec_publication' as const;

export const SPEC_PUBLICATION_DECISIONS = ['publish', 'keep_private', 'unsure'] as const;
export type SpecPublicationKindDecision = (typeof SPEC_PUBLICATION_DECISIONS)[number];

/**
 * The bar a model's `publish` must reach to apply. Null: unmeasured. Set it
 * only from the eval described above, and name the report beside it.
 */
export const PUBLICATION_PUBLISH_P: number | null = null;

/** Characters of text the model reads. Longer keeps it private (rule 5). */
export const MAX_PUBLICATION_TEXT_CHARS = 60_000;

export const LINE_SLOT_LABELS = Array.from({ length: POLICY_LINE_SLOTS }, (_, i) => `line_${i + 1}` as const);
type LineSlot = (typeof LINE_SLOT_LABELS)[number];

export interface PublicationDestination {
  /** What kind of place: `repo_spec_copy` today; PR bodies and the like later. */
  kind: string;
  /** Where, in words: "the public repo, as docs/specs/x.md". */
  label: string;
  /** True when only the team can read the destination (a private repo). Null: unknown. */
  private: boolean | null;
}

export interface PublicationPolicyInput { version: string; text: string; lines: PolicyLine[] }

export interface SpecPublicationFeatures {
  text: string;
  destination: PublicationDestination;
  policy: PublicationPolicyInput | null;
  mark: PublicationMark | null;
  /** Derived in parseFeatures from `text`: a caller cannot assert it. */
  prodDataHits: string[];
  /** Derived: the text is longer than the model reads. */
  tooLong: boolean;
}

const GROUPS: readonly PolicyLineGroup[] = ['publish', 'private', 'other'];

export function parsePublicationFeatures(raw: unknown): { ok: true; features: SpecPublicationFeatures } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'features must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== 'string') return { ok: false, message: 'text must be a string' };
  const d = r.destination as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || typeof d.kind !== 'string' || typeof d.label !== 'string' || !(d.private === null || typeof d.private === 'boolean')) {
    return { ok: false, message: 'destination must be { kind, label, private: boolean | null }' };
  }
  let policy: PublicationPolicyInput | null = null;
  if (r.policy != null) {
    const p = r.policy as Record<string, unknown>;
    const lines = Array.isArray(p.lines) ? p.lines : null;
    if (typeof p.version !== 'string' || typeof p.text !== 'string' || !lines || lines.length > POLICY_LINE_SLOTS
      || !lines.every((l) => l && typeof l.text === 'string' && typeof l.n === 'number' && GROUPS.includes(l.group))) {
      return { ok: false, message: `policy must be { version, text, lines (at most ${POLICY_LINE_SLOTS}) } or null` };
    }
    policy = { version: p.version, text: p.text, lines: lines as PolicyLine[] };
  }
  if (!(r.mark == null || r.mark === 'private' || r.mark === 'public')) return { ok: false, message: 'mark must be private, public or null' };
  return {
    ok: true,
    features: {
      text: r.text, destination: { kind: d.kind, label: d.label, private: d.private as boolean | null }, policy,
      mark: (r.mark as PublicationMark | null | undefined) ?? null,
      prodDataHits: scanForProdData(r.text, { code: false }),
      tooLong: r.text.length > MAX_PUBLICATION_TEXT_CHARS,
    },
  };
}

/** The fixed rules (R-67), in order. Null: ask the model. */
export function publicationOverride(f: SpecPublicationFeatures): DecisionVerdict<SpecPublicationKindDecision> | null {
  if (f.prodDataHits.length) return { decision: 'keep_private', reasonCode: 'rule_prod_data' };
  if (!f.policy) return { decision: 'keep_private', reasonCode: 'rule_no_policy' };
  if (f.mark === 'private') return { decision: 'keep_private', reasonCode: 'rule_marked_private' };
  if (f.mark === 'public') return { decision: 'publish', reasonCode: 'rule_marked_public' };
  if (f.destination.private === true) return { decision: 'publish', reasonCode: 'rule_private_destination' };
  if (f.tooLong) return { decision: 'keep_private', reasonCode: 'rule_too_long' };
  return null;
}

const groupWord: Record<PolicyLineGroup, string> = { publish: 'may be published', private: 'stays private', other: 'other' };

/** The model's view: the numbered policy lines, the policy as written, where the text is going and the text. */
export function publicationState(f: SpecPublicationFeatures): string {
  const p = f.policy;
  const lines = p ? p.lines.map((l) => `[${l.n}] (${groupWord[l.group]}) ${l.text}\n`).join('') : '';
  return `Publication policy, version ${p?.version ?? 'none'}. Numbered lines:\n${lines}\nThe policy as written:\n${p?.text ?? ''}\n\n`
    + `Where the text is going: ${f.destination.label}\n\nThe text:\n${f.text}`;
}

const lineCriteria = Object.fromEntries(LINE_SLOT_LABELS.map((l, i) => [l, `Numbered policy line [${i + 1}].`])) as Record<LineSlot, string>;

const questions = {
  publication: choice(
    {
      question: 'A team wrote a publication policy saying what text may leave their system for a public place, and what stays private. '
        + 'Read the policy and the text. May this text be published where it is going?',
      rule: 'Judge by what the text says, not its topic words. If any part of the text falls under a line that keeps something private, '
        + 'keep it private, even when other lines allow the rest. Choose publish only when the policy plainly allows all of it. When in doubt, unsure.',
    },
    {
      publish: 'The policy plainly allows all of this text to be published there.',
      keep_private: 'Some part of the text falls under a policy line that keeps it private.',
      unsure: 'The policy does not clearly cover the text, or it is borderline.',
    },
  ),
  line: choice(
    'Which numbered policy line did that answer rely on most? Choose a number only if that line is in the list.',
    { ...lineCriteria, none: 'No single listed line: the answer rests on the policy as a whole.' },
  ),
};

/** The answer and its weight; the line goes in the reason code (`model_<answer>_line_<n>`), since only that reaches the ledger. */
export function interpretPublication(
  a: { publication: { choice: string; probabilities: Record<string, number> }; line: { choice: string } },
  f: Pick<SpecPublicationFeatures, 'policy'>,
): ModelVerdict<SpecPublicationKindDecision> {
  const raw = a.publication.choice;
  const decision: SpecPublicationKindDecision = (SPEC_PUBLICATION_DECISIONS as readonly string[]).includes(raw) ? raw as SpecPublicationKindDecision : 'unsure';
  const p = a.publication.probabilities[raw] ?? 0;
  const m = /^line_(\d+)$/.exec(a.line.choice);
  const n = m && Number(m[1]) <= (f.policy?.lines.length ?? 0) ? Number(m[1]) : null;
  return { decision, confidence: p, reasonCode: `model_${decision}_line_${n ?? 'none'}` };
}

/** The policy line a reason code names, or undefined. Pure. */
export function lineOfReason(reasonCode: string | null | undefined, policy: Pick<PublicationPolicyInput, 'lines'> | null): PolicyLine | undefined {
  const m = /_line_(\d+)$/.exec(reasonCode ?? '');
  return m && policy ? policy.lines.find((l) => l.n === Number(m[1])) : undefined;
}

type Config = DecisionKindConfig<typeof SPEC_PUBLICATION_KIND, SpecPublicationFeatures, SpecPublicationKindDecision, typeof questions>;

export const SPEC_PUBLICATION_CONFIG: Config = {
  kind: SPEC_PUBLICATION_KIND,
  policyVersion: 'specpub-2026-10-14.a',
  featureSchemaVersion: 'specpub-features-v1',
  decisions: SPEC_PUBLICATION_DECISIONS,
  parseFeatures: parsePublicationFeatures as Config['parseFeatures'],
  override: publicationOverride,
  questions,
  state: publicationState,
  interpret: (a, f) => interpretPublication(a, f),
  // Unmeasured: below 1 every model answer reads as low confidence and is
  // recorded as a fallback (AC-51). The caller also requires the bar.
  minConfidence: PUBLICATION_PUBLISH_P ?? 1,
  // Every cause keeps the text private: today's "off".
  fallback: (_f, cause) => ({ decision: 'keep_private', reasonCode: `fallback_${cause}` }),
};

/** Live from the start (D-22). No escalation, no other measured model, until the eval. */
export const SPEC_PUBLICATION_BINDING: BuilddDecisionKindBinding = {
  capability: SPEC_PUBLICATION_CAPABILITY,
  mode: 'live',
};

export const specPublicationKind = defineBuilddDecisionKind(SPEC_PUBLICATION_CONFIG, SPEC_PUBLICATION_BINDING);

// ── The call ────────────────────────────────────────────────────────────────

export interface PublicationDecideInput {
  workspaceId: string;
  /** The subject on the ledger: the spec. */
  subjectId: string;
  text: string;
  destination: PublicationDestination;
  policy: PublicationPolicyInput | null;
  mark: PublicationMark | null;
  markFrom?: 'spec' | 'area';
}

export interface PublicationOutcome {
  publish: boolean;
  source: 'rule' | 'model' | 'fallback';
  reasonCode: string;
  /** The one sentence the spec page shows (R-68). */
  reason: string;
  line?: string;
  policyVersion: string | null;
  confidence: number | null;
  model: string | null;
  decisionRecordId: string | null;
}

export interface PublicationDecideDeps {
  judge?: (request: DecisionRequest<unknown>, scope: BuilddDecisionScope) => Promise<{ response: DecisionResponse<string, SpecPublicationKindDecision>; recordId: string | null }>;
  teamOf?: (workspaceId: string) => Promise<string | null>;
  /** The bar; defaults to PUBLICATION_PUBLISH_P. Tests set it. */
  bar?: number | null;
}

async function judgeOnce(request: DecisionRequest<unknown>, scope: BuilddDecisionScope) {
  const { recordDecision } = await import('@buildd/core/decision-ledger');
  let recordId: string | null = null;
  const response = await runBuilddDecision(specPublicationKind, request as DecisionRequest<SpecPublicationFeatures>, scope, {
    record: async (input) => { recordId = await recordDecision(input); return recordId; },
  });
  return { response, recordId };
}

async function teamOfWorkspace(workspaceId: string): Promise<string | null> {
  const [ws] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return ws?.teamId ?? null;
}

/**
 * Publish or keep private (R-67). Never throws: any failure keeps the text
 * private. A model `publish` applies only at the measured bar; without one,
 * it is recorded and the text stays private.
 */
export async function decidePublication(input: PublicationDecideInput, deps: PublicationDecideDeps = {}): Promise<PublicationOutcome> {
  const policyVersion = input.policy?.version ?? null;
  const features = { text: input.text, destination: input.destination, policy: input.policy, mark: input.mark };
  const kept = (reasonCode: string, extra: Partial<PublicationOutcome> = {}): PublicationOutcome => ({
    publish: false, source: 'fallback', reasonCode, reason: publicationReason({ publish: false, reasonCode, line: extra.line }),
    policyVersion, confidence: null, model: null, decisionRecordId: null, ...extra,
  });
  try {
    // The rules first, without a team or a model: they need neither.
    const parsed = parsePublicationFeatures(features);
    if (!parsed.ok) return kept('fallback_invalid_features');
    const rule = publicationOverride(parsed.features);
    const teamId = await (deps.teamOf ?? teamOfWorkspace)(input.workspaceId);
    if (!teamId) {
      if (rule) return ruleOutcome(rule, parsed.features, input, null);
      return kept('fallback_no_team');
    }
    const scope: BuilddDecisionScope = { teamId, workspaceId: input.workspaceId, userId: null, accountId: null };
    const { response, recordId } = await (deps.judge ?? judgeOnce)({ features, subjectRef: { type: 'spec', id: input.subjectId } }, scope);
    if (response.source === 'rule') return ruleOutcome({ decision: response.decision, reasonCode: response.reasonCode }, parsed.features, input, recordId);
    const bar = deps.bar === undefined ? PUBLICATION_PUBLISH_P : deps.bar;
    // The model's own answer, applied or not: the decisive attempt, else the first that answered.
    const answered = response.attempts?.find((a) => a.decision) ?? null;
    const line = lineOfReason(response.source === 'model' ? response.reasonCode : answered?.reasonCode, input.policy);
    const confidence = response.confidence ?? answered?.confidence ?? null;
    const model = response.model ?? answered?.model ?? null;
    if (response.source === 'model' && response.decision === 'publish') {
      if (bar == null || (response.confidence ?? 0) < bar) return kept('below_bar', { source: 'fallback', line: line?.text, confidence, model, decisionRecordId: recordId });
      if (line && line.group === 'private') return kept('model_publish_on_private_line', { source: 'model', line: line.text, confidence, model, decisionRecordId: recordId });
      return { publish: true, source: 'model', reasonCode: response.reasonCode, reason: publicationReason({ publish: true, reasonCode: response.reasonCode, line: line?.text }), line: line?.text, policyVersion, confidence, model, decisionRecordId: recordId };
    }
    if (response.source === 'model') {
      return kept(response.reasonCode, { source: 'model', line: line?.text, confidence, model, decisionRecordId: recordId });
    }
    // A fallback: no model, a provider failure, or (with no bar) every answer below it.
    const code = response.fallbackCause === 'low_confidence' && answered ? 'below_bar' : response.reasonCode;
    return kept(code, { source: 'fallback', line: answered ? line?.text : undefined, confidence, model, decisionRecordId: recordId });
  } catch (err) {
    console.warn('[living-specs] publication decision failed (kept private):', (err as Error)?.message ?? err);
    return kept('fallback_error');
  }
}

function ruleOutcome(rule: DecisionVerdict<SpecPublicationKindDecision>, f: SpecPublicationFeatures, input: PublicationDecideInput, recordId: string | null): PublicationOutcome {
  const publish = rule.decision === 'publish';
  return {
    publish, source: 'rule', reasonCode: rule.reasonCode,
    reason: publish ? 'Published.' : publicationReason({ publish: false, reasonCode: rule.reasonCode, hit: f.prodDataHits[0], markFrom: input.markFrom }),
    policyVersion: input.policy?.version ?? null, confidence: null, model: null, decisionRecordId: recordId,
  };
}

/** A person published a kept-private spec anyway (R-68): label the decision that kept it. Never throws. */
export async function recordPublicationOverride(decisionRecordId: string, override: { revision: number }, by: string): Promise<void> {
  const { recordHumanOverride } = await import('@buildd/core/decision-ledger');
  await recordHumanOverride(decisionRecordId, { decision: 'publish', reason: 'published_anyway', ...override, by }, overrideActorId(by));
}
