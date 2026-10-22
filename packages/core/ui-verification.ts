/** Bounded captured UI evidence and pure checks. Authorization and artifact ownership belong to the host. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeatureParse } from '@buildd/ai-kit/decide';
import { runVerificationCheck, type VerificationObservation, type VerificationResult, type VerificationVerdict } from './verification-check';

export const UI_VERIFICATION_PROFILE = 'buildd.enterprise' as const;
export const UI_VERIFICATION_PROFILE_VERSION = 1;
export const UI_VERIFIER_IDS = ['ui.actions_match_state', 'ui.card_clarity'] as const;
export type UiVerifierId = (typeof UI_VERIFIER_IDS)[number];
/**
 * What an action does, as its owning component declares it (`data-verify-action`), never read off its label.
 * `dismiss_replacement` rejects a suggested replacement without resolving the closure; `view_detail` only opens
 * something to look at; `answer_question` answers a parked worker; `cancel` closes a form; `other` is undeclared.
 */
export const UI_SURFACE_OPERATIONS = [
  'merge_pr', 'confirm_replacement', 'dismiss_replacement', 'resolve_pr_closure', 'retry_visual_review', 'skip_visual_review',
  'turn_off_visual_review', 'answer_question', 'view_detail', 'cancel', 'other',
] as const;
const bounded = (max: number) => z.string().trim().min(1).max(max);
const coverage = z.enum(['complete', 'partial', 'absent']);
const disclosure = z.enum(['visible', 'collapsed']);
/**
 * Roles whose text carries a fact the person needs: what an action does to the work (`consequence`), who may
 * take it (`permission`), what must hold first (`prerequisite`) and how to get out of a failure (`recovery`).
 * A copy check never reports one dispensable, whatever the model says.
 */
export const UI_MATERIAL_ROLES = ['consequence', 'permission', 'prerequisite', 'recovery'] as const;
/** What a `data-verify-block` may declare. The owning component says it; nothing infers it from the words. */
export const UI_SURFACE_BLOCK_ROLES = ['heading', 'status', 'body', 'label', 'hint', ...UI_MATERIAL_ROLES] as const;
const surfaceFacts = z.object({
  prState: z.enum(['open', 'closed', 'merged', 'unknown']).optional(),
  replacementState: z.enum(['none', 'candidate', 'verified', 'unknown']).optional(),
  verificationState: z.enum(['not_started', 'pending_recapture', 'passed', 'failed', 'unknown']).optional(),
  shownVerificationState: z.enum(['pending', 'verified_pass', 'failed', 'unknown']).optional(),
}).strict();
const schema = z.object({
  schemaVersion: z.literal(1),
  subject: z.object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i).transform(s => s.toLowerCase()),
    route: bounded(240).refine(s => s.startsWith('/') && !s.startsWith('//') && !/[?#]/.test(s)),
    scenarioId: bounded(100), viewport: z.enum(['mobile', 'desktop']),
  }).strict(),
  capture: z.object({ captureId: bounded(160), capturedAt: z.iso.datetime(), snapshotRef: bounded(200), screenshotRef: bounded(200).optional() }).strict(),
  visible: z.object({
    blocks: z.array(z.object({ id: bounded(80), role: z.enum(UI_SURFACE_BLOCK_ROLES), text: bounded(1000), order: z.number().int().min(0).max(1000), disclosure }).strict()).max(32),
    actions: z.array(z.object({ id: bounded(80), label: bounded(120), operation: z.enum(UI_SURFACE_OPERATIONS), enabled: z.boolean(), prominence: z.enum(['primary', 'secondary', 'menu']), disclosure }).strict()).max(16),
  }).strict(),
  facts: surfaceFacts,
  provenance: z.object({ collector: z.enum(['runner', 'visual_auditor', 'agent']), collectorVersion: bounded(80), reportedVia: z.enum(['runner', 'task_token', 'server']), factVersion: bounded(80) }).strict(),
  coverage: z.object({ renderedText: coverage, actions: coverage, runtimeState: coverage, screenshot: coverage }).strict(),
}).strict();

export type SurfaceEvidence = z.infer<typeof schema>;

