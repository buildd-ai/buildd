import { spawnSync } from 'node:child_process';
import original from './routing-cases.json';
import latest from './label-validation-cases.json';
import { createPatternExperiment, metrics, patternPrompts, type ExperimentRow } from './pattern-experiment';
import { createStructuredSelector, type Selection } from './structured-selector';
import { experimentOrder } from './run-pattern-experiment';
import { localJevKey } from './explore';

const git = (args: string[]) => {
  const out = spawnSync('git', args, { encoding: 'utf8' });
  if (out.status !== 0) throw new Error('Git metadata unavailable.');
  return out.stdout.trim();
};
async function workers<T, R>(items: T[], fn: (item: T) => Promise<R>, count = 4) {
  const result: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, count) }, async () => {
    while (cursor < items.length) { const i = cursor++; result[i] = await fn(items[i]); }
  }));
  return result;
}
function summary(calls: { attempts: number; ok: boolean; costUsd: number | null; latencyMs: number }[]) {
  const sorted = calls.map(c => c.latencyMs).sort((a, b) => a - b);
  return { requests: calls.length, attempts: calls.reduce((n, c) => n + c.attempts, 0), failures: calls.filter(c => !c.ok).length,
    reportedCostUsd: calls.reduce((n, c) => n + (c.costUsd ?? 0), 0), unknownCostCalls: calls.filter(c => c.costUsd === null).length,
    latencyP50Ms: sorted[Math.ceil(sorted.length / 2) - 1] ?? null, latencyP95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? null };
}
export async function runSelectorExperiment(key: string, rows: ExperimentRow[], order: string) {
  const ordered = experimentOrder(rows, order);
  const groups = [...new Set(rows.map(r => r.split ?? 'unlabeled'))];
  const scores = (results: { id: string; verdict: string }[]) => Object.fromEntries(groups.map(group => [group,
    metrics(rows.filter(r => (r.split ?? 'unlabeled') === group), results)]));
  const direct = createPatternExperiment(key, undefined, 400, patternPrompts(3));
  const directStart = performance.now();
  const directResults = await workers(ordered, r => direct.allPatterns(r));
  const directWallMs = Math.round(performance.now() - directStart);
  const batchResults: Record<string, unknown> = {};
  for (const size of [16, 48]) {
    const selector = createStructuredSelector(key);
    const batches = Array.from({ length: Math.ceil(ordered.length / size) }, (_, i) => ordered.slice(i * size, (i + 1) * size));
    const started = performance.now();
    const selected = await workers(batches, batch => selector.select(batch));
    const selectionWallMs = Math.round(performance.now() - started);
    const nominations: Selection[] = selected.flatMap(r => r.ok ? r.rows : []);
    const candidates = nominations.filter(r => r.disposition === 'review');
    const allChecking = createPatternExperiment(key, undefined, 400, patternPrompts(3));
    const checkingStart = performance.now();
    const checked = await workers(candidates, pick => allChecking.allPatterns(rows.find(r => r.id === pick.id)!));
    const checkingWallMs = Math.round(performance.now() - checkingStart);
    const targeted = createPatternExperiment(key, undefined, 400, patternPrompts(3));
    const targetedStart = performance.now();
    const targetedResults = await workers(candidates, async pick => {
      const votes = await Promise.all(pick.patterns.map(p => targeted.targeted(rows.find(r => r.id === pick.id)!, p)));
      return { id: pick.id, verdict: votes.some(v => v.verdict === 'revise') ? 'revise' : votes.some(v => v.verdict === 'uncertain') ? 'uncertain' : 'keep', votes };
    });
    batchResults[String(size)] = { selection: { wallMs: selectionWallMs, ...summary(selector.calls), nominations,
      deferredIds: selected.flatMap((r, i) => r.ok ? [] : batches[i].map(row => row.id)),
      needContextIds: nominations.filter(r => r.disposition === 'need_context').map(r => r.id),
      scores: Object.fromEntries(groups.map(group => {
        const positives = rows.filter(r => (r.split ?? 'unlabeled') === group && r.expected === 'revise');
        const picked = positives.filter(r => candidates.some(c => c.id === r.id));
        return [group, { positiveCount: positives.length, selectedCount: candidates.filter(c => rows.some(r => r.id === c.id && (r.split ?? 'unlabeled') === group)).length,
          candidateRecall: positives.length ? picked.length / positives.length : null,
          proposedPatternMatches: picked.filter(r => candidates.find(c => c.id === r.id)!.patterns.includes(r.expectedPattern as Selection['patterns'][number])).length }];
      })), calls: selector.calls },
      allChecks: { wallMs: checkingWallMs, ...summary(allChecking.calls), scores: scores(checked), results: checked, calls: allChecking.calls },
      proposedChecks: { wallMs: Math.round(performance.now() - targetedStart), ...summary(targeted.calls), scores: scores(targetedResults), results: targetedResults, calls: targeted.calls } };
  }
  return { order, provenance: 'All48 labels previously exposed and agent-provisional; exploratory regression, not fresh validation or human gold. Nonselected rows are not certified clean.',
    cases: rows, direct: { wallMs: directWallMs, ...summary(direct.calls), scores: scores(directResults), results: directResults, calls: direct.calls }, batchResults };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (args.some(a => !['team', 'workspace', 'output', 'order'].some(k => a.startsWith(`--${k}=`))) || !arg('output')) throw new Error('Invalid arguments.');
    const key = await localJevKey(arg('team'), arg('workspace'));
    if (!key) throw new Error('No scoped credential.');
    const report = { sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--', 'scripts/project-policy']), startedAt: new Date().toISOString(),
      experiment: await runSelectorExperiment(key, [...(original as ExperimentRow[]).map(r => ({ ...r, split: `previous-${r.split}` })),
        ...(latest as ExperimentRow[]).map(r => ({ ...r, split: 'latest-exposed' }))], arg('order') ?? 'shuffle-17') };
    await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ sourceCommit: report.sourceCommit, sourceDirty: report.sourceDirty, output: arg('output'), status: 'recorded' }));
  } catch {
    console.error('Structured selector experiment failed. No credential or provider body is printed.');
    process.exitCode = 2;
  }
}
