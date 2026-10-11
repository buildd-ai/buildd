/**
 * Offline readout for the memory Jev decisions: Jev vs the current rule vs
 * the use ledger's outcome, per decision. Pure; the query half is
 * scripts/memory-decision-readout.ts.
 *
 * What "the ledger outcome" means per decision:
 * - relevance: the memory_uses outcome (used / ignored) of the same memory on
 *   the same task. The rule showed every hit, so its precision is the used
 *   share of all graded hits; Jev's is the used share of the hits it called
 *   relevant, and its recall is how many used hits it would have kept.
 *   Live verdicts (claim_context, where a confident "not relevant" demotes
 *   the hit) read as their own group, `relevance:live`: demotedUsed is the
 *   used share of the hits it actually demoted (lower is better; each used
 *   one is a demotion it got wrong), keptUsed the same for the rest.
 * - keep, type: the memory's use rate across every task it was shown to,
 *   split by Jev's verdict (flagged vs not, overridden vs not).
 * - update, use, promote, chat tier, directive scope: verdict mix, applied
 *   share and fail-open rate (use labels ARE the ledger outcome).
 */

export interface ReadoutDecisionRow {
  decision: string;
  taskId: string | null;
  memoryId: string | null;
  verdict: string | null;
  confidence: number | null;
  rule: string | null;
  applied: boolean;
  error: string | null;
  /** Absent on rows read before mode was selected: treated as the decision's default. */
  mode?: 'live' | 'shadow' | string | null;
}

export interface ReadoutOutcome {
  taskId: string | null;
  memoryId: string;
  outcome: 'used' | 'ignored' | 'contradicted';
}

export const READOUT_THRESHOLDS = [0.5, 0.7, 0.8, 0.9, 0.95] as const;

export interface UseRate { used: number; graded: number; rate: number | null }

export interface DecisionSummary {
  decision: string;
  rows: number;
  answered: number;
  applied: number;
  errors: Record<string, number>;
  verdicts: Record<string, number>;
  /** Jev agreed with the rule (only where the two answer the same question). */
  agreeWithRule: number | null;
  /** Share of answered rows at or above each threshold. */
  coverage: Record<string, number>;
  ledger?: Record<string, UseRate | number | null>;
}

const rate = (used: number, graded: number): UseRate => ({ used, graded, rate: graded ? used / graded : null });

/** Rule and verdict answer the same question for these decisions. */
function agrees(r: ReadoutDecisionRow): boolean | null {
  if (r.verdict === null) return null;
  if (r.decision === 'type') return r.verdict === r.rule;
  // The rule showed the hit (said "relevant"); Jev agrees on 'true'.
  if (r.decision === 'relevance' && r.rule === 'mandatory') return null;
  if (r.decision === 'relevance') return r.rule === 'shown' ? r.verdict === 'true' : r.verdict === 'false';
  // Today every learn lands (rule: keep); Jev agrees on 'true'.
  if (r.decision === 'keep') return r.verdict === 'true';
  return null;
}

