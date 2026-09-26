#!/usr/bin/env bun
/**
 * Offline benchmark for a decision-call question set.
 *
 * Runs a question set over YOUR labelled examples and reports accuracy overall
 * and at confidence thresholds, on a deterministic held-out split. Use it to
 * pick a confidence gate, and to compare label wordings (tune on `--split train`,
 * judge on the default held-out split — never the other way round).
 *
 *   OPENROUTER_API_KEY=sk-or-... bun run scripts/decision-benchmark.ts \
 *     --set task_category --file .decision-data/task-category.jsonl
 *
 * Input is JSONL, one example per line, e.g. for `task_category`:
 *   {"id":"t1","label":"bug","title":"...","description":"..."}
 *
 * The data file stays local: `.decision-data/` is gitignored, and this repo is
 * public. Nothing here touches the database; the key comes from the env.
 *
 * Flags:
 *   --set <name>          question set (default task_category)
 *   --file <path>         labelled JSONL (default .decision-data/<set>.jsonl)
 *   --split heldout|train|all   (default heldout)
 *   --held-out <0..1>     held-out fraction (default 0.3)
 *   --seed <s>            split seed (default decision-benchmark)
 *   --model <id>          model override (default: the client's pinned model)
 *   --concurrency <n>     parallel requests (default 4)
 *   --limit <n>           cap examples (for a quick smoke run)
 *   --json                print the summary as JSON
 */
import { readFileSync } from 'node:fs';
import { decisionCall, describeDecisionError, type DecisionQuestions } from '../packages/core/decision-client';
import {
  parseLabeledJsonl,
  splitHeldOut,
  summarizeBenchmark,
  formatBenchmarkSummary,
  type LabeledExample,
  type ScoredExample,
} from '../packages/core/decision-benchmark';
import { TASK_CATEGORY_QUESTIONS, buildTaskCategoryState } from '../apps/web/src/lib/task-category-decision';
import { classifyTask } from '../apps/web/src/lib/task-category';

interface QuestionSet {
  questions: DecisionQuestions;
  /** Which choice question's answer is compared with the gold label. */
  answerKey: string;
  toState(fields: Record<string, unknown>): Record<string, unknown> | string;
  /** The incumbent logic, for a side-by-side accuracy line. */
  baseline?(fields: Record<string, unknown>): string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const SETS: Record<string, QuestionSet> = {
  task_category: {
    questions: TASK_CATEGORY_QUESTIONS,
    answerKey: 'category',
    toState: f => buildTaskCategoryState(str(f.title), str(f.description)),
    baseline: f => classifyTask(str(f.title), str(f.description)),
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const setName = arg('set') ?? 'task_category';
  const set = SETS[setName];
  if (!set) throw new Error(`unknown --set ${setName}; known: ${Object.keys(SETS).join(', ')}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

  const file = arg('file') ?? `.decision-data/${setName.replace(/_/g, '-')}.jsonl`;
  const { examples, skipped } = parseLabeledJsonl(readFileSync(file, 'utf8'));
  const { train, heldOut } = splitHeldOut(examples, {
    heldOutFraction: arg('held-out') ? Number(arg('held-out')) : undefined,
    seed: arg('seed'),
  });
  const split = arg('split') ?? 'heldout';
  let chosen: LabeledExample[] = split === 'train' ? train : split === 'all' ? examples : heldOut;
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  if (limit) chosen = chosen.slice(0, limit);

  console.error(`${file}: ${examples.length} examples (${skipped} skipped), train ${train.length}, held-out ${heldOut.length}; running ${split} (${chosen.length})`);

  const concurrency = Math.max(1, Number(arg('concurrency') ?? 4));
  const scored: ScoredExample[] = new Array(chosen.length);
  let next = 0;
  let costUsd = 0;
  let latencyTotal = 0;

  async function worker() {
    while (next < chosen.length) {
      const i = next++;
      const ex = chosen[i];
      const res = await decisionCall({
        capability: 'task_category_shadow',
        teamId: 'offline',
        apiKey,
        model: arg('model'),
        state: set.toState(ex.fields),
        questions: set.questions,
        timeoutMs: 10_000,
      });
      const baseline = set.baseline ? set.baseline(ex.fields) : undefined;
      if (res.ok) {
        const a = res.answers[set.answerKey] as { choice?: string; confidence?: number };
        scored[i] = { id: ex.id, gold: ex.label, predicted: a.choice ?? null, confidence: a.confidence ?? null, baseline };
        costUsd += res.usage.costUsd ?? 0;
        latencyTotal += res.latencyMs;
      } else {
        scored[i] = { id: ex.id, gold: ex.label, predicted: null, confidence: null, baseline, error: describeDecisionError(res.error) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const summary = summarizeBenchmark(scored);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ set: setName, split, costUsd, summary }, null, 2));
  } else {
    console.log(formatBenchmarkSummary(`${setName} / ${split}`, summary));
    const ok = scored.filter(s => !s.error).length;
    console.log(`\ncost $${costUsd.toFixed(6)}   mean latency ${ok ? Math.round(latencyTotal / ok) : 0}ms`);
    const errors = scored.filter(s => s.error);
    if (errors.length) console.log(`errors (first 5): ${errors.slice(0, 5).map(e => `${e.id}: ${e.error}`).join(' | ')}`);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