/** Reject before outbound use or storage; do not truncate away a leaked credential or missing context. */
export function parseSurfaceEvidence(input: unknown, opts: { secrets?: readonly string[] } = {}): FeatureParse<SurfaceEvidence> {
  let raw: string;
  try { raw = JSON.stringify(input); } catch { return { ok: false, message: 'invalid_surface_evidence' }; }
  if (!raw || raw.length > 64_000) return { ok: false, message: 'surface_evidence_too_large' };
  const secretPattern = /\bBearer\s+[^\s"\\]+|\b(?:sk-|ghp_|github_pat_|bld_)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s"\\]{8,}/i;
  let sensitive = secretPattern.test(raw);
  // Check decoded values too: JSON escaping must not hide a tab-separated bearer or a quoted secret.
  JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === 'string' && (secretPattern.test(value) || opts.secrets?.some(s => s.length >= 8 && value.includes(s)))) sensitive = true;
    return value;
  });
  if (sensitive) return { ok: false, message: 'sensitive_surface_evidence' };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'invalid_surface_evidence' };
  const e = parsed.data;
  const ids = [...e.visible.blocks, ...e.visible.actions].map(x => x.id);
  if (new Set(ids).size !== ids.length) return { ok: false, message: 'duplicate_surface_element' };
  return { ok: true, features: e };
}

