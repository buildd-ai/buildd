/** Production adapter. The coordinator authorizes captures, loads owned artifacts and persists spec outcomes. */
import type { DecisionReceipt } from '@buildd/ai-kit/decide';
import { uiCopyKind } from '@buildd/core/decision-kind-ui-copy';
import { runBuilddDecision, type BuilddDecisionDeps, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import {
  evaluateUiSurface, parseSurfaceEvidence, runUiSurfaceCheck, uiVerificationFingerprint,
  type UiCopyFeatures, type UiEvidenceCapability, type UiModelDecision, type UiSurfaceOutcome, type UiVerifierId,
} from '@buildd/core/ui-verification';
import type { VerificationResult } from '@buildd/core/verification-check';

export interface UiVerificationDeps extends BuilddDecisionDeps {
  secrets?: readonly string[];
  nowDate?: () => Date;
}
/** What the copy check is judged against: the binding's profile and the criterion's words. */
export interface UiVerificationContext {
  profile?: UiCopyFeatures['profile'];
  criterion?: UiCopyFeatures['criterion'];
}
export interface UiVerificationExecution {
  result: VerificationResult;
  method: 'deterministic' | 'model' | 'fallback';
  decisionKind: string | null;
  decisionRecordIds: string[];
  receipts: DecisionReceipt[];
  inputFingerprint: string | null;
  findings?: UiSurfaceOutcome['findings'];
  inspected?: UiEvidenceCapability[];
  coverage?: UiSurfaceOutcome['coverage'];
  evaluator?: UiSurfaceOutcome['evaluator'];
}

/**
 * The decision broker as the shared evaluator's `decide`: one broker call, and an answer counts only when it
 * came from the model and its decision record was persisted. A fallback, a rule answer or a lost ledger write
 * is `ok: false`, so it can never stand as a model result.
 */
export function brokerUiCopyDecide(
  scope: BuilddDecisionScope, subjectId: string, deps: BuilddDecisionDeps,
  out: { decisionRecordIds: string[]; receipts: DecisionReceipt[] },
): (features: UiCopyFeatures) => Promise<UiModelDecision> {
  return async (features) => {
    const recorded: string[] = [];
    const answer = await runBuilddDecision(uiCopyKind, { features, subjectRef: { type: 'ui_surface', id: subjectId } }, {
      ...scope, onUsage: async receipt => { out.receipts.push(receipt); await scope.onUsage?.(receipt); },
    }, {
      ...deps,
      record: async row => {
        if (deps.record === false) return null;
        const write = deps.record ?? (await import('@buildd/core/decision-ledger')).recordDecision;
        const recordId = await write(row);
        if (recordId) recorded.push(recordId);
        return recordId;
      },
    });
    out.decisionRecordIds.push(...recorded);
    if (answer.source !== 'model') return { ok: false, error: answer.reasonCode || `fallback_${answer.fallbackCause ?? 'unknown'}` };
    if (!recorded.length) return { ok: false, error: 'decision_record_missing' };
    return {
      ok: true, decision: answer.decision, raw: null, confidence: answer.confidence, reasonCode: answer.reasonCode,
      evaluator: { model: answer.model ?? 'unknown', promptFingerprint: answer.promptFingerprint, policyVersion: answer.policyVersion, decisionId: recorded[0]! },
    };
  };
}

/** Model outcomes intentionally have no persistent-cache lookup: the broker resolves current team policy on every run. */
export async function executeUiVerification(
  id: UiVerifierId, input: unknown, scope: BuilddDecisionScope, ctx: UiVerificationContext = {}, deps: UiVerificationDeps = {},
): Promise<UiVerificationExecution> {
  const parsed = parseSurfaceEvidence(input, { secrets: deps.secrets });
  const now = deps.nowDate?.() ?? new Date();
  const evidence = parsed.ok ? parsed.features : null;
  const copy = id === 'ui.card_clarity';
  // The model's input is the capture plus what it is judged against: all of it is in the identity.
  const identity = copy ? `${uiCopyKind.policyVersion}:${uiCopyKind.promptFingerprint}:${JSON.stringify([ctx.profile ?? null, ctx.criterion ?? null])}` : undefined;
  const base = { decisionRecordIds: [] as string[], receipts: [] as DecisionReceipt[], inputFingerprint: evidence ? uiVerificationFingerprint(evidence, id, identity) : null };
  if (!evidence) return { ...base, method: 'fallback', decisionKind: null, result: runUiSurfaceCheck(id, null, { verdict: 'inconclusive', observed: 'invalid_surface_evidence' }, now) };
  const { secrets: _secrets, nowDate: _nowDate, ...brokerDeps } = deps;
  const out = await evaluateUiSurface(id, evidence, { ...ctx, now }, copy ? brokerUiCopyDecide(scope, base.inputFingerprint!, brokerDeps, base) : undefined);
  return {
    ...base, method: out.method, decisionKind: copy ? uiCopyKind.kind : null, result: out.result,
    findings: out.findings, inspected: out.inspected, coverage: out.coverage, ...(out.evaluator ? { evaluator: out.evaluator } : {}),
  };
}
