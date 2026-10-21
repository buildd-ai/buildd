import { spawnSync } from 'node:child_process';
import { summarizeBenchmark } from '../../packages/core/decision-benchmark';
import gold from './gold.json';
import policy from './product-language.json';
import type { ChangedSubject, ProjectPolicy } from './pipeline';
import { createJevEvaluator, type SemanticEvaluator } from './semantic';
import type { InferenceKeyScope, ResolveInferenceKeyOptions } from '../../packages/core/inference-keys';

type LocalScope = ResolveInferenceKeyOptions & { teamId: string; workspaceId: string };
async function resolveLocalCredential(scope: LocalScope) {
  process.env.DISABLE_WRITES = 'true';
  const { resolveInferenceCredential } = await import('../../packages/core/inference-keys');
  // User explicitly selects the pinned Jev offline experiment, not a different team model.
  // Resolve only a scoped team/workspace API credential; never use a platform billing fallback.
  return resolveInferenceCredential(scope);
}

/** Local opt-in only. Explicit scope wins; no fallback to an unrelated env credential. */
export async function localJevEvaluator(teamId?: string, workspaceId?: string,
  resolve: (scope: LocalScope) => Promise<{ key: string; scope: InferenceKeyScope } | null> = resolveLocalCredential) {
  if (teamId || workspaceId) {
    if (!teamId || !workspaceId) throw new Error('Supply both team and workspace for scoped exploration.');
    const credential = await resolve({ teamId, workspaceId, provider: 'openrouter', purposes: ['decision_key', 'inference_key'] });
    if (credential && credential.scope !== 'workspace' && credential.scope !== 'team') {
      throw new Error('Scoped exploration requires a workspace or team credential.');
    }
    return createJevEvaluator(credential?.key);
  }
  return createJevEvaluator(process.env.OPENROUTER_API_KEY);
}

export async function explorePolicy(examples: Array<{ text: string; purpose: string; expected: string }>, configured: ProjectPolicy, evaluate: SemanticEvaluator) {
  const rows = [];
  for (let index = 0; index < examples.length; index++) {
    const row = examples[index];
    const subject: ChangedSubject = { kind: 'ui.copy', file: 'synthetic-gold.tsx', line: index + 1,
      endLine: index + 1, start: 0, end: row.text.length, before: null, after: row.text,
      component: row.purpose === 'action' ? 'button' : 'span', prop: 'children',
      role: row.purpose === 'action' ? 'action' : 'description', confidence: 'syntactic', provenance: 'synthetic-development-gold' };
    const decision = await evaluate(subject, configured, { source: 'synthetic development example', purpose: row.purpose });
    rows.push({ id: `example-${index + 1}`, text: row.text, purpose: row.purpose, gold: row.expected, ...decision });
  }
  const attempted = rows.filter(row => row.attempts > 0);
  const latencies = attempted.map(row => row.latencyMs).sort((a, b) => a - b);
  return {
    policy: `${configured.id}@${configured.version}`, policyAuthority: configured.authority.hash,
    dataset: 'synthetic development examples; not held-out calibration',
    enforcement: 'advisory-only; no threshold selected',
    measurement: { decisions: attempted.length, answered: rows.filter(row => row.label !== 'unsupported').length,
      attempts: attempted.reduce((sum, row) => sum + row.attempts, 0),
      latencyTotalMs: attempted.reduce((sum, row) => sum + row.latencyMs, 0),
      latencyP50Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
      latencyP95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
      costUsd: attempted.length && attempted.every(row => row.costUsd !== null) ? attempted.reduce((sum, row) => sum + row.costUsd!, 0) : null },
    summary: summarizeBenchmark(rows.map(row => ({ id: row.id, gold: row.gold,
      predicted: row.label === 'unsupported' ? null : row.label, confidence: row.confidence }))), rows,
    recording: 'Local existing-adapter receipts only; no database ledger writes or configuration changes.',
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (key: string) => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
    if (args.some(a => !['team', 'workspace', 'output'].some(key => a.startsWith(`--${key}=`)))) throw new Error('Use --team=<id> --workspace=<id> --output=<local-json>; or supply an explicit OPENROUTER_API_KEY.');
    const evaluator = await localJevEvaluator(arg('team'), arg('workspace'));
    const report = { ...await explorePolicy(gold, policy, evaluator),
      sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      sourceDirty: !!spawnSync('git', ['status', '--porcelain', '--', 'scripts/project-policy'], { encoding: 'utf8' }).stdout.trim() };
    if (arg('output')) await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.measurement.answered === 0) process.exitCode = 2;
  } catch {
    console.error('Local Jev exploration could not run. Check the scoped resolver or local credential; no key or provider body is printed.');
    process.exitCode = 2;
  }
}
