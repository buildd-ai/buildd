/**
 * Soft-overlap STARTs, graded by the same outcome labeller as Jev's
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §6).
 *
 * The claim route records one `soft_overlap_start` accepted gate row per
 * holder a task started past, with `decidedBy` `rule` (code started it:
 * a holder that never started, a directory-only overlap, a disjoint PR diff)
 * or `jev` (an applied model START). Both cohorts are shaped into the
 * labeller's `DecisionForJoin` and graded on the SAME three outcomes
 * (conflict retry created, path collision, merge-base refusal; composite
 * `risk`), so a rule START and a Jev START carry the same unsafe-start
 * measure and can be set side by side.
 *
 * The live sibling probe is reported next to it, never inside the composite:
 * when the pair overlapped live and a probe of the two tasks' branches ran
 * after the start, was it a real conflict? Pure: the stores are in
 * ./orchestration-claim-source.ts.
 */
import {
  labelDecisionOutcomes,
  type DecisionForJoin,
  type OutcomeJoinInput,
} from './orchestration-outcomes';

export type SoftStartDecidedBy = 'rule' | 'jev';

export interface SoftStartForReadout {
  /** The gate event's id. */
  id: string;
  taskId: string;
  workspaceId: string;
  holderTaskId: string | null;
  decidedBy: SoftStartDecidedBy;
  riskTier: string | null;
  startedAt: Date;
}

/** A `sibling_conflict_probe` gate row: `taskId` is the prober's task. */
export interface SiblingProbeEventForReadout {
  workspaceId: string | null;
  taskId: string | null;
  occurredAt: Date;
  detail: Record<string, unknown> | null;
}

export interface SoftStartReadoutInput {
  starts: SoftStartForReadout[];
  /** The labeller's inputs for the started tasks (decisions are derived from `starts`). */
  outcome: Omit<OutcomeJoinInput, 'decisions'>;
  probes: SiblingProbeEventForReadout[];
  windowEnd?: Date;
}

export interface SoftStartCohortSummary {
  decidedBy: SoftStartDecidedBy;
  starts: number;
  startSafety: { observedUnsafe: number; observedSafe: number; censored: number; missing: number };
  /** observedUnsafe / (observedUnsafe + observedSafe); null with no observed start. */
  unsafeStartRate: number | null;
  /** Observed bad outcomes, each label on its own. */
  separate: { conflictCreated: number; collision: number; mergeBaseRefusal: number };
  /** Of the starts whose pair a live probe examined after the start. */
  siblingProbe: { probed: number; conflict: number; clean: number; error: number };
  byRiskTier: Record<string, number>;
}

const COHORTS: readonly SoftStartDecidedBy[] = ['rule', 'jev'];

const detailStr = (d: Record<string, unknown> | null, k: string): string | null => {
  const v = d?.[k];
  return typeof v === 'string' ? v : null;
};

/** The probe outcome for one start's pair (newest after the start), or null when no probe examined it. */
export function siblingOutcomeFor(start: SoftStartForReadout, probes: readonly SiblingProbeEventForReadout[]): 'clean' | 'conflict' | 'error' | null {
  if (!start.holderTaskId) return null;
  const pair = new Set([start.taskId, start.holderTaskId]);
  let newest: SiblingProbeEventForReadout | null = null;
  for (const e of probes) {
    if (e.workspaceId !== start.workspaceId || !e.taskId) continue;
    if (e.occurredAt.getTime() < start.startedAt.getTime()) continue;
    const other = detailStr(e.detail, 'otherTaskId');
    if (!other || e.taskId === other || !pair.has(e.taskId) || !pair.has(other)) continue;
    if (!newest || e.occurredAt > newest.occurredAt) newest = e;
  }
  if (!newest) return null;
  const o = detailStr(newest.detail, 'probeOutcome');
  if (o === 'conflict') return 'conflict';
  if (o === 'clean' || o === 'mergiraf_resolved') return 'clean';
  return 'error';
}

export function summarizeSoftStartReadout(input: SoftStartReadoutInput): SoftStartCohortSummary[] {
  const decisions: DecisionForJoin[] = input.starts.map(s => ({
    id: s.id, taskId: s.taskId, workspaceId: s.workspaceId, prNumber: null, headSha: null, baseRef: null, createdAt: s.startedAt,
  }));
  const labels = new Map(labelDecisionOutcomes({ ...input.outcome, decisions }).map(l => [l.decisionId, l]));

  return COHORTS.map((decidedBy) => {
    const rows = input.starts.filter(s => s.decidedBy === decidedBy);
    const safety = { observedUnsafe: 0, observedSafe: 0, censored: 0, missing: 0 };
    const separate = { conflictCreated: 0, collision: 0, mergeBaseRefusal: 0 };
    const siblingProbe = { probed: 0, conflict: 0, clean: 0, error: 0 };
    const byRiskTier: Record<string, number> = {};
    for (const s of rows) {
      byRiskTier[s.riskTier ?? 'unknown'] = (byRiskTier[s.riskTier ?? 'unknown'] ?? 0) + 1;
      const l = labels.get(s.id);
      if (!l) { safety.missing++; continue; }
      if (l.risk.status === 'observed') l.risk.value ? safety.observedUnsafe++ : safety.observedSafe++;
      else if (l.risk.status === 'missing') safety.missing++;
      else safety.censored++;
      if (l.conflictCreated.status === 'observed' && l.conflictCreated.value) separate.conflictCreated++;
      if (l.collision.status === 'observed' && l.collision.value) separate.collision++;
      if (l.mergeBaseRefusal.status === 'observed' && l.mergeBaseRefusal.value) separate.mergeBaseRefusal++;
      const probe = siblingOutcomeFor(s, input.probes);
      if (probe) { siblingProbe.probed++; siblingProbe[probe]++; }
    }
    const observed = safety.observedUnsafe + safety.observedSafe;
    return {
      decidedBy,
      starts: rows.length,
      startSafety: safety,
      unsafeStartRate: observed > 0 ? safety.observedUnsafe / observed : null,
      separate,
      siblingProbe,
      byRiskTier,
    };
  });
}
