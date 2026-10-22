/** Bounded captured UI evidence and pure checks. Authorization and artifact ownership belong to the host. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeatureParse } from '@buildd/ai-kit/decide';
import { runVerificationCheck, type VerificationObservation, type VerificationResult } from './verification-check';

export const UI_VERIFICATION_PROFILE = 'buildd.enterprise' as const;
export const UI_VERIFICATION_PROFILE_VERSION = 1;
export const UI_VERIFIER_IDS = ['ui.actions_match_state', 'ui.card_clarity'] as const;
export type UiVerifierId = (typeof UI_VERIFIER_IDS)[number];
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
    actions: z.array(z.object({ id: bounded(80), label: bounded(120), operation: z.enum(['merge_pr', 'confirm_replacement', 'resolve_pr_closure', 'retry_visual_review', 'skip_visual_review', 'other']), enabled: z.boolean(), prominence: z.enum(['primary', 'secondary', 'menu']), disclosure }).strict()).max(16),
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
    (enabled.some(a => a.operation === 'confirm_replacement' || a.operation === 'resolve_pr_closure') && (!facts.replacementState || facts.replacementState === 'unknown')) ||
    (facts.shownVerificationState && facts.shownVerificationState !== 'unknown' && (!facts.verificationState || facts.verificationState === 'unknown'))
  ) observation = { verdict: 'inconclusive', observed: 'runtime_state_unknown' };
  return runUiSurfaceCheck('ui.actions_match_state', evidence, observation, now);
}
