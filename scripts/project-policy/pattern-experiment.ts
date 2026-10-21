import { createHash } from 'node:crypto';
import { choice, defineDecision, canonicalJson, JEV_MODEL, redactSecrets, type DecideParams, type DecisionReceipt } from '../../packages/ai-kit/src/decide';
import { buildSemanticState } from './semantic';
import type { CopyRole } from './pipeline';
import type { StaticCopyContext } from './static-context';
import prompts from './pattern-prompts.json';
import tuned from './pattern-prompts-v2.json';
import eligibility from './pattern-eligibility.json';

export interface ExperimentRow {
  id: string; text: string; role: CopyRole; purpose: string; staticContext?: StaticCopyContext;
  component?: string; prop?: string;
  expected?: string; expectedPattern?: string; source?: string; rationale?: string; split?: string;
}
export type Pattern = keyof typeof prompts.routes;
type Verdict = 'revise' | 'keep' | 'uncertain';
export interface RoutedResult { id: string; pattern: Pattern; verdict: Verdict; confidence: number | null; routeConfidence?: number | null }
type Fetcher = DecideParams<{ value: ReturnType<typeof choice> }>['fetch'];
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Pure bounded model input; never include labels, source paths, rationale or gold repairs. */
export function rowState(row: ExperimentRow) {
  return buildSemanticState({ kind: 'ui.copy', file: '', line: 1, endLine: 1, start: 0, end: row.text.length,
    before: null, after: row.text, component: row.component ?? (row.role === 'action' ? 'button' : row.role === 'heading' ? 'h2' : 'p'),
    prop: row.prop ?? 'children', role: row.role, confidence: 'syntactic', provenance: '' },
  { source: '', purpose: row.purpose, ...(row.staticContext ? { staticContext: row.staticContext } : {}) });
}

export function patternPrompts(version: number) {
  if (version === 1) return { ...prompts, eligibility: {} };
  if (version !== 2 && version !== 3) throw new Error('Unknown prompt experiment version.');
  return { ...prompts, ...tuned, version, eligibility: version === 3 ? eligibility.patterns : {}, routes: { ...prompts.routes, ...tuned.routes }, patterns: {
    over_explanation: { ...prompts.patterns.over_explanation, ...tuned.patterns.over_explanation },
    duplication: { ...prompts.patterns.duplication, ...tuned.patterns.duplication },
    vague_action: { ...prompts.patterns.vague_action, ...tuned.patterns.vague_action },
  } };
}

export function createPatternExperiment(apiKey?: string | null, fetcher?: Fetcher, maxCalls = 400, config = patternPrompts(1)) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 400) throw new Error('Experiment budget must be between 0 and 400.');
  let reserved = 0;
  const calls: { id: string; promptFingerprint: string; inputFingerprint: string; ok: boolean; model: string;
    latencyMs: number; attempts: number; costUsd: number | null; receipt: DecisionReceipt | null }[] = [];
  const safe = (row: ExperimentRow) => {
    if (!row || typeof row.text !== 'string' || typeof row.purpose !== 'string' || !['action', 'description', 'heading', 'status', 'diagnostic'].includes(row.role)) return false;
    const c = row.staticContext;
    if (c && (c.completeness !== 'static-partial' || typeof c.container !== 'string'
      || c.heading !== undefined && typeof c.heading !== 'string' || !Array.isArray(c.nearbyText) || c.nearbyText.some(t => typeof t !== 'string'))) return false;
    const state = rowState(row);
    const raw = canonicalJson(state);
    return row.text.length <= 500 && row.purpose.length <= 80 && typeof state.component === 'string' && state.component.length <= 80
      && typeof state.prop === 'string' && state.prop.length <= 80 && state.role !== 'unknown'
      && (!state.staticContext || state.staticContext.container.length <= 80 && (state.staticContext.heading?.length ?? 0) <= 120
        && state.staticContext.nearbyText.length <= 2 && state.staticContext.nearbyText.every(s => s.length <= 160))
      && redactSecrets(raw, [apiKey]) === raw && !/(?:sk-|bld_|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw);
  };
  const applicable = (pattern: Pattern, row: ExperimentRow) => {
    const selector = (config.eligibility as Partial<Record<Pattern, { roles: string[]; purposeContains: string[] }>>)[pattern];
    return !selector || selector.roles.includes(row.role) || selector.purposeContains.some(part => row.purpose.includes(part));
  };
  async function ask<const L extends string>(kind: string, instructions: string, criteria: Record<L, string>, state: unknown) {
    const definition = defineDecision({ id: `buildd.copy_experiment.${kind}`, promptVersion: `patterns-${config.version}`,
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
    const criteria = Object.fromEntries(Object.entries(config.routes).filter(([pattern]) => applicable(pattern as Pattern, row)));
    const answer = await ask('route', config.routeInstructions, criteria, rowState(row));
    return { pattern: (answer?.choice as Pattern) ?? 'uncertain', confidence: answer?.confidence ?? null };
  };
  const targeted = async (row: ExperimentRow, pattern: Pattern): Promise<RoutedResult> => {
    if (pattern === 'none' || pattern === 'necessary_detail') return { id: row.id, pattern, verdict: 'keep', confidence: null };
    if (pattern === 'uncertain' || !safe(row) || !applicable(pattern, row)) return { id: row.id, pattern, verdict: 'uncertain', confidence: null };
    const selected = config.patterns[pattern];
    const answer = await ask(pattern, selected.question, { revise: selected.revise, keep: selected.keep, uncertain: config.uncertain }, rowState(row));
    return { id: row.id, pattern, verdict: answer?.choice ?? 'uncertain', confidence: answer?.confidence ?? null };
  };
  return {
    calls, route, targeted,
    async routed(row: ExperimentRow) { const selected = await route(row); return { ...await targeted(row, selected.pattern), routeConfidence: selected.confidence }; },
    async shortlist(rows: ExperimentRow[], limit: number) {
      if (rows.length > 32 || !Number.isInteger(limit) || limit < 0 || limit > rows.length) throw new Error('Use batches <=32 and a bounded shortlist.');
      const remaining = rows.filter(safe);
      const selected: ExperimentRow[] = [];
      while (remaining.length && selected.length < limit) {
        const criteria: Record<string, string> = { none: 'No remaining string has a clear actionable defect worth targeted review.' };
        remaining.forEach((_, index) => { criteria[`c_${index}`] = `The strongest remaining actionable copy-policy candidate is c_${index}.`; });
        const answer = await ask('candidate', config.candidateInstructions, criteria,
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
