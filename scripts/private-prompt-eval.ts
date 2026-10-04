#!/usr/bin/env bun
/**
 * Run the decision benchmarks against a deployment's own prompt text.
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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirPromptReader, loadPromptSeed, sha256Hex, type PromptSeedEntry } from '../packages/core/prompt-seed';
import { activePromptFingerprints, installPrompts, type RegisteredPrompt } from '../packages/core/prompts';
import { parseLabeledJsonl, summarizeBenchmark, type LabeledExample } from '../packages/core/decision-benchmark';
import type { decisionCall } from '../packages/core/decision-client';
import { SETS, runBenchmarkSet, type QuestionSet } from './decision-benchmark-sets';

export const MISSING_KEY_SECRET = 'OPENROUTER_API_KEY';

export interface PromptFingerprint {
  id: string;
  source: 'private' | 'public default';
  /** Row version; null for a public default. */
  version: number | null;
  /** First 12 hex of the sha256 of the text in effect. */
  hash: string;
}

export interface SetReport {
  set: string;
  promptId: string;
  promptVersion: string;
  fingerprint: PromptFingerprint;
  status: 'scored' | 'dry_run' | 'no_cases';
  cases: number;
  skippedLines: number;
  accuracy: number | null;
  baselineAccuracy: number | null;
  /** At confidence >= 0.9: share of cases covered and accuracy among them. */
  coverageAt90: number | null;
  accuracyAt90: number | null;
  errors: number;
  costUsd: number;
}

export interface EvalReport {
  source: 'private' | 'public defaults';
  loadedPrompts: number;
  dryRun: boolean;
  sets: SetReport[];
  /** Active prompt ids with no benchmark set: loaded, not measured. */
  unbenchmarked: PromptFingerprint[];
  problems: string[];
}

const short = (hex: string) => hex.slice(0, 12);

export function fingerprintOf(id: string, catalog: readonly RegisteredPrompt[]): PromptFingerprint {
  const active = activePromptFingerprints().find(f => f.id === id);
  if (active) return { id, source: 'private', version: active.version, hash: short(active.contentHash) };
  const reg = catalog.find(r => r.id === id);
  return { id, source: 'public default', version: null, hash: reg ? short(sha256Hex(reg.publicDefault)) : '-' };
}

/** Load a prompts directory with the deploy seed's checks and make it the text in effect. */
export async function installPromptsDir(dir: string, catalog: readonly RegisteredPrompt[]): Promise<PromptSeedEntry[]> {
  const entries = await loadPromptSeed(dirPromptReader(dir), catalog);
  installPrompts(entries);
  return entries;
}

export interface EvalOptions {
  catalog: readonly RegisteredPrompt[];
  /** Null: score the public defaults. */
  entries: readonly PromptSeedEntry[] | null;
  casesDir: string | null;
  dryRun: boolean;
  require: boolean;
  apiKey: string | null;
  model?: string;
  concurrency?: number;
  decide?: typeof decisionCall;
  sets?: Record<string, QuestionSet>;
}

export async function runPrivatePromptEval(opts: EvalOptions): Promise<EvalReport> {
  const sets = opts.sets ?? SETS;
  const problems: string[] = [];
  if (opts.require && !opts.entries?.length) problems.push('no private prompt text was loaded');
  if (opts.require && !opts.dryRun && !opts.apiKey) problems.push(`${MISSING_KEY_SECRET} is not set, so no decision call can be made (set the repo secret ${MISSING_KEY_SECRET})`);

  const reports: SetReport[] = [];
  for (const [name, set] of Object.entries(sets)) {
    const file = opts.casesDir ? join(opts.casesDir, `${name.replace(/_/g, '-')}.jsonl`) : null;
    const base = {
      set: name,
      promptId: set.promptId,
      promptVersion: set.promptVersion(),
      fingerprint: fingerprintOf(set.promptId, opts.catalog),
      accuracy: null,
      baselineAccuracy: null,
      coverageAt90: null,
      accuracyAt90: null,
      errors: 0,
      costUsd: 0,
    };
    if (!file || !existsSync(file)) {
      reports.push({ ...base, status: 'no_cases', cases: 0, skippedLines: 0 });
      continue;
    }
    const { examples, skipped } = parseLabeledJsonl(readFileSync(file, 'utf8'), { labelField: set.labelField });
    if (examples.length === 0) {
      reports.push({ ...base, status: 'no_cases', cases: 0, skippedLines: skipped });
      continue;
    }
    if (opts.dryRun || !opts.apiKey) {
      // Exercise the resolve path for every case, so a dry run still proves the
      // questions in effect can be built for the labelled data.
      examples.forEach((ex: LabeledExample) => set.questionsFor(ex.fields));
      reports.push({ ...base, status: 'dry_run', cases: examples.length, skippedLines: skipped });
      continue;
    }
    const run = await runBenchmarkSet(set, examples, { apiKey: opts.apiKey, model: opts.model, concurrency: opts.concurrency, decide: opts.decide });
    const s = summarizeBenchmark(run.scored);
    const at90 = s.thresholds.find(t => t.threshold === 0.9);
    reports.push({
      ...base,
      status: 'scored',
      cases: examples.length,
      skippedLines: skipped,
      accuracy: s.accuracy,
      baselineAccuracy: s.baselineAccuracy,
      coverageAt90: at90?.coverage ?? null,
      accuracyAt90: at90?.accuracy ?? null,
      errors: s.errors,
      costUsd: run.costUsd,
    });
  }

  if (opts.require && !reports.some(r => r.cases > 0)) {
    problems.push(`no labelled cases found${opts.casesDir ? ' under the cases directory' : ''} (expected <set>.jsonl, e.g. task-category.jsonl)`);
  }
  if (opts.require && reports.some(r => r.cases > 0 && r.fingerprint.source !== 'private')) {
    problems.push(`a benchmarked prompt is not in the private text: ${reports.filter(r => r.cases > 0 && r.fingerprint.source !== 'private').map(r => r.promptId).join(', ')}`);
  }
  if (opts.require && !opts.dryRun && reports.some(r => r.status === 'scored' && r.errors === r.cases)) {
    problems.push(`every decision call failed for: ${reports.filter(r => r.status === 'scored' && r.errors === r.cases).map(r => r.set).join(', ')}`);
  }

  const benchmarked = new Set(Object.values(sets).map(s => s.promptId));
  const unbenchmarked = (opts.entries ?? [])
    .filter(e => !benchmarked.has(e.id))
    .map(e => fingerprintOf(e.id, opts.catalog))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    source: opts.entries ? 'private' : 'public defaults',
    loadedPrompts: opts.entries?.length ?? 0,
    dryRun: opts.dryRun,
    sets: reports,
    unbenchmarked,
    problems,
  };
}

