/**
 * A synthetic decision ledger and a readable side-by-side comparison, for
 * proving a decision kind end to end without a provider or a database.
 *
 * `createSyntheticDecisionLedger` stands in for the three stores a kind
 * writes to (`decision_records`, `decision_challenger_runs`,
 * `decision_outcomes`) using the same row mappers the DB path uses
 * (`rowFromRecord`, `challengerRowFromRun`), and hands back what
 * `runBuilddDecision` and `labelDecisionOutcome` take as deps. Its
 * `readoutRows` is what `loadDecisionReadoutRows` would return for the same
 * rows, so `computeDecisionReadout` runs unchanged on top.
 *
 * `formatDecisionComparison` renders readouts as one table: collection health,
 * coverage, applied vs shadow, decision mix, escalation, challenger agreement,
 * latency, cost and labelled correctness. Observational, like the readout.
 *
 * Pure apart from the in-memory state. No DB, no env.
 */

import { challengerRowFromRun, rowFromRecord, type ChallengerRunInput, type DecisionLedgerInput } from './decision-ledger';
import type { OutcomeRow, OutcomeStore } from './decision-outcomes';
import type { BuilddDecisionDeps } from './decision-policy';
import type { DecisionReadout, ReadoutRows } from './decision-readout';

export interface SyntheticLedgerRecord extends ReturnType<typeof rowFromRecord> {
  id: string;
}

export interface SyntheticDecisionLedger {
  /** Pass to `runBuilddDecision`: ledger and challenger writes, and a `defer` you drain with `flush`. */
  deps: Required<Pick<BuilddDecisionDeps, 'record' | 'recordChallenger' | 'defer'>>;
  /** Pass to `labelDecisionOutcome` as `deps.store`. */
  outcomeStore: OutcomeStore;
  records: SyntheticLedgerRecord[];
  challengers: ReturnType<typeof challengerRowFromRun>[];
  outcomes: OutcomeRow[];
  /** Run every deferred job (challengers) to completion. */
  flush(): Promise<void>;
  /** One kind's rows, shaped as the readout source returns them. */
  readoutRows(kind: string, opts?: { challengerConfigured?: boolean }): ReadoutRows;
}

export function createSyntheticDecisionLedger(): SyntheticDecisionLedger {
  const records: SyntheticLedgerRecord[] = [];
  const challengers: ReturnType<typeof challengerRowFromRun>[] = [];
  const outcomes: OutcomeRow[] = [];
  const pending: Array<() => Promise<void>> = [];
  let seq = 0;

  const outcomeStore: OutcomeStore = {
    async findRecords(q) {
      return records
        .filter(r => r.teamId === q.teamId)
        .filter(r => !q.decisionRecordId || r.id === q.decisionRecordId)
        .filter(r => !q.capability || r.capability === q.capability)
        .filter(r => !q.subject || (r.subjectType === q.subject.type && r.subjectId === q.subject.id))
        .map(r => ({ id: r.id, capability: r.capability }));
    },
    async insertOutcome(row) {
      if (outcomes.some(o => o.decisionRecordId === row.decisionRecordId && o.source === row.source)) return false;
      outcomes.push(row);
      return true;
    },
    async readOutcome(decisionRecordId, source) {
      const o = outcomes.find(x => x.decisionRecordId === decisionRecordId && x.source === source);
      return o ? { label: o.label, value: o.value } : null;
    },
  };

  return {
    deps: {
      record: async (input: DecisionLedgerInput) => {
        const id = `rec-${++seq}`;
        records.push({ id, ...rowFromRecord(input) });
        return id;
      },
      recordChallenger: async (input: ChallengerRunInput) => {
        const row = challengerRowFromRun(input);
        // Idempotent per (decision, challenger key), like the table.
        if (!challengers.some(c => c.decisionRecordId === row.decisionRecordId && c.challengerKey === row.challengerKey)) challengers.push(row);
      },
      defer: job => { pending.push(job); },
    },
    outcomeStore,
    records,
    challengers,
    outcomes,
    async flush() {
      while (pending.length) await pending.shift()!();
    },
    readoutRows(kind, opts = {}) {
      const mine = records.filter(r => r.capability === kind);
      const ids = new Set(mine.map(r => r.id));
      return {
        records: mine.map(r => ({
          id: r.id,
          status: r.status,
          applied: r.applied,
          appliedAnswer: r.appliedAnswer,
          policyVersion: r.policyVersion,
          provider: r.provider,
          model: r.model,
          attemptCount: r.attemptCount,
          escalated: r.escalated,
          failureClass: r.failureClass,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          latencyMs: r.latencyMs,
          costUsd: r.costUsd,
          experimentId: r.experimentId,
          experimentArm: r.experimentArm,
        })),
        outcomes: outcomes.filter(o => ids.has(o.decisionRecordId)).map(o => ({
          decisionRecordId: o.decisionRecordId, source: o.source, label: o.label, value: o.value,
        })),
        challengers: challengers.filter(c => ids.has(c.decisionRecordId)).map(c => ({
          decisionRecordId: c.decisionRecordId,
          challengerKey: c.challengerKey,
          status: c.status,
          skipReason: c.skipReason,
          provider: c.provider,
          model: c.model,
          outcome: c.outcome,
          decision: c.decision,
          agrees: c.agrees,
          failureKind: c.failureKind,
          latencyMs: c.latencyMs,
          costUsd: c.costUsd,
        })),
        challengerConfigured: opts.challengerConfigured ?? false,
      };
    },
  };
}

