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
 * `task_role` (role-routing §6(b)) builds its question per row, from the
 * row's own candidate set, the way the live shadow does:
 *   {"id":"t1","role":"builder","category":"feature","title":"...","description":"...",
 *    "kind":null,"candidates":["builder","researcher","writer"]}
 * Candidates are slugs resolved through `--roles <file>` (a JSON array of
 * {slug,name,whenToUse,notFor?}: the workspace's routing text, kept local), or
 * full objects inline. Gold `none` means "no role should take this"; it is
 * never an option, so it only counts against a gate that applies it. The same
 * file serves `--set task_category --label-field category`, so role and
 * category are labelled on one sample. The output adds the gate table and the
 * picked TASK_ROLE_MIN_CONFIDENCE.
 *
 * Flags:
 *   --set <name>          question set (default task_category)
 *   --label-field <key>   which field holds the gold (default: the set's own)
 *   --roles <path>        task_role: routing text for slug candidates
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
import {
  parseLabeledJsonl,
  splitHeldOut,
  summarizeBenchmark,
  formatBenchmarkSummary,
  pickGateThreshold,
  formatGateTable,
  type LabeledExample,
} from '../packages/core/decision-benchmark';
import { SETS, runBenchmarkSet, setRoleText } from './decision-benchmark-sets';

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

  const rolesFile = arg('roles');
  if (rolesFile) setRoleText(JSON.parse(readFileSync(rolesFile, 'utf8')));

  const file = arg('file') ?? `.decision-data/${setName.replace(/_/g, '-')}.jsonl`;
  const { examples, skipped } = parseLabeledJsonl(readFileSync(file, 'utf8'), { labelField: arg('label-field') ?? set.labelField });
  const { train, heldOut } = splitHeldOut(examples, {
    heldOutFraction: arg('held-out') ? Number(arg('held-out')) : undefined,
    seed: arg('seed'),
  });
  const split = arg('split') ?? 'heldout';
  let chosen: LabeledExample[] = split === 'train' ? train : split === 'all' ? examples : heldOut;
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  if (limit) chosen = chosen.slice(0, limit);

  console.error(`${file}: ${examples.length} examples (${skipped} skipped), train ${train.length}, held-out ${heldOut.length}; running ${split} (${chosen.length})`);

  const { scored, costUsd, latencyTotalMs: latencyTotal } = await runBenchmarkSet(set, chosen, {
    apiKey,
    model: arg('model'),
    concurrency: Number(arg('concurrency') ?? 4),
  });

  const summary = summarizeBenchmark(scored);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ set: setName, split, costUsd, summary, ...(set.gate ? { gate: pickGateThreshold(scored) } : {}) }, null, 2));
  } else {
    console.log(formatBenchmarkSummary(`${setName} / ${split}`, summary));
    const ok = scored.filter(s => !s.error).length;
    console.log(`\ncost $${costUsd.toFixed(6)}   mean latency ${ok ? Math.round(latencyTotal / ok) : 0}ms`);
    const errors = scored.filter(s => s.error);
    if (errors.length) console.log(`errors (first 5): ${errors.slice(0, 5).map(e => `${e.id}: ${e.error}`).join(' | ')}`);
    if (set.gate) {
      const gate = pickGateThreshold(scored);
      console.log(`\napply gate (precision >= 0.95 on every label with >= 10 picks):\n${formatGateTable(gate.rows, gate.threshold)}`);
    }
    if (set.gatedLabel) {
      console.log(`\n'${set.gatedLabel}' picks by confidence (precision = gold agrees):`);
      for (const t of [0.5, 0.7, 0.8, 0.9, 0.95]) {
        const picks = scored.filter(s => s.predicted === set.gatedLabel && (s.confidence ?? 0) >= t);
        const right = picks.filter(s => s.gold === set.gatedLabel).length;
        const gold = scored.filter(s => s.gold === set.gatedLabel).length;
        console.log(`  >=${t.toFixed(2)}  picks ${picks.length}  precision ${picks.length ? (right / picks.length).toFixed(2) : '-'}  covers ${gold ? (right / gold).toFixed(2) : '-'} of gold`);
      }
    }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