export function computeMemoryDecisionReadout(rows: ReadoutDecisionRow[], outcomes: ReadoutOutcome[]): DecisionSummary[] {
  const graded = outcomes.filter(o => o.outcome === 'used' || o.outcome === 'ignored');
  const byTaskMemory = new Map<string, 'used' | 'ignored'>();
  const byMemory = new Map<string, { used: number; graded: number }>();
  for (const o of graded) {
    if (o.taskId) byTaskMemory.set(`${o.taskId}|${o.memoryId}`, o.outcome as 'used' | 'ignored');
    const m = byMemory.get(o.memoryId) ?? { used: 0, graded: 0 };
    m.graded++;
    if (o.outcome === 'used') m.used++;
    byMemory.set(o.memoryId, m);
  }

  const groups = new Map<string, ReadoutDecisionRow[]>();
  // Relevance is shadow on most paths and live on claim_context: two policies,
  // read apart so one does not dilute the other.
  const groupOf = (r: ReadoutDecisionRow) => (r.decision === 'relevance' && r.mode === 'live' ? 'relevance:live' : r.decision);
  for (const r of rows) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([decision, rs]) => {
    const answered = rs.filter(r => r.verdict !== null);
    const errors: Record<string, number> = {};
    const verdicts: Record<string, number> = {};
    for (const r of rs) {
      if (r.error) errors[r.error] = (errors[r.error] ?? 0) + 1;
      if (r.verdict !== null) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    }
    const comparable = answered.map(agrees).filter((v): v is boolean => v !== null);
    const coverage: Record<string, number> = {};
    for (const t of READOUT_THRESHOLDS) {
      coverage[String(t)] = answered.length ? answered.filter(r => (r.confidence ?? 0) >= t).length / answered.length : 0;
    }
    const summary: DecisionSummary = {
      decision,
      rows: rs.length,
      answered: answered.length,
      applied: rs.filter(r => r.applied).length,
      errors,
      verdicts,
      agreeWithRule: comparable.length ? comparable.filter(Boolean).length / comparable.length : null,
      coverage,
    };

    if (decision === 'relevance:live') {
      let demotedUsed = 0; let demotedGraded = 0; let keptUsed = 0; let keptGraded = 0;
      for (const r of answered) {
        if (!r.taskId || !r.memoryId) continue;
        const o = byTaskMemory.get(`${r.taskId}|${r.memoryId}`);
        if (!o) continue;
        if (r.applied) {
          demotedGraded++;
          if (o === 'used') demotedUsed++;
        } else if (r.rule !== 'mandatory') {
          keptGraded++;
          if (o === 'used') keptUsed++;
        }
      }
      summary.ledger = { demotedUsed: rate(demotedUsed, demotedGraded), keptUsed: rate(keptUsed, keptGraded) };
    } else if (decision === 'relevance') {
      let ruleUsed = 0; let ruleGraded = 0; let jevUsed = 0; let jevKept = 0; let usedKeptByJev = 0;
      for (const r of answered) {
        if (!r.taskId || !r.memoryId) continue;
        const o = byTaskMemory.get(`${r.taskId}|${r.memoryId}`);
        if (!o) continue;
        ruleGraded++;
        if (o === 'used') ruleUsed++;
        if (r.verdict === 'true') {
          jevKept++;
          if (o === 'used') { jevUsed++; usedKeptByJev++; }
        }
      }
      summary.ledger = {
        rulePrecision: rate(ruleUsed, ruleGraded),
        jevPrecision: rate(jevUsed, jevKept),
        jevRecall: ruleUsed ? usedKeptByJev / ruleUsed : null,
      };
    } else if (decision === 'keep' || decision === 'type') {
      const split = (pred: (r: ReadoutDecisionRow) => boolean): UseRate => {
        let used = 0; let n = 0;
        for (const r of answered) {
          if (!r.memoryId || !pred(r)) continue;
          const m = byMemory.get(r.memoryId);
          if (!m) continue;
          used += m.used; n += m.graded;
        }
        return rate(used, n);
      };
      summary.ledger = decision === 'keep'
        ? { flagged: split(r => r.verdict === 'false'), kept: split(r => r.verdict === 'true') }
        : { overridden: split(r => r.applied), callerType: split(r => !r.applied) };
    }
    return summary;
  });
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);

export function formatMemoryDecisionReadout(summaries: DecisionSummary[]): string {
  if (summaries.length === 0) return 'No memory decisions recorded in the window.';
  const lines: string[] = [];
  for (const s of summaries) {
    lines.push(`## ${s.decision}`);
    lines.push(`rows ${s.rows}, answered ${s.answered}, applied ${s.applied}, agrees with rule ${pct(s.agreeWithRule)}`);
    const errs = Object.entries(s.errors).map(([k, v]) => `${k} ${v}`).join(', ');
    if (errs) lines.push(`failed open: ${errs}`);
    lines.push(`verdicts: ${Object.entries(s.verdicts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    lines.push(`coverage at confidence: ${Object.entries(s.coverage).map(([t, v]) => `>=${t} ${pct(v)}`).join(', ')}`);
    if (s.ledger) {
      for (const [k, v] of Object.entries(s.ledger)) {
        lines.push(typeof v === 'object' && v !== null
          ? `ledger ${k}: ${pct(v.rate)} used (${v.used}/${v.graded})`
          : `ledger ${k}: ${pct(v as number | null)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
