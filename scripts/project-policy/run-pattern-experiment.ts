import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import cases from './routing-cases.json';
import { createPatternExperiment, patternPrompts, metrics, rowState, type ExperimentRow } from './pattern-experiment';
import { createJevEvaluator } from './semantic';
import { policyPreset } from './policy-presets';
import { localJevKey } from './explore';
import type { ChangedSubject, PolicyFinding } from './pipeline';

async function mapFour<T, R>(rows: T[], fn: (row: T) => Promise<R>) {
  const result: R[] = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (cursor < rows.length) { const index = cursor++; result[index] = await fn(rows[index]); }
  }));
  return result;
}
const git = (args: string[]) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git metadata unavailable.');
  return result.stdout.trim();
};

export function experimentOrder<T extends { id: string }>(rows: T[], order: string) {
  if (order === 'source') return [...rows];
  if (order === 'reverse') return [...rows].reverse();
  if (order !== 'shuffle-17') throw new Error('Use source, reverse or shuffle-17 order.');
  const rank = (row: T) => createHash('sha256').update(`17:${row.id}`).digest('hex');
  return [...rows].sort((a, b) => rank(a).localeCompare(rank(b)));
}

async function benchmark(key: string, version: number, order: string) {
  const rows = experimentOrder(cases as ExperimentRow[], order);
  const config = patternPrompts(version);
  const policy = policyPreset('wwvd').policy;
  const baseline = createJevEvaluator(key, undefined, rows.length);
  const baselineStart = performance.now();
  const broad = await mapFour(rows, async row => {
    const state = rowState(row);
    const evaluation = await baseline({ kind: 'ui.copy', file: '', line: 1, endLine: 1, start: 0, end: row.text.length,
      before: null, after: row.text, component: state.component, prop: 'children', role: row.role, confidence: 'syntactic', provenance: '',
      ...(row.staticContext ? { staticContext: row.staticContext } : {}) }, policy, { source: '', purpose: row.purpose });
    return { id: row.id, verdict: evaluation.label === 'useful' ? 'keep' : ['redundant', 'unclear'].includes(evaluation.label) ? 'revise' : 'uncertain', evaluation };
  });
  const broadWallMs = Math.round(performance.now() - baselineStart);
  const routedEngine = createPatternExperiment(key, undefined, 400, config);
  const routedStart = performance.now();
  const routed = await mapFour(rows, row => routedEngine.routed(row));
  const routedWallMs = Math.round(performance.now() - routedStart);
  const selectedEngine = createPatternExperiment(key, undefined, 400, config);
  const selectedStart = performance.now();
  const selected: ExperimentRow[] = [];
  for (const split of ['development', 'validation']) selected.push(...await selectedEngine.shortlist(rows.filter(row => row.split === split), 8));
  const shortlisted = await mapFour(selected, row => selectedEngine.routed(row));
  const shortlistWallMs = Math.round(performance.now() - selectedStart);
  const splits = Object.fromEntries(['development', 'validation'].map(split => {
    const splitRows = rows.filter(row => row.split === split);
    const matching = routed.filter(result => splitRows.some(row => row.id === result.id && row.expectedPattern === result.pattern)).length;
    return [split, { broad: metrics(splitRows, broad), routed: metrics(splitRows, routed), shortlisted: metrics(splitRows, shortlisted),
      routePatternAgreement: { matching, total: splitRows.length, rate: matching / splitRows.length },
      candidateRecall: splitRows.filter(row => row.expected === 'revise' && selected.some(s => s.id === row.id)).length / splitRows.filter(row => row.expected === 'revise').length }];
  }));
  return { provenance: '32 provisional agent-reviewed labels; 16 development + 16 validation. Prompts frozen before execution. Some examples adapt earlier WWVD controls; not human gold or unseen production calibration.',
    splits, broad: { wallMs: broadWallMs, requests: broad.filter(r => r.evaluation.attempts > 0).length,
      attempts: broad.reduce((sum, r) => sum + r.evaluation.attempts, 0),
      costUsd: broad.every(r => r.evaluation.costUsd !== null) ? broad.reduce((sum, r) => sum + r.evaluation.costUsd!, 0) : null,
      results: broad },
    routed: { wallMs: routedWallMs, ...routedEngine.summary(), results: routed, calls: routedEngine.calls },
    shortlisted: { wallMs: shortlistWallMs, ...selectedEngine.summary(), selectedIds: selected.map(r => r.id), results: shortlisted, calls: selectedEngine.calls },
    cases };
}

async function surface(key: string, path: string, version: number, order: string) {
  const source = await Bun.file(path).json() as { rows: { subject: ChangedSubject; findings: PolicyFinding[] }[]; sourceCommit: string };
  const eligible = source.rows.filter(row => row.subject.after !== null && row.findings.some(f => f.decision));
  const rows: ExperimentRow[] = eligible.map((row, index) => ({ id: `u${String(index).padStart(4, '0')}`, text: row.subject.after!,
    role: row.subject.role, purpose: 'unknown', ...(row.subject.staticContext ? { staticContext: row.subject.staticContext } : {}) }));
  const engine = createPatternExperiment(key, undefined, 400, patternPrompts(version));
  const batches: ExperimentRow[][] = [];
  const ordered = experimentOrder(rows, order);
  for (let index = 0; index < ordered.length; index += 32) batches.push(ordered.slice(index, index + 32));
  const started = performance.now();
  const chosen = (await mapFour(batches, batch => engine.shortlist(batch, 1))).flat();
  const results = await mapFour(chosen, row => engine.routed(row));
  return { sourceCommit: source.sourceCommit, inputs: rows.length, batches: batches.length, chosen: chosen.length,
    wallMs: Math.round(performance.now() - started), ...engine.summary(),
    limits: 'Best <=1 per batch of32, not a single global ranking; no gold labels for the surface. No selected row is automatically a defect.',
    results: results.map(result => {
      const index = rows.findIndex(row => row.id === result.id);
      return { ...result, subject: eligible[index].subject };
    }), calls: engine.calls };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (args.some(a => !['team', 'workspace', 'output', 'surface', 'variant', 'order'].some(name => a.startsWith(`--${name}=`)))) throw new Error('Unknown experiment argument.');
    if (!arg('output')) throw new Error('An explicit local output path is required.');
    const key = await localJevKey(arg('team'), arg('workspace'));
    if (!key) throw new Error('No authorized Jev key.');
    const version = Number(arg('variant') ?? 1);
    const order = arg('order') ?? 'source';
    const report = { sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--', 'scripts/project-policy']),
      startedAt: new Date().toISOString(), version, order, benchmark: await benchmark(key, version, order),
      ...(arg('surface') ? { surface: await surface(key, arg('surface')!, version, order) } : {}),
      recording: 'Local existing-adapter receipts; advisory only; no settings, database or ledger writes.' };
    await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ sourceCommit: report.sourceCommit, sourceDirty: report.sourceDirty, splits: report.benchmark.splits,
      broad: { requests: report.benchmark.broad.requests, costUsd: report.benchmark.broad.costUsd },
      routed: { requests: report.benchmark.routed.requests, costUsd: report.benchmark.routed.costUsd },
      shortlisted: { requests: report.benchmark.shortlisted.requests, costUsd: report.benchmark.shortlisted.costUsd },
      ...(report.surface ? { surface: { inputs: report.surface.inputs, chosen: report.surface.chosen, requests: report.surface.requests, costUsd: report.surface.costUsd } } : {}) }, null, 2));
  } catch {
    console.error('Pattern experiment could not run. Check inputs and authorized credentials; no key/provider body is printed.');
    process.exitCode = 2;
  }
}