function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  if (input && typeof input === 'object') return `{${Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(input);
}

/** Cache identity includes the entire normalized capture; callers separately scope caches to tenancy. */
export function uiVerificationFingerprint(evidence: SurfaceEvidence, verifierId: UiVerifierId, promptFingerprint = 'deterministic'): string {
  return createHash('sha256').update(canonical({ evidence, verifierId, verifierVersion: 1, profile: UI_VERIFICATION_PROFILE, profileVersion: UI_VERIFICATION_PROFILE_VERSION, promptFingerprint })).digest('hex');
}

/** Shared result envelope; missing or self-reported evidence cannot produce an authoritative observation. */
export function runUiSurfaceCheck(id: UiVerifierId, evidence: SurfaceEvidence | null, observation: VerificationObservation, now = new Date()): VerificationResult {
  const refs = evidence ? [
    { kind: 'surface_snapshot', ref: evidence.capture.snapshotRef },
    ...(evidence.capture.screenshotRef ? [{ kind: 'screenshot', ref: evidence.capture.screenshotRef }] : []),
  ] : [];
  const actionState = id === 'ui.actions_match_state';
  return runVerificationCheck({
    id, version: 1,
    invariant: actionState ? 'Available UI actions and status agree with captured runtime state.' : 'A composed card is concise, actionable, and free of workflow narration.',
    subject: { kind: 'ui_surface', ref: evidence ? `${evidence.subject.commitSha}:${evidence.subject.route}:${evidence.subject.scenarioId}:${evidence.subject.viewport}` : 'unknown' },
    provenance: { flavor: 'living_spec', origin: `${UI_VERIFICATION_PROFILE}@${UI_VERIFICATION_PROFILE_VERSION}` },
    defaultSeverity: 'medium',
    // Copy is judged on the words and the actions; runtime facts are context it may use, never a precondition.
    evidenceRequirements: actionState
      ? [{ key: 'actions', need: 'complete' }, { key: 'runtimeState', need: 'complete' }]
      : [{ key: 'renderedText', need: 'complete' }, { key: 'actions', need: 'complete' }],
    executor: { kind: actionState ? 'deterministic' : 'model', requires: [], run: () => {
      if (!evidence || evidence.provenance.collector === 'agent') return { verdict: 'inconclusive', observed: 'independent_capture_required', evidenceRefs: refs };
      if (actionState && !Object.values(evidence.facts).some(v => v !== 'unknown')) return { verdict: 'inconclusive', observed: 'runtime_state_unknown', evidenceRefs: refs };
      if (!evidence.visible.blocks.length && !evidence.visible.actions.length) return { verdict: 'inconclusive', observed: 'rendered_card_empty', evidenceRefs: refs };
      return { ...observation, evidenceRefs: refs };
    } },
  }, { input: evidence, evidence: evidence?.coverage ?? {}, capabilities: [], now });
}

type SurfaceFacts = SurfaceEvidence['facts'];
type SurfaceOperation = (typeof UI_SURFACE_OPERATIONS)[number];
type SurfaceFact = 'prState' | 'replacementState' | 'verificationState';
/** What a card shows about verification. `not_verified` exists only on portable evidence (a claim of `unverified`). */
type ShownVerification = Exclude<NonNullable<SurfaceFacts['shownVerificationState']>, 'unknown'> | 'not_verified';
const SHOWN_MATCHES: Record<ShownVerification, NonNullable<SurfaceFacts['verificationState']>> = {
  verified_pass: 'passed', failed: 'failed', pending: 'pending_recapture', not_verified: 'not_started',
};

export interface UiSurfaceFinding {
  kind: 'action_state_contradiction' | 'claim_state_contradiction';
  code: 'terminal_pr_offers_merge' | 'verified_replacement_offers_unresolved_closure' | 'no_replacement_offers_confirmation' | 'pending_recapture_claims_verified_pass' | 'shown_verification_contradicts_state';
  fact: SurfaceFact;
  /** The captured elements the finding is about (`data-verify-action` ids). */
  actionIds?: string[];
  operation?: SurfaceOperation;
  observed: string;
}
export interface UiSurfaceActionState {
  findings: UiSurfaceFinding[];
  /** Facts an enabled action or a shown status needs that the capture did not supply. */
  missingFacts: SurfaceFact[];
  /** Enabled actions whose operation is undeclared (`other`): never approved by their label. */
  unmapped: string[];
}

const known = <T>(v: T | 'unknown' | undefined): v is T => v !== undefined && v !== 'unknown';

/**
 * `ui.actions_match_state`, the one deterministic action/state engine: every enabled action and every shown
 * verification status against the supplied runtime facts. Reads operations and facts only, never labels or prose.
 * Both evidence shapes go through it (runUiActionStateCheck for a stored capture, checkUiActionState for portable).
 */
export function surfaceActionState(
  facts: SurfaceFacts,
  actions: ReadonlyArray<{ id: string; operation: SurfaceOperation; enabled: boolean }>,
  shown: readonly ShownVerification[],
): UiSurfaceActionState {
  const findings: UiSurfaceFinding[] = [];
  const missing = new Set<SurfaceFact>();
  const enabled = actions.filter(a => a.enabled);
  const of = (...ops: SurfaceOperation[]) => enabled.filter(a => ops.includes(a.operation));
  const finding = (f: Omit<UiSurfaceFinding, 'actionIds' | 'operation'>, on: typeof enabled = []) =>
    findings.push({ ...f, ...(on.length ? { actionIds: on.map(a => a.id), operation: on[0]!.operation } : {}) });

  const merges = of('merge_pr');
  if (merges.length && !known(facts.prState)) missing.add('prState');
  if (merges.length && (facts.prState === 'closed' || facts.prState === 'merged')) {
    finding({ kind: 'action_state_contradiction', code: 'terminal_pr_offers_merge', fact: 'prState', observed: `merge offered on a ${facts.prState} PR` }, merges);
  }
  if (of('confirm_replacement', 'dismiss_replacement', 'resolve_pr_closure').length && !known(facts.replacementState)) missing.add('replacementState');
  const closure = of('resolve_pr_closure', 'confirm_replacement');
  if (facts.replacementState === 'verified' && closure.length) {
    finding({ kind: 'action_state_contradiction', code: 'verified_replacement_offers_unresolved_closure', fact: 'replacementState', observed: 'closure still offered after its replacement was verified' }, closure);
  }
  const confirms = of('confirm_replacement');
  if (facts.replacementState === 'none' && confirms.length) {
    finding({ kind: 'action_state_contradiction', code: 'no_replacement_offers_confirmation', fact: 'replacementState', observed: 'replacement confirmation with no replacement pending' }, confirms);
  }
  for (const s of new Set(shown)) {
    if (!known(facts.verificationState)) { missing.add('verificationState'); continue; }
    if (SHOWN_MATCHES[s] === facts.verificationState) continue;
    const pending = s === 'verified_pass' && facts.verificationState === 'pending_recapture';
    finding({ kind: 'claim_state_contradiction', code: pending ? 'pending_recapture_claims_verified_pass' : 'shown_verification_contradicts_state', fact: 'verificationState', observed: `shows ${s}, state is ${facts.verificationState}` });
  }
  if (!Object.values(facts).some(known)) for (const k of ['prState', 'replacementState', 'verificationState'] as const) missing.add(k);
  return { findings, missingFacts: [...missing], unmapped: of('other').map(a => a.id) };
}

const shownOf = (facts: SurfaceFacts): ShownVerification[] => (known(facts.shownVerificationState) ? [facts.shownVerificationState] : []);

/** Verdict precedence: a contradiction fails; an undeclared operation is unsupported; a missing fact is unknown. */
function actionStateObservation(r: UiSurfaceActionState): VerificationObservation {
  if (r.findings.length) return { verdict: 'fail', confidence: 1, observed: r.findings[0]!.code };
  if (r.unmapped.length) return { verdict: 'unsupported', observed: 'unmapped_action_operation' };
  if (r.missingFacts.length) return { verdict: 'inconclusive', observed: 'runtime_state_unknown' };
  return { verdict: 'pass', confidence: 1, observed: 'captured_actions_match_state' };
}

export function runUiActionStateCheck(evidence: SurfaceEvidence, now = new Date()): VerificationResult {
  const r = surfaceActionState(evidence.facts, evidence.visible.actions, shownOf(evidence.facts));
  return runUiSurfaceCheck('ui.actions_match_state', evidence, actionStateObservation(r), now);
}

/*
 * The registry-facing form of the same checks (spec "Registered requirement
 * verification" r1): `ui.action-state@1` over a portable UI evidence snapshot.
 * The snapshot names actions by semantic operation and carries state facts
 * supplied independently of the text; the label and prose are never read for
 * meaning. Pixels are a separate capability, present only with a screenshot.
 */

export const UI_ACTION_OPERATIONS = ['merge', 'confirm_replacement', 'dismiss_replacement', 'resolve_pr_closure', 'retry_visual_review', 'skip_visual_review', 'turn_off_visual_review', 'answer_question', 'cancel', 'open_details', 'other'] as const;
export type UiActionOperation = (typeof UI_ACTION_OPERATIONS)[number];
export type UiEvidenceCapability = 'text' | 'actions' | 'state' | 'pixels';

const prominence = z.enum(['primary', 'secondary', 'menu']);
const uiEvidenceSchema = z.object({
  route: bounded(240).refine(s => s.startsWith('/') && !s.startsWith('//') && !/[?#]/.test(s)),
  scenario: bounded(100),
  codeSha: z.string().regex(/^[a-f0-9]{40}$/i),
  captureSha: z.string().regex(/^[a-f0-9]{40}$/i).optional(),
  text: z.array(z.object({ text: bounded(1000), prominence }).strict()).max(32),
  actions: z.array(z.object({ label: bounded(120), operation: z.enum(UI_ACTION_OPERATIONS), enabled: z.boolean(), prominence }).strict()).max(16),
  claims: z.array(z.object({ kind: z.literal('verification'), value: z.enum(['verified', 'unverified', 'pending', 'failed']) }).strict()).max(8).default([]),
  state: z.object({
    pr: z.enum(['open', 'closed', 'merged']).optional(),
    verification: z.enum(['verified', 'unverified', 'pending', 'failed']).optional(),
    replacementPending: z.boolean().optional(),
  }).strict().optional(),
  coverage: z.object({ text: coverage, actions: coverage, state: coverage }).strict(),
  pixels: z.object({ screenshotArtifactId: bounded(200) }).strict().optional(),
  collection: z.object({ ok: z.boolean() }).strict().optional(),
}).strict();

export type UiEvidence = z.input<typeof uiEvidenceSchema>;
export type ParsedUiEvidence = z.output<typeof uiEvidenceSchema>;

export function parseUiEvidence(input: unknown): { ok: true; evidence: ParsedUiEvidence; capabilities: UiEvidenceCapability[] } | { ok: false; reason: string } {
  // The same secret screen as a stored capture: refuse before anything reads it.
  const screened = parseSurfaceEvidence(input);
  if (!screened.ok && screened.message !== 'invalid_surface_evidence') return { ok: false, reason: screened.message };
  const parsed = uiEvidenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid_ui_evidence' };
  const e = parsed.data;
  const capabilities: UiEvidenceCapability[] = ['text', 'actions'];
  if (e.state) capabilities.push('state');
  if (e.pixels) capabilities.push('pixels');
  return { ok: true, evidence: e, capabilities };
}

export const UI_ACTION_STATE_VERIFIER = {
  id: 'ui.action-state', version: 1, method: 'deterministic', evidence: ['ui.text', 'ui.actions', 'ui.state'],
} as const;

export interface UiActionStateFinding {
  kind: 'action_state_contradiction' | 'claim_state_contradiction';
  fact: 'pr' | 'verification' | 'replacementPending';
  operation?: UiActionOperation;
  /** The actions it is about, by their position on the card (`a1` is the first). */
  actionIds?: string[];
  code: UiSurfaceFinding['code'];
  observed: string;
}
export interface UiActionStateResult {
  verifier: { id: string; version: number };
  method: 'deterministic';
  verdict: Extract<VerificationResult['verdict'], 'pass' | 'fail' | 'inconclusive' | 'unsupported'>;
  findings: UiActionStateFinding[];
  missingFacts: string[];
}

const PORTABLE_FACT: Record<SurfaceFact, UiActionStateFinding['fact']> = { prState: 'pr', replacementState: 'replacementPending', verificationState: 'verification' };
const TO_SURFACE_OPERATION: Record<UiActionOperation, SurfaceOperation> = {
  merge: 'merge_pr', open_details: 'view_detail', confirm_replacement: 'confirm_replacement', dismiss_replacement: 'dismiss_replacement',
  resolve_pr_closure: 'resolve_pr_closure', retry_visual_review: 'retry_visual_review', skip_visual_review: 'skip_visual_review',
  turn_off_visual_review: 'turn_off_visual_review', answer_question: 'answer_question', cancel: 'cancel', other: 'other',
};
const TO_PORTABLE_OPERATION = Object.fromEntries(Object.entries(TO_SURFACE_OPERATION).map(([k, v]) => [v, k])) as Record<SurfaceOperation, UiActionOperation>;
const TO_SURFACE_VERIFICATION = { verified: 'passed', unverified: 'not_started', pending: 'pending_recapture', failed: 'failed' } as const;
const TO_SHOWN: Record<ParsedUiEvidence['claims'][number]['value'], ShownVerification> = { verified: 'verified_pass', unverified: 'not_verified', pending: 'pending', failed: 'failed' };
const TO_ROLE = { primary: 'status', secondary: 'body', menu: 'hint' } as const;

const portableFacts = (e: ParsedUiEvidence): SurfaceFacts => ({
  ...(e.state?.pr ? { prState: e.state.pr } : {}),
  ...(e.state?.verification ? { verificationState: TO_SURFACE_VERIFICATION[e.state.verification] } : {}),
  ...(e.state?.replacementPending !== undefined ? { replacementState: e.state.replacementPending ? 'candidate' : 'none' } : {}),
});
const portableActions = (e: ParsedUiEvidence) => e.actions.map((a, i) => ({ id: `a${i + 1}`, operation: TO_SURFACE_OPERATION[a.operation], enabled: a.enabled }));

/** `ui.action-state@1` on portable evidence: the same engine as a stored capture (surfaceActionState). Never mutates its input. */
export function checkUiActionState(e: ParsedUiEvidence): UiActionStateResult {
  const r = surfaceActionState(portableFacts(e), portableActions(e), e.claims.map(c => TO_SHOWN[c.value]));
  const partial = Object.values(e.coverage).some(v => v !== 'complete');
  const observation = actionStateObservation(r);
  return {
    verifier: { id: UI_ACTION_STATE_VERIFIER.id, version: UI_ACTION_STATE_VERIFIER.version }, method: 'deterministic',
    verdict: partial ? 'inconclusive' : observation.verdict as UiActionStateResult['verdict'],
    findings: r.findings.map(f => ({
      kind: f.kind, fact: PORTABLE_FACT[f.fact], code: f.code, observed: f.observed,
      ...(f.operation ? { operation: TO_PORTABLE_OPERATION[f.operation] } : {}), ...(f.actionIds ? { actionIds: f.actionIds } : {}),
    })),
    missingFacts: r.missingFacts.map(f => PORTABLE_FACT[f]),
  };
}

/**
 * Portable evidence as the canonical stored capture, so one evaluator judges both. Every part of it is kept:
 * text in order (as blocks `s1`.., prominence as role), actions in order (`a1`.., operation, label, enabled,
 * prominence), the supplied facts, per-part coverage and the screenshot. What the canonical form cannot hold
 * (more than one shown verification claim, or a claim of `unverified`) is refused, never dropped.
 * `collection` is not carried: a collector's own success report is never evidence.
 */
export function surfaceFromUiEvidence(e: ParsedUiEvidence, opts: { independent: boolean }):
{ ok: true; evidence: SurfaceEvidence } | { ok: false; reason: 'claims_not_representable' } {
  if (e.claims.length > 1 || e.claims.some(c => c.value === 'unverified')) return { ok: false, reason: 'claims_not_representable' };
  const facts = portableFacts(e);
  const shown = e.claims[0] ? TO_SHOWN[e.claims[0].value] as Exclude<ShownVerification, 'not_verified'> : undefined;
  return { ok: true, evidence: {
    schemaVersion: 1,
    subject: { commitSha: (e.captureSha ?? e.codeSha).toLowerCase(), route: e.route, scenarioId: e.scenario, viewport: 'desktop' },
    capture: { captureId: `ui-evidence:${e.codeSha.toLowerCase()}`, capturedAt: new Date(0).toISOString(), snapshotRef: `ui-evidence:${e.codeSha.toLowerCase()}`, ...(e.pixels ? { screenshotRef: e.pixels.screenshotArtifactId } : {}) },
    visible: {
      blocks: e.text.map((t, i) => ({ id: `s${i + 1}`, role: TO_ROLE[t.prominence], text: t.text, order: i, disclosure: 'visible' as const })),
      actions: e.actions.map((a, i) => ({ id: `a${i + 1}`, label: a.label, operation: TO_SURFACE_OPERATION[a.operation], enabled: a.enabled, prominence: a.prominence, disclosure: 'visible' as const })),
    },
    facts: { ...facts, ...(shown ? { shownVerificationState: shown } : {}) },
    provenance: { collector: opts.independent ? 'runner' : 'agent', collectorVersion: 'ui-evidence@1', reportedVia: 'runner', factVersion: e.state ? 'ui-evidence@1' : 'none' },
    coverage: { renderedText: e.coverage.text, actions: e.coverage.actions, runtimeState: e.coverage.state, screenshot: e.pixels ? 'complete' : 'absent' },
  } };
}

export interface EvaluationCase { evidence: ParsedUiEvidence; expected: 'pass' | 'fail'; confirmedBy: { kind: 'person'; id: string } }

/** Only a person's confirmed correction becomes an evaluation case; an agent's edit is not ground truth. */
export function evaluationCaseFromCorrection(input: { evidence: ParsedUiEvidence; expected: 'pass' | 'fail'; confirmedBy: { kind: string; id: string } | null }): EvaluationCase | null {
  if (input.confirmedBy?.kind !== 'person' || !input.confirmedBy.id) return null;
  return { evidence: input.evidence, expected: input.expected, confirmedBy: { kind: 'person', id: input.confirmedBy.id } };
}

/** A verifier version is promoted only as a newer version of the same verifier that reproduces every confirmed case. */
export function canPromoteVerifier(input: {
  current: { id: string; version: number };
  candidate: { id: string; version: number };
  results: ReadonlyArray<{ case: EvaluationCase; verdict: string }>;
}): { ok: true } | { ok: false; reason: 'not_a_new_version' | 'no_evaluation_cases' | 'regressed_cases' } {
  if (input.candidate.id !== input.current.id || input.candidate.version <= input.current.version) return { ok: false, reason: 'not_a_new_version' };
  if (!input.results.length) return { ok: false, reason: 'no_evaluation_cases' };
  if (input.results.some(r => r.verdict !== r.case.expected)) return { ok: false, reason: 'regressed_cases' };
  return { ok: true };
}

/*
 * The `buildd.ui_copy` decision kind's features, vocabulary and findings
 * (./decision-kind-ui-copy holds the prompts and the broker binding).
 */

/** A card past this many segments is refused, never truncated: a judgment of part of a card is not a judgment of the card. */
export const MAX_UI_COPY_SEGMENTS = 32;
export const MAX_UI_COPY_ACTIONS = 16;
export const UI_COPY_DECISIONS = ['concise', 'needs_edit', 'insufficient_evidence'] as const;
export type UiCopyDecision = (typeof UI_COPY_DECISIONS)[number];

const SEGMENT_ROLES = ['heading', 'status', 'body', 'label', 'hint', 'narration', ...UI_MATERIAL_ROLES] as const;

const copyId = z.string().trim().min(1).max(80);
// Strict at every level: features carry the card and the profile, never a model, endpoint, credential or prompt.
const featuresSchema = z.object({
  profile: z.object({ id: z.string().trim().min(1).max(100), version: z.number().int().min(1) }).strict(),
  segments: z.array(z.object({ id: copyId, text: z.string().trim().min(1).max(1000), role: z.enum(SEGMENT_ROLES) }).strict()).min(1).max(MAX_UI_COPY_SEGMENTS),
  actions: z.array(z.object({ id: copyId, label: z.string().trim().min(1).max(120), operation: z.enum(UI_ACTION_OPERATIONS) }).strict()).max(MAX_UI_COPY_ACTIONS),
  // The runtime state the card describes, as the capture was supplied it (never read off the page), and its version.
  state: z.object({ factVersion: z.string().trim().min(1).max(80), facts: surfaceFacts }).strict().optional(),
  // The requirement being judged, so the card is read against what it is for.
  criterion: z.object({ id: z.string().regex(/^(R|AC)-\d{1,4}$/), text: z.string().trim().min(1).max(2000) }).strict().optional(),
}).strict();

export type UiCopyFeatures = z.infer<typeof featuresSchema>;

export function parseUiCopyFeatures(input: unknown): FeatureParse<UiCopyFeatures> {
  const parsed = featuresSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'invalid_ui_copy_features' };
  const ids = [...parsed.data.segments, ...parsed.data.actions].map((x) => x.id);
  if (new Set(ids).size !== ids.length) return { ok: false, message: 'duplicate_ui_copy_element' };
  return { ok: true, features: parsed.data };
}

const SURFACE_ROLE: Record<SurfaceEvidence['visible']['blocks'][number]['role'], UiCopyFeatures['segments'][number]['role']> = {
  heading: 'heading', status: 'status', body: 'body', label: 'label', hint: 'hint',
  consequence: 'consequence', permission: 'permission', prerequisite: 'prerequisite', recovery: 'recovery',
};
/**
 * A stored capture as this kind's features: every block in order by its declared role, every action by its
 * operation, the supplied runtime facts when the capture had any, and the criterion when the caller names one.
 */
export function uiCopyFeaturesFromSurface(
  e: SurfaceEvidence,
  profile: UiCopyFeatures['profile'] = { id: 'buildd-ui', version: 1 },
  criterion?: UiCopyFeatures['criterion'],
): UiCopyFeatures {
  const known = Object.keys(e.facts).length > 0 && e.provenance.factVersion !== 'none';
  return {
    profile,
    segments: [...e.visible.blocks].sort((a, b) => a.order - b.order).map((b) => ({ id: b.id, text: b.text, role: SURFACE_ROLE[b.role] })),
    actions: e.visible.actions.map((a) => ({ id: a.id, label: a.label, operation: TO_PORTABLE_OPERATION[a.operation] })),
    ...(known ? { state: { factVersion: e.provenance.factVersion, facts: { ...e.facts } } } : {}),
    ...(criterion ? { criterion: { id: criterion.id, text: criterion.text } } : {}),
  };
}

/** The verification verdict a ui_copy decision stands for. */
export const UI_COPY_VERDICT: Record<UiCopyDecision, 'pass' | 'fail' | 'inconclusive'> = {
  concise: 'pass', needs_edit: 'fail', insufficient_evidence: 'inconclusive',
};

export type UiCopyFindingKind = 'repetition' | 'unclear_action' | 'process_narration';
export interface UiCopyFinding {
  kind: UiCopyFindingKind;
  segmentIds?: string[];
  actions?: Array<{ id: string; operation: UiCopyFeatures['actions'][number]['operation'] }>;
}
const FINDING_KINDS: readonly string[] = ['repetition', 'unclear_action', 'process_narration'];

/**
 * A model's structured answer as findings on the supplied card. Only this
 * verifier's three kinds survive (action state belongs to the deterministic
 * verifier); ids the card does not hold are dropped, never invented; a
 * material segment is never reported dispensable; an action is reported by its
 * own operation. Findings carry ids, never replacement text.
 */
export function uiCopyFindings(raw: unknown, features: UiCopyFeatures): UiCopyFinding[] {
  const list = (raw as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  const segments = new Map(features.segments.map((s) => [s.id, s]));
  const actions = new Map(features.actions.map((a) => [a.id, a]));
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const out: UiCopyFinding[] = [];
  for (const item of list) {
    const kind = (item as { kind?: unknown })?.kind;
    if (typeof kind !== 'string' || !FINDING_KINDS.includes(kind)) continue;
    const segmentIds = [...new Set(ids((item as { segmentIds?: unknown }).segmentIds))]
      .filter((s) => segments.has(s) && !(UI_MATERIAL_ROLES as readonly string[]).includes(segments.get(s)!.role));
    const found = [...new Set(ids((item as { actionIds?: unknown }).actionIds))].filter((a) => actions.has(a))
      .map((a) => ({ id: a, operation: actions.get(a)!.operation }));
    if (kind === 'unclear_action' ? !found.length : !segmentIds.length) continue;
    out.push({ kind: kind as UiCopyFindingKind, ...(segmentIds.length ? { segmentIds } : {}), ...(found.length ? { actions: found } : {}) });
  }
  return out;
}

/** A `buildd.ui_copy` answer as the evaluator receives it. `ok` only for a model answer whose decision record was persisted. */
export type UiModelDecision =
  | { ok: true; decision: UiCopyDecision; raw: unknown; confidence?: number | null; reasonCode?: string; evaluator: { model: string; promptFingerprint: string; policyVersion: string; decisionId: string } }
  | { ok: false; error: string };

export interface UiSurfaceOutcome {
  verdict: VerificationVerdict;
  /** How it was actually judged: a model answer that could not be had is a fallback, never a model result. */
  method: 'deterministic' | 'model' | 'fallback';
  coverage: 'complete' | 'partial' | 'absent';
  /** Linked to the capture's own element ids. */
  findings: Array<Record<string, unknown>>;
  /** What the evaluator actually looked at. Text-only judgment never lists pixels. */
  inspected: UiEvidenceCapability[];
  result: VerificationResult;
  evaluator?: Extract<UiModelDecision, { ok: true }>['evaluator'];
}

/** The copy axes a `revise_<axis>..` reason names, as this verifier's finding kinds. */
const AXIS_FINDING: ReadonlyArray<[string, UiCopyFindingKind]> = [['action_clarity', 'unclear_action'], ['workflow_narration', 'process_narration'], ['repetition', 'repetition']];

/**
 * The one evaluator for registered UI checks, over a canonical stored capture. Production (a stored capture)
 * and portable acceptance evidence (surfaceFromUiEvidence) both come through here, so they cannot diverge.
 * `decide` is the single model call for a copy check; the host supplies it (the decision broker in production).
 */
export async function evaluateUiSurface(
  id: UiVerifierId,
  e: SurfaceEvidence,
  ctx: { profile?: UiCopyFeatures['profile']; criterion?: UiCopyFeatures['criterion']; now?: Date } = {},
  decide?: (features: UiCopyFeatures) => Promise<UiModelDecision>,
): Promise<UiSurfaceOutcome> {
  const now = ctx.now ?? new Date();
  if (id === 'ui.actions_match_state') {
    const r = surfaceActionState(e.facts, e.visible.actions, shownOf(e.facts));
    const result = runUiSurfaceCheck(id, e, actionStateObservation(r), now);
    const findings: Array<Record<string, unknown>> = [
      ...r.findings.map(f => ({ ...f })),
      ...(r.unmapped.length ? [{ kind: 'unmapped_action', actionIds: r.unmapped }] : []),
      ...(r.missingFacts.length ? [{ kind: 'missing_facts', facts: r.missingFacts }] : []),
    ];
    const partial = result.evidenceShortfall.length > 0 || r.missingFacts.length > 0 || [e.coverage.renderedText, e.coverage.actions, e.coverage.runtimeState].some(c => c !== 'complete');
    return { verdict: result.verdict, method: 'deterministic', coverage: partial ? 'partial' : 'complete', findings, inspected: ['text', 'actions', 'state'], result };
  }
  const fallback = (result: VerificationResult, finding: Record<string, unknown>): UiSurfaceOutcome =>
    ({ verdict: 'inconclusive', method: 'fallback', coverage: 'partial', findings: [finding], inspected: [], result: { ...result, verdict: 'inconclusive' } });
  const preflight = runUiSurfaceCheck(id, e, { verdict: 'inconclusive', observed: 'model_judgment_required' }, now);
  if (preflight.evidenceShortfall.length || preflight.observed !== 'model_judgment_required') {
    return fallback(preflight, { kind: 'partial_evidence', reason: preflight.reason ?? preflight.observed });
  }
  const features = uiCopyFeaturesFromSurface(e, ctx.profile, ctx.criterion);
  const valid = parseUiCopyFeatures(features);
  if (!valid.ok) return fallback(preflight, { kind: 'invalid_evidence', reason: valid.message });
  const unavailable = (reason: string) => fallback(runUiSurfaceCheck(id, e, { verdict: 'inconclusive', observed: reason }, now), { kind: 'evaluator_unavailable', reason });
  if (!decide) return unavailable('no_provider');
  const answer = await decide(features);
  if (!answer.ok) return unavailable(answer.error);
  const verdict = UI_COPY_VERDICT[answer.decision] ?? 'inconclusive';
  const result = runUiSurfaceCheck(id, e, { verdict, confidence: answer.confidence ?? undefined, observed: answer.reasonCode ?? answer.decision }, now);
  // Structured findings when the answer carries them; else the card-level axes the decision failed on.
  let findings: Array<Record<string, unknown>> = uiCopyFindings(answer.raw, features) as unknown as Array<Record<string, unknown>>;
  if (!findings.length && verdict === 'fail' && answer.reasonCode?.startsWith('revise_')) {
    const segmentIds = features.segments.filter(x => !(UI_MATERIAL_ROLES as readonly string[]).includes(x.role)).map(x => x.id);
    findings = AXIS_FINDING.filter(([axis]) => answer.reasonCode!.includes(axis)).map(([axis, kind]) => ({
      kind, axis, scope: 'card',
      ...(kind === 'unclear_action' ? { actions: features.actions.map(a => ({ id: a.id, operation: a.operation })) } : { segmentIds }),
    }));
  }
  return {
    verdict, method: 'model', coverage: verdict === 'inconclusive' ? 'partial' : 'complete', findings,
    inspected: features.state ? ['text', 'actions', 'state'] : ['text', 'actions'], result, evaluator: answer.evaluator,
  };
}
