#!/usr/bin/env bun
/**
 * Run the decision benchmarks against a deployment's own prompt text, from a
 * checkout. buildd's own deployment runs the same eval server-side
 * (apps/web/src/lib/prompt-evals/run.ts: on a push to the prompts repo, weekly,
 * and on demand); this CLI is for a local run or a self-hosted deployment.
 *
 * Public CI only ever exercises the public defaults compiled into this repo. A
 * deployment that replaces them (docs/prompts.md) needs its replacement text
 * measured too, and that text must never reach a public log. This script:
 *
 *   1. loads a prompts directory (the same format and checks as the deploy
 *      seed, `@buildd/core/prompt-seed`) and installs it as the active rows
 *      of this process, exactly as the server snapshot would;
 *   2. runs every decision benchmark set (`decision-benchmark-sets.ts`) that
 *      has labelled cases over the questions now in effect;
 *   3. reports, per prompt id, the version and content-hash fingerprint that
 *      was scored and its scores, as markdown (a GitHub job summary) and
 *      optionally JSON.
 *
 * Labelled cases live NEXT TO the private text, never in this repo:
 * `<cases dir>/<set>.jsonl` with the set name dashed (`task-category.jsonl`),
 * one example per line in the format `scripts/decision-benchmark.ts`
 * documents. Default `<prompts dir>/evals`.
 *
 * Nothing printed carries prompt text or case content: the report holds ids,
 * versions, hashes, counts and rates, and every byte written is checked
 * against the loaded prompt bodies first (`findPromptLeaks`). A match refuses
 * the whole output and exits non-zero.
 *
 *   bun run scripts/private-prompt-eval.ts --dry-run                # public defaults, no model calls
 *   OPENROUTER_API_KEY=... bun run scripts/private-prompt-eval.ts --prompts ../my-prompts
 *
 * Flags:
 *   --prompts <dir>   prompts directory to load (omit: score the public defaults)
 *   --cases <dir>     labelled cases (default <prompts>/evals)
 *   --dry-run         load, resolve and fingerprint, count cases; make no model calls
 *   --require         fail unless private text loaded, cases exist and (unless
 *                     --dry-run) OPENROUTER_API_KEY is set: what CI runs, so a
 *                     run with nothing to measure is red, never green
 *   --summary <path>  append the markdown report here (default $GITHUB_STEP_SUMMARY)
 *   --json <path>     write the report as JSON
 *   --model <id>      decision model override
 *   --concurrency <n> parallel requests (default 4)
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirPromptReader, loadPromptSeed, type PromptSeedEntry } from '../packages/core/prompt-seed';
import { installPrompts, type RegisteredPrompt } from '../packages/core/prompts';
import { MISSING_KEY_SECRET, findPromptLeaks, formatEvalSummary, runPrivatePromptEval } from '../apps/web/src/lib/prompt-evals/eval-core';

// The core moved to apps/web/src/lib/prompt-evals/eval-core.ts, where the
// server-side eval runs it too; re-exported for callers of this script.
export * from '../apps/web/src/lib/prompt-evals/eval-core';

/** Load a prompts directory with the deploy seed's checks and make it the text in effect. */
export async function installPromptsDir(dir: string, catalog: readonly RegisteredPrompt[]): Promise<PromptSeedEntry[]> {
  const entries = await loadPromptSeed(dirPromptReader(dir), catalog);
  installPrompts(entries);
  return entries;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const promptsDir = arg('prompts') ?? null;
  const { listPromptCatalog } = await import('../apps/web/src/lib/prompt-catalog');
  const catalog = listPromptCatalog();

  let entries: PromptSeedEntry[] | null = null;
  if (promptsDir) {
    try {
      entries = await installPromptsDir(promptsDir, catalog);
    } catch (err) {
      // PromptSeedError lists ids and reasons only, never text.
      console.error(`[private-prompt-eval] could not load the prompts directory: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const report = await runPrivatePromptEval({
    catalog,
    entries,
    casesDir: arg('cases') ?? (promptsDir ? join(promptsDir, 'evals') : null),
    dryRun: flag('dry-run'),
    require: flag('require'),
    apiKey: process.env[MISSING_KEY_SECRET]?.trim() || null,
    model: arg('model'),
    concurrency: arg('concurrency') ? Number(arg('concurrency')) : undefined,
  });

  const markdown = formatEvalSummary(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  // Check against the private text AND the public defaults it replaced: either
  // appearing means the report is carrying prompt content it never should.
  const bodies = [...(entries ?? []), ...catalog.map(c => ({ id: c.id, body: c.publicDefault }))];
  const leaks = findPromptLeaks(markdown + json, bodies);
  if (leaks.length > 0) {
    console.error(`[private-prompt-eval] REFUSING to publish the report: it contains text of prompt(s) ${[...new Set(leaks)].join(', ')}`);
    return 1;
  }

  process.stdout.write(markdown);
  const summaryPath = arg('summary') ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, markdown);
  const jsonPath = arg('json');
  if (jsonPath) writeFileSync(jsonPath, json);

  if (report.problems.length > 0) {
    for (const p of report.problems) console.error(`::error::private prompt eval: ${p}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  main().then(
    code => process.exit(code),
    err => {
      console.error(`[private-prompt-eval] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
