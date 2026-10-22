/** Bounded captured UI evidence and pure checks. Authorization and artifact ownership belong to the host. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeatureParse } from '@buildd/ai-kit/decide';
import { runVerificationCheck, type VerificationObservation, type VerificationResult } from './verification-check';

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
const schema = z.object({
  schemaVersion: z.literal(1),
  subject: z.object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i).transform(s => s.toLowerCase()),
    route: bounded(240).refine(s => s.startsWith('/') && !s.startsWith('//') && !/[?#]/.test(s)),
    scenarioId: bounded(100), viewport: z.enum(['mobile', 'desktop']),
  }).strict(),
  capture: z.object({ captureId: bounded(160), capturedAt: z.iso.datetime(), snapshotRef: bounded(200), screenshotRef: bounded(200).optional() }).strict(),
  visible: z.object({
    blocks: z.array(z.object({ id: bounded(80), role: z.enum(['heading', 'status', 'body', 'label', 'hint']), text: bounded(1000), order: z.number().int().min(0).max(1000), disclosure }).strict()).max(32),
    actions: z.array(z.object({ id: bounded(80), label: bounded(120), operation: z.enum(UI_SURFACE_OPERATIONS), enabled: z.boolean(), prominence: z.enum(['primary', 'secondary', 'menu']), disclosure }).strict()).max(16),
  }).strict(),
  facts: z.object({
    prState: z.enum(['open', 'closed', 'merged', 'unknown']).optional(),
    replacementState: z.enum(['none', 'candidate', 'verified', 'unknown']).optional(),
    verificationState: z.enum(['not_started', 'pending_recapture', 'passed', 'failed', 'unknown']).optional(),
    shownVerificationState: z.enum(['pending', 'verified_pass', 'failed', 'unknown']).optional(),
  }).strict(),
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
  return runVerificationCheck({
    id, version: 1,
    invariant: id === 'ui.actions_match_state' ? 'Available UI actions and status agree with captured runtime state.' : 'A composed card is concise, actionable, and free of workflow narration.',
    subject: { kind: 'ui_surface', ref: evidence ? `${evidence.subject.commitSha}:${evidence.subject.route}:${evidence.subject.scenarioId}:${evidence.subject.viewport}` : 'unknown' },
    provenance: { flavor: 'living_spec', origin: `${UI_VERIFICATION_PROFILE}@${UI_VERIFICATION_PROFILE_VERSION}` },
    defaultSeverity: 'medium',
    evidenceRequirements: [
      { key: 'actions', need: 'complete' }, { key: 'runtimeState', need: 'complete' },
      ...(id === 'ui.card_clarity' ? [{ key: 'renderedText', need: 'complete' as const }] : []),
    ],
    executor: { kind: id === 'ui.actions_match_state' ? 'deterministic' : 'model', requires: [], run: () => {
      if (!evidence || evidence.provenance.collector === 'agent') return { verdict: 'inconclusive', observed: 'independent_capture_required', evidenceRefs: refs };
      if (!Object.values(evidence.facts).some(v => v !== 'unknown')) return { verdict: 'inconclusive', observed: 'runtime_state_unknown', evidenceRefs: refs };
      if (!evidence.visible.blocks.length && !evidence.visible.actions.length) return { verdict: 'inconclusive', observed: 'rendered_card_empty', evidenceRefs: refs };
      return { ...observation, evidenceRefs: refs };
    } },
  }, { input: evidence, evidence: evidence?.coverage ?? {}, capabilities: [], now });
}

export function runUiActionStateCheck(evidence: SurfaceEvidence, now = new Date()): VerificationResult {
  const { facts, visible } = evidence;
  const enabled = visible.actions.filter(a => a.enabled);
  let observation: VerificationObservation = { verdict: 'pass', confidence: 1, observed: 'captured_actions_match_state' };
  if (enabled.some(a => a.operation === 'merge_pr') && ['closed', 'merged'].includes(facts.prState ?? '')) {
    observation = { verdict: 'fail', confidence: 1, observed: 'terminal_pr_offers_merge' };
  } else if (facts.replacementState === 'verified' && enabled.some(a => a.operation === 'resolve_pr_closure' || a.operation === 'confirm_replacement')) {
    observation = { verdict: 'fail', confidence: 1, observed: 'verified_replacement_offers_unresolved_closure' };
  } else if (facts.verificationState === 'pending_recapture' && facts.shownVerificationState === 'verified_pass') {
    observation = { verdict: 'fail', confidence: 1, observed: 'pending_recapture_claims_verified_pass' };
  } else if (enabled.some(a => a.operation === 'other')) {
    observation = { verdict: 'unsupported', observed: 'unmapped_action_operation' };
  } else if (
    !Object.values(facts).some(v => v !== 'unknown') ||
    (enabled.some(a => a.operation === 'merge_pr') && (!facts.prState || facts.prState === 'unknown')) ||
    (enabled.some(a => a.operation === 'confirm_replacement' || a.operation === 'dismiss_replacement' || a.operation === 'resolve_pr_closure') && (!facts.replacementState || facts.replacementState === 'unknown')) ||
    (facts.shownVerificationState && facts.shownVerificationState !== 'unknown' && (!facts.verificationState || facts.verificationState === 'unknown'))
  ) observation = { verdict: 'inconclusive', observed: 'runtime_state_unknown' };
  return runUiSurfaceCheck('ui.actions_match_state', evidence, observation, now);
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
  observed: string;
}
export interface UiActionStateResult {
  verifier: { id: string; version: number };
  method: 'deterministic';
  verdict: Extract<VerificationResult['verdict'], 'pass' | 'fail' | 'inconclusive'>;
  findings: UiActionStateFinding[];
  missingFacts: string[];
}

/** `ui.action-state@1`: enabled operations and displayed claims against the supplied state. Never mutates its input. */
export function checkUiActionState(e: ParsedUiEvidence): UiActionStateResult {
  const findings: UiActionStateFinding[] = [];
  const missing = new Set<string>();
  const state = e.state ?? {};
  const fact = <K extends keyof typeof state>(k: K) => { if (state[k] === undefined) missing.add(k); return state[k]; };
  for (const a of e.actions.filter(x => x.enabled)) {
    if (a.operation === 'merge') {
      const pr = fact('pr');
      if (pr && pr !== 'open') findings.push({ kind: 'action_state_contradiction', operation: 'merge', fact: 'pr', observed: `merge offered on a ${pr} PR` });
    } else if (a.operation === 'confirm_replacement') {
      if (fact('replacementPending') === false) findings.push({ kind: 'action_state_contradiction', operation: a.operation, fact: 'replacementPending', observed: 'replacement confirmation with no replacement pending' });
    }
  }
  for (const c of e.claims) {
    const actual = fact('verification');
    if (actual && actual !== c.value) findings.push({ kind: 'claim_state_contradiction', fact: 'verification', observed: `shows ${c.value}, state is ${actual}` });
  }
  if (!e.state) for (const k of ['pr', 'verification', 'replacementPending']) missing.add(k);
  const partial = Object.values(e.coverage).some(v => v !== 'complete');
  const verdict = partial ? 'inconclusive' : findings.length ? 'fail' : missing.size ? 'inconclusive' : 'pass';
  return { verifier: { id: UI_ACTION_STATE_VERIFIER.id, version: UI_ACTION_STATE_VERIFIER.version }, method: 'deterministic', verdict, findings, missingFacts: [...missing] };
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

/** Roles whose text carries a fact the person needs: never dispensable, whatever the model says. */
const MATERIAL_ROLES = ['consequence', 'permission', 'prerequisite', 'recovery'] as const;
const SEGMENT_ROLES = ['heading', 'status', 'body', 'label', 'hint', 'narration', ...MATERIAL_ROLES] as const;

const copyId = z.string().trim().min(1).max(80);
// Strict at every level: features carry the card and the profile, never a model, endpoint, credential or prompt.
const featuresSchema = z.object({
  profile: z.object({ id: z.string().trim().min(1).max(100), version: z.number().int().min(1) }).strict(),
  segments: z.array(z.object({ id: copyId, text: z.string().trim().min(1).max(1000), role: z.enum(SEGMENT_ROLES) }).strict()).min(1).max(MAX_UI_COPY_SEGMENTS),
  actions: z.array(z.object({ id: copyId, label: z.string().trim().min(1).max(120), operation: z.enum(UI_ACTION_OPERATIONS) }).strict()).max(MAX_UI_COPY_ACTIONS),
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
};
const SURFACE_OPERATION: Record<SurfaceEvidence['visible']['actions'][number]['operation'], UiCopyFeatures['actions'][number]['operation']> = {
  merge_pr: 'merge', confirm_replacement: 'confirm_replacement', resolve_pr_closure: 'resolve_pr_closure',
  retry_visual_review: 'retry_visual_review', skip_visual_review: 'skip_visual_review', other: 'other',
  answer_question: 'answer_question', cancel: 'cancel', dismiss_replacement: 'dismiss_replacement',
  turn_off_visual_review: 'turn_off_visual_review', view_detail: 'open_details',
};

/** A stored capture as this kind's features: every block in order and every action by its operation. */
export function uiCopyFeaturesFromSurface(e: SurfaceEvidence, profile: UiCopyFeatures['profile'] = { id: 'buildd-ui', version: 1 }): UiCopyFeatures {
  return {
    profile,
    segments: [...e.visible.blocks].sort((a, b) => a.order - b.order).map((b) => ({ id: b.id, text: b.text, role: SURFACE_ROLE[b.role] })),
    actions: e.visible.actions.map((a) => ({ id: a.id, label: a.label, operation: SURFACE_OPERATION[a.operation] })),
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
      .filter((s) => segments.has(s) && !(MATERIAL_ROLES as readonly string[]).includes(segments.get(s)!.role));
    const found = [...new Set(ids((item as { actionIds?: unknown }).actionIds))].filter((a) => actions.has(a))
      .map((a) => ({ id: a, operation: actions.get(a)!.operation }));
    if (kind === 'unclear_action' ? !found.length : !segmentIds.length) continue;
    out.push({ kind: kind as UiCopyFindingKind, ...(segmentIds.length ? { segmentIds } : {}), ...(found.length ? { actions: found } : {}) });
  }
  return out;
}
