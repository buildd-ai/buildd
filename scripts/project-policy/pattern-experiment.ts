import { createHash } from 'node:crypto';
import { choice, defineDecision, canonicalJson, JEV_MODEL, redactSecrets, type DecideParams, type DecisionReceipt } from '../../packages/ai-kit/src/decide';
import { buildSemanticState } from './semantic';
import type { CopyRole } from './pipeline';
import type { StaticCopyContext } from './static-context';
import prompts from './pattern-prompts.json';

export interface ExperimentRow {
  id: string; text: string; role: CopyRole; purpose: string; staticContext?: StaticCopyContext;
  expected?: string; expectedPattern?: string; source?: string; rationale?: string; split?: string;
}
export type Pattern = keyof typeof prompts.routes;
type Verdict = 'revise' | 'keep' | 'uncertain';
export interface RoutedResult { id: string; pattern: Pattern; verdict: Verdict; confidence: number | null }
type Fetcher = DecideParams<{ value: ReturnType<typeof choice> }>['fetch'];
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Pure bounded model input; never include labels, source paths, rationale or gold repairs. */
export function rowState(row: ExperimentRow) {
  return buildSemanticState({ kind: 'ui.copy', file: '', line: 1, endLine: 1, start: 0, end: row.text.length,
    before: null, after: row.text, component: row.role === 'action' ? 'button' : row.role === 'heading' ? 'h2' : 'p',
    prop: 'children', role: row.role, confidence: 'syntactic', provenance: '' },
  { source: '', purpose: row.purpose, ...(row.staticContext ? { staticContext: row.staticContext } : {}) });
}

export function createPatternExperiment(apiKey?: string | null, fetcher?: Fetcher, maxCalls = 400) {
  let reserved = 0;
  const calls: { id: string; promptFingerprint: string; inputFingerprint: string; ok: boolean; model: string;
    latencyMs: number; attempts: number; costUsd: number | null; receipt: DecisionReceipt | null }[] = [];
  const safe = (row: ExperimentRow) => {
    const state = rowState(row);
    const raw = canonicalJson(state);
    return row.text.length <= 500 && row.purpose.length <= 80 && state.role !== 'unknown'
      && (!state.staticContext || state.staticContext.container.length <= 80 && (state.staticContext.heading?.length ?? 0) <= 120
        && state.staticContext.nearbyText.length <= 2 && state.staticContext.nearbyText.every(s => s.length <= 160))
      && redactSecrets(raw, [apiKey]) === raw && !/(?:sk-|bld_|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw);
  };
  async function ask<const L extends string>(kind: string, instructions: string, criteria: Record<L, string>, state: unknown) {
    const definition = defineDecision({ id: `buildd.copy_experiment.${kind}`, promptVersion: `patterns-${prompts.version}`,
      model: JEV_MODEL, mode: 'shadow', questions: { value: choice(instructions, criteria) } });
    if (!apiKey || reserved >= maxCalls) return null;
    reserved++;
    const run = await definition.run({ apiKey, state: state as Record<string, unknown>, ...(fetcher ? { fetch: fetcher } : {}), timeoutMs: 5000, maxAttempts: 2 });
    calls.push({ id: definition.id, promptFingerprint: definition.fingerprint, inputFingerprint: hash(state), ok: run.result.ok,
      model: run.result.ok ? run.result.model : definition.model, latencyMs: run.result.latencyMs, attempts: run.result.attempts,
      costUsd: run.result.ok ? run.result.usage.costUsd : null, receipt: run.receipt });
    return run.result.ok ? run.result.answers.value : null;
  }
  const route = async (row: ExperimentRow): Promise<{ pattern: Pattern; confidence: number | null }> => {
    if (!safe(row)) return { pattern: 'uncertain', confidence: null };
    const answer = await ask('route', prompts.routeInstructions, prompts.routes, rowState(row));
    return { pattern: answer?.choice ?? 'uncertain', confidence: answer?.confidence ?? null };
  };
  const targeted = async (row: ExperimentRow, pattern: Pattern): Promise<RoutedResult> => {
    if (pattern === 'none' || pattern === 'necessary_detail') return { id: row.id, pattern, verdict: 'keep', confidence: null };
    if (pattern === 'uncertain' || !safe(row)) return { id: row.id, pattern, verdict: 'uncertain', confidence: null };
    const selected = prompts.patterns[pattern];
    const answer = await ask(pattern, selected.question, { revise: selected.revise, keep: selected.keep, uncertain: prompts.uncertain }, rowState(row));
    return { id: row.id, pattern, verdict: answer?.choice ?? 'uncertain', confidence: answer?.confidence ?? null };
  };
  return {
    calls, route, targeted,
    async routed(row: ExperimentRow) { return targeted(row, (await route(row)).pattern); },
    async shortlist(rows: ExperimentRow[], limit: number) {
      if (rows.length > 32 || !Number.isInteger(limit) || limit < 0 || limit > rows.length) throw new Error('Use batches <=32 and a bounded shortlist.');
      const remaining = rows.filter(safe);
      const selected: ExperimentRow[] = [];
      while (remaining.length && selected.length < limit) {
        const criteria: Record<string, string> = { none: 'No remaining string has a clear actionable defect worth targeted review.' };
        remaining.forEach((_, index) => { criteria[`c_${index}`] = `The strongest remaining actionable copy-policy candidate is c_${index}.`; });
        const answer = await ask('candidate', prompts.candidateInstructions, criteria,
          { strings: remaining.map((row, index) => ({ id: `c_${index}`, ...rowState(row) })) });
        if (!answer || answer.choice === 'none') break;
        const index = Number(answer.choice.slice(2));
        if (!Number.isInteger(index) || index < 0 || index >= remaining.length) break;
        selected.push(remaining.splice(index, 1)[0]);
      }
      return selected;
    },
    summary() {
      return { requests: calls.length, attempts: calls.reduce((sum, c) => sum + c.attempts, 0), failures: calls.filter(c => !c.ok).length,
        latencyTotalMs: calls.reduce((sum, c) => sum + c.latencyMs, 0),
        costUsd: calls.every(c => c.costUsd !== null) ? calls.reduce((sum, c) => sum + c.costUsd!, 0) : null };
    },
  };
}

export function metrics(rows: { id: string; expected?: string }[], results: { id: string; verdict: string }[]) {
  const ids = new Set(rows.map(r => r.id));
  const relevant = results.filter(r => ids.has(r.id));
  const actual = new Map(relevant.map(r => [r.id, r.verdict]));
  const truePositives = rows.filter(r => r.expected === 'revise' && actual.get(r.id) === 'revise').length;
  const falsePositives = rows.filter(r => r.expected === 'keep' && actual.get(r.id) === 'revise').length;
  const unreviewableFlags = rows.filter(r => r.expected === 'uncertain' && actual.get(r.id) === 'revise').length;
  const missedViolations = rows.filter(r => r.expected === 'revise' && actual.get(r.id) !== 'revise').length;
  const positives = rows.filter(r => r.expected === 'revise').length;
  const flagged = truePositives + falsePositives + unreviewableFlags;
  return { rows: rows.length, evaluated: relevant.length, truePositives, falsePositives, unreviewableFlags, missedViolations,
    precision: flagged ? truePositives / flagged : null, recall: positives ? truePositives / positives : null,
    abstained: relevant.filter(r => r.verdict === 'uncertain').length };
}
