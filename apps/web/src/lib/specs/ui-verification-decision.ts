/** Production adapter. The coordinator authorizes captures, loads owned artifacts and persists spec outcomes. */
import type { DecisionReceipt } from '@buildd/ai-kit/decide';
import { UI_COPY_VERDICT, uiCopyFeaturesFromSurface, uiCopyKind } from '@buildd/core/decision-kind-ui-copy';
import { runBuilddDecision, type BuilddDecisionDeps, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import { parseSurfaceEvidence, runUiActionStateCheck, runUiSurfaceCheck, uiVerificationFingerprint, type UiVerifierId } from '@buildd/core/ui-verification';
import type { VerificationResult } from '@buildd/core/verification-check';

export interface UiVerificationDeps extends BuilddDecisionDeps {
  secrets?: readonly string[];
  nowDate?: () => Date;
}
export interface UiVerificationExecution {
  result: VerificationResult;
  method: 'deterministic' | 'model' | 'fallback';
  decisionKind: string | null;
  decisionRecordIds: string[];
  receipts: DecisionReceipt[];
  inputFingerprint: string | null;
}

/** Model outcomes intentionally have no persistent-cache lookup: the broker resolves current team policy on every run. */
export async function executeUiVerification(id: UiVerifierId, input: unknown, scope: BuilddDecisionScope, deps: UiVerificationDeps = {}): Promise<UiVerificationExecution> {
  const parsed = parseSurfaceEvidence(input, { secrets: deps.secrets });
  const now = deps.nowDate?.() ?? new Date();
  const evidence = parsed.ok ? parsed.features : null;
  const base = { decisionRecordIds: [] as string[], receipts: [] as DecisionReceipt[], inputFingerprint: evidence ? uiVerificationFingerprint(evidence, id, id === 'ui.card_clarity' ? `${uiCopyKind.policyVersion}:${uiCopyKind.promptFingerprint}` : undefined) : null };
  if (!evidence) return { ...base, method: 'fallback', decisionKind: null, result: runUiSurfaceCheck(id, null, { verdict: 'inconclusive', observed: 'invalid_surface_evidence' }, now) };
  if (id === 'ui.actions_match_state') return { ...base, method: 'deterministic', decisionKind: null, result: runUiActionStateCheck(evidence, now) };
  const preflight = runUiSurfaceCheck(id, evidence, { verdict: 'inconclusive', observed: 'model_judgment_required' }, now);
  if (preflight.evidenceShortfall.length || preflight.observed !== 'model_judgment_required') return { ...base, method: 'fallback', decisionKind: null, result: preflight };
  const { secrets: _secrets, nowDate: _nowDate, ...brokerDeps } = deps;
  const answer = await runBuilddDecision(uiCopyKind, { features: uiCopyFeaturesFromSurface(evidence), subjectRef: { type: 'ui_surface', id: base.inputFingerprint! } }, {
    ...scope, onUsage: async receipt => { base.receipts.push(receipt); await scope.onUsage?.(receipt); },
  }, {
    ...brokerDeps,
    record: async row => {
      if (deps.record === false) return null;
      const write = deps.record ?? (await import('@buildd/core/decision-ledger')).recordDecision;
      const recordId = await write(row);
      if (recordId) base.decisionRecordIds.push(recordId);
      return recordId;
    },
  });
  const authoritative = answer.source === 'model' && base.decisionRecordIds.length > 0;
  const verdict = authoritative ? UI_COPY_VERDICT[answer.decision] : 'inconclusive';
  return {
    ...base, method: authoritative ? 'model' : 'fallback', decisionKind: uiCopyKind.kind,
    result: runUiSurfaceCheck(id, evidence, { verdict, confidence: authoritative ? answer.confidence ?? undefined : undefined, observed: authoritative ? answer.reasonCode : base.decisionRecordIds.length ? answer.reasonCode : 'decision_record_missing' }, now),
  };
}
