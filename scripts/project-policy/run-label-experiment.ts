import { spawnSync } from 'node:child_process';
import original from './routing-cases.json';
import fresh from './label-validation-cases.json';
import { createPatternExperiment, metrics, patternPrompts, type ExperimentRow } from './pattern-experiment';
import { experimentOrder } from './run-pattern-experiment';
import { localJevKey } from './explore';

async function mapWorkers<T, R>(rows: T[], fn: (row: T) => Promise<R>, concurrency = 4) {
  const result: R[] = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) { const index = cursor++; result[index] = await fn(rows[index]); }
  }));
  return result;
}
const git = (args: string[]) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git metadata unavailable.');
  return result.stdout.trim();
};
const config = patternPrompts(3);

async function run(key: string, order: string) {
  const rows = experimentOrder([
    ...(original as ExperimentRow[]).map(row => ({ ...row, split: `previous-${row.split}` })),
    ...(fresh as ExperimentRow[]).map(row => ({ ...row, split: 'fresh-validation' })),
  ], order);
  const groups = ['previous-development', 'previous-validation', 'fresh-validation'];
  const arms: Record<string, unknown> = {};
  for (const mode of ['old-multi', 'single-2', 'single-3', 'multi-2', 'multi-3']) {
    const engine = createPatternExperiment(key, undefined, 400, config);
    const started = performance.now();
    const results = await mapWorkers(rows, row => mode === 'old-multi' ? engine.allPatterns(row)
      : engine.clearLabels(row, mode.startsWith('single') ? 'single' : 'multi', mode.endsWith('2') ? 2 : 3));
    arms[mode] = { wallMs: Math.round(performance.now() - started), ...engine.summary(),
      scores: Object.fromEntries(groups.map(group => [group, metrics(rows.filter(row => row.split === group), results)])),
      results, calls: engine.calls };
  }
  const batch: Record<string, unknown> = {};
  for (const model of ['typesafe/jev-1.13', 'deepseek/deepseek-v4.1-flash']) {
    const endpoint = model.startsWith('deepseek/') ? { kind: 'chat' as const, baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' as const } : undefined;
    const picker = createPatternExperiment(key, undefined, 100, config, { model, ...(endpoint ? { endpoint } : {}), timeoutMs: 10000 });
    const started = performance.now();
    const probe = await picker.shortlist(rows.filter(row => row.split === groups[0]), 1);
    if (picker.calls.some(call => !call.ok)) {
      batch[model] = { status: 'unavailable; no provider fallback', probe, ...picker.summary(), calls: picker.calls };
      continue;
    }
    const selected = (await mapWorkers(groups, group => picker.shortlist(rows.filter(row => row.split === group), 8), 2)).flat();
    const checking = createPatternExperiment(key, undefined, 100, config);
    const results = await mapWorkers(selected, row => checking.clearLabels(row, 'multi', 3));
    batch[model] = { status: 'executed', wallMs: Math.round(performance.now() - started), selection: picker.summary(), checking: checking.summary(),
      scores: Object.fromEntries(groups.map(group => {
        const groupRows = rows.filter(row => row.split === group);
        const positives = groupRows.filter(row => row.expected === 'revise');
        return [group, { ...metrics(groupRows, results), candidateRecall: positives.filter(row => selected.some(s => s.id === row.id)).length / positives.length }];
      })), selectedIds: selected.map(row => row.id), results, calls: { selection: picker.calls, checking: checking.calls } };
  }
  return { order, labels: { binary: 'edit / leave (leave includes insufficient evidence)', ternary: 'edit / leave / need_context' },
    provenance: 'Original32 are previously exposed provisional examples. Fresh16 were prepared by a separate agent before new prompts/results were seen; labels are still agent-provisional, not human gold.',
    cases: rows, arms, batch };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (args.some(a => !['team', 'workspace', 'output', 'order'].some(name => a.startsWith(`--${name}=`)))) throw new Error('Unknown argument.');
    if (!arg('output')) throw new Error('Local output required.');
    const key = await localJevKey(arg('team'), arg('workspace'));
    if (!key) throw new Error('No authorized OpenRouter credential.');
    const report = { sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: !!git(['status', '--porcelain', '--', 'scripts/project-policy']),
      startedAt: new Date().toISOString(), experiment: await run(key, arg('order') ?? 'shuffle-17'),
      recording: 'Shared typed shadow adapter and local receipts; DeepSeek only selects candidates; no settings or database writes.' };
    await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ sourceCommit: report.sourceCommit, sourceDirty: report.sourceDirty,
      arms: Object.fromEntries(Object.entries(report.experiment.arms).map(([name, result]) => [name, { ...(result as object), results: undefined, calls: undefined }])),
      batch: Object.fromEntries(Object.entries(report.experiment.batch).map(([name, result]) => [name, { ...(result as object), results: undefined, calls: undefined }])) }, null, 2));
  } catch {
    console.error('Label experiment failed. Check inputs and the authorized route; no credential/provider body is printed.');
    process.exitCode = 2;
  }
}
