import { spawnSync } from 'node:child_process';
import { summarizeBenchmark } from '../../packages/core/decision-benchmark';
import { policyPreset } from './policy-presets';
import type { ChangedSubject, ProjectPolicy } from './pipeline';
import { createJevEvaluator, createClefEvaluator, type SemanticEvaluator } from './semantic';
import type { InferenceKeyScope, ResolveInferenceKeyOptions } from '../../packages/core/inference-keys';
import type { ClefModel, DecisionEndpoint } from '../../packages/ai-kit/src/decide';
import type { DecisionModelRoute } from '../../packages/core/decision-model';

type ClefScope = { teamId: string; workspaceId: string; allowPlatformKey: false };
async function resolveLocalClefRoute(setting: DecisionModelRoute, scope: ClefScope) {
  process.env.DISABLE_WRITES = 'true';
  const { resolveDecisionRoute } = await import('../../packages/core/decision-client');
  return resolveDecisionRoute(setting, scope);
}

/** Explicit experiment selection; reads the existing team route without saving settings or minting tokens. */
export async function localClefEvaluator(model: ClefModel, teamId?: string, workspaceId?: string,
  resolve: (setting: DecisionModelRoute, scope: ClefScope) => Promise<{ apiKey: string | null; model: string; endpoint?: DecisionEndpoint }> = resolveLocalClefRoute) {
  if (!teamId || !workspaceId) throw new Error('Supply both team and workspace for scoped Clef exploration.');
  const route = await resolve({ endpoint: 'systemone', via: 'cloudflare', model }, { teamId, workspaceId, allowPlatformKey: false });
  if (route.model !== model || (route.apiKey && route.endpoint?.kind !== 'workers-ai')) {
    throw new Error('Cloudflare Workers AI route is required for the selected Clef model.');
  }
  // Non-routable placeholder is never invoked without a key; retain model identity in the abstention.
  return createClefEvaluator(model, route.apiKey, route.endpoint?.kind === 'workers-ai' ? route.endpoint : { kind: 'workers-ai', baseURL: 'https://unconfigured.invalid' });
}

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
    if (args.some(a => !['team', 'workspace', 'output', 'model', 'policy'].some(key => a.startsWith(`--${key}=`)))) throw new Error('Use --model=jev|clef|clef-flash with --policy=product-language|wwvd --team=<id> --workspace=<id> --output=<local-json>.');
    const { policy, examples } = policyPreset(arg('policy'));
    const model = arg('model') ?? 'jev';
    if (!['jev', 'clef', 'clef-flash'].includes(model)) throw new Error('Unknown exploration model.');
    const evaluator = model === 'jev' ? await localJevEvaluator(arg('team'), arg('workspace'))
      : await localClefEvaluator(model as ClefModel, arg('team'), arg('workspace'));
    const report = { ...await explorePolicy(examples, policy, evaluator),
      sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      sourceDirty: !!spawnSync('git', ['status', '--porcelain', '--', 'scripts/project-policy'], { encoding: 'utf8' }).stdout.trim() };
    if (arg('output')) await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.measurement.answered === 0) process.exitCode = 2;
  } catch {
    console.error('Local policy exploration could not run. Check the scoped resolver or local credential; no key or provider body is printed.');
    process.exitCode = 2;
  }
}
