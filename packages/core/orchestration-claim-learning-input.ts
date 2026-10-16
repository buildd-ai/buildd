/** Outcome inputs shared by the operator readout and hourly claim dial. */
import { claimReadoutActor, type ClaimDecisionForReadout, type ClaimHoldReadoutInput } from './orchestration-claim-readout';
import { claimAreaClass, claimReceipt, attributeClaimOutcome } from './orchestration-claim-learning-evidence';
import { CLAIM_HOLD_START_TTL_MS } from './orchestration-claim-decision';
import type { ClaimLearningOutcome } from './orchestration-claim-learning';
import type { DecisionOutcomeLabels } from './orchestration-outcomes';
export interface ClaimLearningSample extends ClaimLearningOutcome {
  decisionId: string;
  gate: string;
  area: string;
  fingerprint: string;
  at: Date;
}
export interface ClaimStartEvent {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
  occurredAt: Date;
  reason: string | null;
  detail: Record<string, unknown> | null;
}
type AttributedLabel = DecisionOutcomeLabels & {
  attributableUnsafe?: boolean | null;
};
export const CLAIM_LEARNING_GATES = ['advisory_manifest', 'open_pr_overlap', 'soft_overlap'] as const;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const same = (a: string[], b: string[]) => a.length > 0 && [...new Set(a)].sort().join('\0') === [...new Set(b)].sort().join('\0');
const samePaths = (gate: string | undefined, a: string[], b: string[]) => same(a, b) || (gate === 'advisory_manifest' && a.length === 0 && b.length === 0);
const matches = (d: ClaimDecisionForReadout, e: ClaimStartEvent) => {
  const receipt = claimReceipt(d.receipt), detail = e.detail ?? {};
  return e.reason === 'claim_learning_jev_start' && e.workspaceId === d.workspaceId && e.taskId === d.taskId && detail.gate === d.gate
    && detail.fingerprint === d.fingerprint && (!d.candidateDigest || detail.candidateDigest === d.candidateDigest) && e.occurredAt >= d.createdAt && e.occurredAt.getTime() - d.createdAt.getTime() <= CLAIM_HOLD_START_TTL_MS
    && same(receipt.blockerTaskIds, strings(detail.blockerTaskIds)) && samePaths(d.gate, receipt.paths, strings(detail.paths));
};
/** No accepted claim marker means no on-policy safety label, even if it ran later. */
export function assembleClaimLearningWorkspace(input: ClaimHoldReadoutInput, events: ClaimStartEvent[], controlDecisions: ClaimDecisionForReadout[], labels: AttributedLabel[]) {
  const byLabel = new Map(labels.map(l => [l.decisionId, l]));
  const outcomes: ClaimLearningSample[] = [];
  const decisions = [...input.decisions, ...controlDecisions];
  const wait = (d: ClaimDecisionForReadout) => {
    const start = input.starts.filter(s => s.taskId === d.taskId && s.startedAt >= d.createdAt).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
    return start ? start.startedAt.getTime() - d.createdAt.getTime() : null;
  };
  for (const d of decisions) {
    const actor = claimReadoutActor(d), receipt = claimReceipt(d.receipt);
    const accepted = actor === 'jev_start' ? events.find(e => matches(d, e)) : undefined;
    const label = byLabel.get(d.id);
    const attributableUnsafe = actor === 'jev_start' && !accepted ? null : label ? label.attributableUnsafe ?? null : d.attributableUnsafe ?? null;
    let matchedJevLabel: 'HOLD' | 'START' | undefined;
    if (actor === 'human_force') {
      const previous = input.decisions.filter(p => p.taskId === d.taskId && p.workspaceId === d.workspaceId && p.createdAt < d.createdAt && p.gate === d.gate && p.areaClass === d.areaClass && p.model
        && same(claimReceipt(p.receipt).blockerTaskIds, receipt.blockerTaskIds) && samePaths(d.gate, claimReceipt(p.receipt).paths, receipt.paths))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (previous?.suggested === 'HOLD' || previous?.suggested === 'START')
        matchedJevLabel = previous.suggested;
    }
    outcomes.push({ decisionId: d.id, actor, taskId: d.taskId ?? undefined, gate: d.gate ?? 'unknown', area: d.areaClass ?? 'unknown', fingerprint: d.fingerprint,
      at: accepted?.occurredAt ?? d.createdAt, confidence: d.confidence ?? undefined, attributableUnsafe, staleBlocker: d.staleBlocker ?? receipt.staleBlocker, matchedJevLabel,
      waitMs: accepted ? accepted.occurredAt.getTime() - d.createdAt.getTime() : wait(d) });
  }
  // Readout safety follows the same successful-claim rule as calibration.
  const enriched = decisions.map(d => {
    const sample = outcomes.find(o => o.decisionId === d.id);
    return { ...d, attributableUnsafe: sample?.attributableUnsafe ?? null };
  });
  const combinedLabels = [...input.labels, ...labels.filter(l => !input.labels.some(old => old.decisionId === l.decisionId))].map(l => {
    const d = input.decisions.find(d => d.id === l.decisionId);
    return d && claimReadoutActor(d) === 'jev_start' && !events.some(e => matches(d, e)) ? { ...l, risk: { status: 'censored' as const, reason: 'open' as const } } : byLabel.get(l.decisionId) ?? l;
  });
  return { input: { ...input, decisions: enriched, labels: combinedLabels }, outcomes, truncated: false };
}
export async function loadClaimLearningWorkspace(opts: {
  workspaceId: string;
  since: Date;
  until: Date;
}) {
  const [{ db }, { gateEvents }, { and, eq, gte, lt, inArray }, { loadClaimHoldReadoutInput, loadSoftStartReadoutInput }, { loadOutcomeJoinFor }, { labelDecisionOutcomes }] = await Promise.all([
    import('./db/client'), import('./db/schema'), import('drizzle-orm'), import('./orchestration-claim-source'), import('./orchestration-ledger-source'), import('./orchestration-outcomes'),
  ]);
  const limit = 5000;
  const [input, soft, events] = await Promise.all([
    loadClaimHoldReadoutInput(opts), loadSoftStartReadoutInput(opts),
    db.select({ id: gateEvents.id, taskId: gateEvents.taskId, workspaceId: gateEvents.workspaceId, occurredAt: gateEvents.occurredAt, reason: gateEvents.reason, detail: gateEvents.detail })
      .from(gateEvents).where(and(eq(gateEvents.workspaceId, opts.workspaceId), eq(gateEvents.gate, 'claim_loop_deferral'), eq(gateEvents.outcome, 'accepted'), inArray(gateEvents.reason, ['claim_learning_clean_start', 'claim_learning_jev_start']), gte(gateEvents.occurredAt, opts.since), lt(gateEvents.occurredAt, opts.until)))
      .orderBy(gateEvents.occurredAt).limit(limit),
  ]);
  const clean: ClaimDecisionForReadout[] = events.filter(e => e.reason === 'claim_learning_clean_start' && e.taskId).flatMap(e => CLAIM_LEARNING_GATES.map(gate => ({
    id: `${e.id}:${gate}`, taskId: e.taskId, workspaceId: opts.workspaceId, decisionId: 'buildd.rule_start_clean', fingerprint: 'rule-clean-v1', candidatePolicyVersion: gate, model: null, experimentArm: 'observe' as const,
    propensity: 1, applied: true, effective: 'START', suggested: null, status: 'applied', reason: null, createdAt: e.occurredAt, actor: 'rule_start_clean' as const, gate,
    areaClass: claimAreaClass(strings(e.detail?.paths)), receipt: e.detail,
  })));
  const controls: ClaimDecisionForReadout[] = soft.starts.filter(s => s.decidedBy === 'rule').map(s => ({
    id: s.id, taskId: s.taskId, workspaceId: s.workspaceId, decisionId: 'buildd.rule_start_overlap', fingerprint: s.fingerprint ?? 'rule-overlap-v1', candidatePolicyVersion: 'soft_overlap', model: null, experimentArm: 'observe',
    propensity: 1, applied: true, effective: 'START', suggested: null, status: 'applied', reason: null, createdAt: s.startedAt, actor: 'rule_start_overlap', gate: 'soft_overlap', areaClass: s.areaClass ?? 'unknown', receipt: s.receipt, staleBlocker: s.staleBlocker,
  }));
  const all = [...input.decisions, ...clean, ...controls];
  const joinDecisions = all.map(d => {
    const accepted = events.find(e => matches(d, e));
    return { id: d.id, taskId: d.taskId, workspaceId: d.workspaceId, createdAt: accepted?.occurredAt ?? d.createdAt, prNumber: null, headSha: null, baseRef: null };
  });
  const join = await loadOutcomeJoinFor(joinDecisions, opts);
  const labels: AttributedLabel[] = labelDecisionOutcomes(join).map(l => {
    const d = all.find(d => d.id === l.decisionId)!;
    const j = joinDecisions.find(j => j.id === l.decisionId)!;
    // Clean starts supply the background rate of ALL observed harms, as specified.
    const rawBase = d.actor === 'rule_start_clean';
    return { ...l, attributableUnsafe: rawBase
        ? l.risk.status === 'observed' && (l.risk.value || (l.touched.status === 'observed' && l.touched.value.landed)) ? l.risk.value : null
        : attributeClaimOutcome(j, claimReceipt(d.receipt), l, join.gateEvents) };
  });
  const assembled = assembleClaimLearningWorkspace(input, events, [...clean, ...controls], labels);
  return { ...assembled, truncated: input.decisions.length >= limit || events.length >= limit || soft.starts.length >= limit };
}