const pct = (v: number | null) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
const fp = (f: PromptFingerprint) => (f.version == null ? `public \`${f.hash}\`` : `v${f.version} \`${f.hash}\``);

export function formatEvalSummary(r: EvalReport): string {
  const lines: string[] = [];
  lines.push(`## Private prompt eval${r.dryRun ? ' (dry run)' : ''}`);
  lines.push('');
  lines.push(`Text scored: ${r.source}${r.source === 'private' ? ` (${r.loadedPrompts} prompt(s) loaded)` : ''}. Scores are over every labelled case; prompt text and case content are never printed.`);
  lines.push('');
  lines.push('| set | prompt id | fingerprint | prompt version | status | cases | accuracy | baseline | coverage @0.9 | accuracy @0.9 | errors | cost |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of r.sets) {
    lines.push(`| ${s.set} | \`${s.promptId}\` | ${fp(s.fingerprint)} | \`${s.promptVersion}\` | ${s.status} | ${s.cases} | ${pct(s.accuracy)} | ${pct(s.baselineAccuracy)} | ${pct(s.coverageAt90)} | ${pct(s.accuracyAt90)} | ${s.errors} | $${s.costUsd.toFixed(4)} |`);
  }
  if (r.unbenchmarked.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${r.unbenchmarked.length} loaded prompt(s) with no benchmark set</summary>`);
    lines.push('');
    for (const f of r.unbenchmarked) lines.push(`- \`${f.id}\` ${fp(f)}`);
    lines.push('');
    lines.push('</details>');
  }
  if (r.problems.length > 0) {
    lines.push('');
    lines.push('### Failed');
    for (const p of r.problems) lines.push(`- ${p}`);
  }
  return `${lines.join('\n')}\n`;
}

// ── Leak guard ────────────────────────────────────────────────────────────────

const MIN_FRAGMENT = 24;
/**
 * Windows of WINDOW chars every STEP chars: any excerpt of WINDOW + STEP chars
 * or more cut from anywhere in a longer piece contains one whole window.
 */
const WINDOW = 32;
const STEP = 8;

/** Distinctive pieces of a body: JSON string leaves or text lines, plus overlapping windows of long ones. */
function fragmentsOf(body: string): string[] {
  let pieces: string[];
  try {
    const leaves: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') leaves.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JSON.parse(body));
    pieces = leaves.flatMap(l => l.split(/\r?\n/));
  } catch {
    pieces = body.split(/\r?\n/);
  }
  const out = new Set<string>();
  for (const raw of pieces) {
    const p = raw.trim().replace(/\s+/g, ' ');
    if (p.length < MIN_FRAGMENT) continue;
    out.add(p);
    for (let i = 0; i + WINDOW <= p.length; i += STEP) out.add(p.slice(i, i + WINDOW));
  }
  return [...out];
}

/** The ids whose body text appears in `output`. Empty means the output is safe to publish. */
export function findPromptLeaks(output: string, bodies: ReadonlyArray<{ id: string; body: string }>): string[] {
  const hay = output.replace(/\s+/g, ' ');
  return bodies.filter(b => fragmentsOf(b.body).some(f => hay.includes(f))).map(b => b.id);
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
