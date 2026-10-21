import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import development from './routing-cases.json';
import previous from './label-validation-cases.json';
import { createStructuredSelector } from './structured-selector';
import { createPatternExperiment, metrics, patternPrompts, type ExperimentRow } from './pattern-experiment';
import { experimentOrder } from './run-pattern-experiment';
import { localJevKey } from './explore';

const git = (args: string[]) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git metadata unavailable.');
  return result.stdout.trim();
};
async function workers<T, R>(rows: T[], fn: (row: T) => Promise<R>) {
  const result: R[] = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (cursor < rows.length) { const i = cursor++; result[i] = await fn(rows[i]); }
  }));
  return result;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const arg = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (args.some(a => !['team', 'workspace', 'output'].some(k => a.startsWith(`--${k}=`))) || !arg('output')) throw new Error('Invalid arguments.');
    const startedAt = new Date().toISOString();
    const source = { commit: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain', '--', 'scripts/project-policy']) };
    const key = await localJevKey(arg('team'), arg('workspace'));
    if (!key) throw new Error('No scoped credential.');
    const author = createStructuredSelector(key, undefined, 1);
    const training = (development as ExperimentRow[]).filter(r => r.split === 'development');
    const authored = await author.author(training);
    if (!authored.ok) {
      await Bun.write(arg('output')!, JSON.stringify({ source, status: 'author unavailable; no fallback', result: authored, calls: author.calls }, null, 2));
      process.exitCode = 2;
    } else {
      // Persist the proposed policy before examining or checking validation cases.
      await Bun.write(`${arg('output')!}.prompts.json`, JSON.stringify({ source, prompts: authored.prompts, authorCalls: author.calls }, null, 2));
      const fresh = (await import('./author-validation-cases.json')).default as ExperimentRow[];
      const rows = [...(development as ExperimentRow[]).filter(r => r.split === 'validation').map(r => ({ ...r, split: 'previous-validation' })),
        ...(previous as ExperimentRow[]).map(r => ({ ...r, split: 'previous-exposed' })), ...fresh.map(r => ({ ...r, split: 'new-agent-validation' }))];
      if (new Set(rows.map(r => r.id)).size !== rows.length || rows.some(r => training.some(t => t.id === r.id))) throw new Error('Overlapping examples.');
      const runs: Record<string, unknown> = {};
      for (const order of ['shuffle-17', 'reverse']) {
        const arms: Record<string, unknown> = {};
        for (const name of ['baseline', 'authored']) {
          const engine = createPatternExperiment(key, undefined, 400, patternPrompts(3));
          const start = performance.now();
          const results = await workers(experimentOrder(rows, order), r => name === 'baseline' ? engine.allPatterns(r) : engine.authored(r, authored.prompts));
          arms[name] = { wallMs: Math.round(performance.now() - start), ...engine.summary(),
            scores: Object.fromEntries(['previous-validation', 'previous-exposed', 'new-agent-validation'].map(group => [group, metrics(rows.filter(r => r.split === group), results)])),
            results, calls: engine.calls };
        }
        runs[order] = arms;
      }
      const report = { source, startedAt, trainingIds: training.map(r => r.id),
        provenance: 'Author sees only16 previously exposed development labels; old32 evaluation cases are exposed, new24 were independently prepared before seeing authored prompts/results. Labels remain agent-provisional, not human gold. Same authored policy reused for both orders.',
        authored: authored.prompts, authorCalls: author.calls, promptHash: createHash('sha256').update(JSON.stringify(authored.prompts)).digest('hex'), cases: rows, runs };
      await Bun.write(arg('output')!, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ status: 'recorded', source, output: arg('output'), promptHash: report.promptHash }));
    }
  } catch {
    console.error('Prompt author experiment failed. No provider body or credential printed.');
    process.exitCode = 2;
  }
}
