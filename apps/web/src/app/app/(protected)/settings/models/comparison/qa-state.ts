/**
 * `?state=populated` fixture for Settings → Models → Compare, so the visual
 * audit can see the populated page (docs/specs/qa-capture-steps.md). The QA
 * clone has recorded no attempts, so the page otherwise only shows its empty
 * state. The fixture holds two models over shared tasks (same-task pairs),
 * tool-efficiency traces on some attempts, and attempts with missing model
 * version, cost and verdicts (evidence gaps). Synthetic data, display only.
 *
 * Dev-server only: Visual QA runs `bun dev`, production ignores the param.
 */
import { buildModelComparison, type ComparisonRow, type ModelComparison } from '@buildd/core/model-comparison';

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const trace = (calls: number, repeated: number, dropped: number) => ({
  schemaVersion: 1 as const, analyserVersion: 'tea-v1', harness: 'claude' as const, calls,
  findingKinds: { identical_search_unchanged: repeated }, failureClasses: { error: 1 },
  timing: { observedCalls: calls, totalMs: calls * 100, p50Ms: 80, p90Ms: 200, maxMs: 400 },
  coverage: { recorded: calls, dropped, unobserved: 0, sampledOut: 0 },
});

function row(n: number, o: Partial<ComparisonRow>): ComparisonRow {
  const at = new Date(BASE - n * 3_600_000);
  return {
    workerId: `qa-worker-${n}`, taskId: id(o.taskId ? 0 : n), chainId: null,
    resolvedModel: 'model-a', endpointKind: 'anthropic_api', modelVersion: null, quantization: null, backend: null,
    harnessVersion: null, runtime: null, taskClass: null, startedAt: at, endedAt: at, createdAt: at,
    durationMs: null, inputTokens: null, outputTokens: null, tokensPerSecond: null, terminalOutcome: 'completed',
    failureOrigin: 'none', costUsd: null, reviewVerdict: null, ciState: null, specVerdict: null, prOutcome: null,
    reworked: false, ...o,
  };
}

export function buildComparisonQaRows(): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  let n = 0;
  // Four tasks attempted by both models: the same-task pairs.
  for (let t = 1; t <= 4; t++) {
    const taskId = id(900 + t);
    rows.push(row(++n, {
      taskId, resolvedModel: 'model-a', modelVersion: '2026-01', durationMs: 240_000 + t * 30_000,
      inputTokens: 120_000, outputTokens: 9_000, costUsd: 0.42, reviewVerdict: 'approved', prOutcome: t === 4 ? null : 'merged',
      toolEfficiency: trace(24, 2, t === 1 ? 3 : 0),
    }));
    rows.push(row(++n, {
      taskId, resolvedModel: 'model-b', durationMs: 300_000 + t * 20_000, inputTokens: 90_000, outputTokens: 7_000,
      reviewVerdict: t <= 2 ? 'changes_requested' : 'approved', prOutcome: t <= 2 ? null : 'merged',
      toolEfficiency: t === 1 ? null : trace(18, 0, 0),
    }));
  }
  // Attempts with nothing recorded beyond the outcome, and one failure.
  rows.push(row(++n, { resolvedModel: 'model-a', terminalOutcome: 'failed', failureOrigin: 'model' }));
  rows.push(row(++n, { resolvedModel: 'model-b' }));
  rows.push(row(++n, { resolvedModel: 'model-b', terminalOutcome: 'failed', failureOrigin: 'infrastructure' }));
  return rows;
}

export function resolveComparisonQaData(
  raw: string | string[] | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ModelComparison | null {
  if (nodeEnv !== 'development') return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'populated' ? buildModelComparison(buildComparisonQaRows(), {}) : null;
}