export interface ComparisonEntry {
  /** Column heading, e.g. the kind id. */
  label: string;
  readout: DecisionReadout;
  /** The rows the readout was computed from, for the decision mix. */
  rows: ReadoutRows;
}

const pct = (r: number | null) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
const ms = (v: number | null) => (v === null ? 'n/a' : `${v}ms`);
const usd = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(6)}`);

function decisionMix(rows: ReadoutRows): string {
  const counts = new Map<string, number>();
  for (const r of rows.records) counts.set(r.appliedAnswer ?? '-', (counts.get(r.appliedAnswer ?? '-') ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
}

/** One table, one column per entry. Rows are fixed so two runs diff cleanly. */
export function formatDecisionComparison(entries: readonly ComparisonEntry[]): string {
  const lines: Array<[string, ...string[]]> = [
    ['', ...entries.map(e => e.label)],
    ['collection', ...entries.map(e => `${e.readout.collection.state}${e.readout.collection.reasons.length ? ` (${e.readout.collection.reasons.join('; ')})` : ''}`)],
    ['coverage', ...entries.map(e => `${e.readout.decidedSubjects}/${e.readout.eligibleSubjects ?? '?'} = ${pct(e.readout.coverage)}`)],
    ['records', ...entries.map(e => String(e.readout.records))],
    ['applied / suggested / fallback', ...entries.map(e => `${e.readout.byStatus.applied} / ${e.readout.byStatus.suggested} / ${e.readout.byStatus.fallback}`)],
    ['decision in effect', ...entries.map(e => decisionMix(e.rows))],
    ['escalation', ...entries.map(e => `${e.readout.escalation.escalated}/${e.readout.escalation.eligible} = ${pct(e.readout.escalation.rate)}`)],
    ['challenger agreement', ...entries.map(e => {
      const c = e.readout.challenger;
      return c.attempted === 0 ? 'none' : `${c.agreement.agree}/${c.agreement.n} = ${pct(c.agreement.rate)}`;
    })],
    ['challenger vs applied correct', ...entries.map(e => {
      const s = e.readout.challenger.scored;
      return s.n === 0 ? 'n/a' : `applied ${s.appliedCorrect}/${s.n}, challenger ${s.challengerCorrect}/${s.n}`;
    })],
    ['latency p50 / p90', ...entries.map(e => `${ms(e.readout.latencyMs.p50)} / ${ms(e.readout.latencyMs.p90)}`)],
    ['cost total / per decision', ...entries.map(e => `${usd(e.readout.cost.totalUsd)} / ${usd(e.readout.cost.perDecisionUsd)}`)],
    ['labelled', ...entries.map(e => `${e.readout.outcomes.labelled}/${e.readout.records}`)],
    ['correct (policy, provider, model)', ...entries.map(e =>
      e.readout.groups.filter(g => g.scored > 0)
        .map(g => `${[g.policyVersion ?? '-', g.provider ?? 'rule/fallback', g.model].filter(Boolean).join(' ')}: ${g.correct}/${g.scored}`)
        .join('; ') || 'n/a')],
  ];
  const widths = lines[0].map((_, i) => Math.max(...lines.map(l => l[i].length)));
  return lines.map(l => l.map((cell, i) => cell.padEnd(widths[i])).join(' | ').trimEnd()).join('\n');
}
