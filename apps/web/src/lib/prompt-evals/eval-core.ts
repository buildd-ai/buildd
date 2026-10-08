/**
 * The prompt eval's core: score every decision benchmark set that has labelled
 * cases over the prompt text in effect, and report per prompt id the version
 * and content-hash fingerprint that was scored next to its scores.
 *
 * Shared by the CLI (`scripts/private-prompt-eval.ts`, a checkout of a
 * prompts directory) and the server-side eval (`./run.ts`, the prompts repo
 * read through the GitHub App). Which text is "in effect" is the caller's
 * business: the CLI installs it process-wide, the server scopes it with
 * `withPromptOverlay` so live calls never see it.
 *
 * Nothing in a report carries prompt text or case content: ids, versions,
 * hashes, counts and rates only. `findPromptLeaks` is the check every caller
 * runs over its output before writing it anywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, type PromptSeedEntry } from '@buildd/core/prompt-seed';
import { activePromptFingerprints, type RegisteredPrompt } from '@buildd/core/prompts';
import { parseLabeledJsonl, summarizeBenchmark, type LabeledExample } from '@buildd/core/decision-benchmark';
import type { decisionCall } from '@buildd/core/decision-client';
import type { DecisionEndpoint } from '@builddai/ai-kit/decide';
import { SETS, runBenchmarkSet, type QuestionSet } from './benchmark-sets';

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
  /** Cases never started because the run's time budget ran out. */
  notRun: number;
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

/** The labelled-cases file name for a set: `task_category` -> `task-category.jsonl`. */
export const casesFileFor = (set: string) => `${set.replace(/_/g, '-')}.jsonl`;

export interface EvalOptions {
  catalog: readonly RegisteredPrompt[];
  /** Null: score the public defaults. */
  entries: readonly PromptSeedEntry[] | null;
  /** A directory of `<set>.jsonl` files (the CLI). */
  casesDir?: string | null;
  /** Or a reader: the file's text, or null when there is none (the server). Wins over `casesDir`. */
  readCases?: (file: string) => Promise<string | null>;
  dryRun: boolean;
  require: boolean;
  /**
   * With `require`, also fail when no set has labelled cases (default: same as
   * `require`). The server passes false: a set without cases is reported as
   * having no eval set, which is an answer, not a failure.
   */
  requireCases?: boolean;
  apiKey: string | null;
  /** Where the key is sent (default: Jev on OpenRouter). */
  endpoint?: DecisionEndpoint;
  model?: string;
  concurrency?: number;
  /** Epoch ms after which no new case is started; the rest are counted as not run. */
  deadlineAt?: number;
  decide?: typeof decisionCall;
  sets?: Record<string, QuestionSet>;
  /** The problem reported when there is no key (default names the CLI's env var). */
  missingKeyProblem?: string;
}

function casesReader(opts: EvalOptions): ((file: string) => Promise<string | null>) | null {
  if (opts.readCases) return opts.readCases;
  const dir = opts.casesDir;
  if (!dir) return null;
  return async file => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
}

export async function runPrivatePromptEval(opts: EvalOptions): Promise<EvalReport> {
  const sets = opts.sets ?? SETS;
  const problems: string[] = [];
  if (opts.require && !opts.entries?.length) problems.push('no private prompt text was loaded');
  const missingKey = opts.missingKeyProblem ?? `${MISSING_KEY_SECRET} is not set, so no decision call can be made (set the repo secret ${MISSING_KEY_SECRET})`;
  const casesOptional = opts.requireCases === false;
  if (opts.require && !casesOptional && !opts.dryRun && !opts.apiKey) problems.push(missingKey);
  const read = casesReader(opts);

  const reports: SetReport[] = [];
  for (const [name, set] of Object.entries(sets)) {
    const text = read ? await read(casesFileFor(name)) : null;
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
      notRun: 0,
      costUsd: 0,
    };
    if (text === null) {
      reports.push({ ...base, status: 'no_cases', cases: 0, skippedLines: 0 });
      continue;
    }
    const { examples, skipped } = parseLabeledJsonl(text, { labelField: set.labelField });
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
    const run = await runBenchmarkSet(set, examples, {
      apiKey: opts.apiKey,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      model: opts.model,
      concurrency: opts.concurrency,
      decide: opts.decide,
      ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
    });
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
      notRun: run.notRun,
      costUsd: run.costUsd,
    });
  }

  // Cases optional: a missing key only matters when there was something to score.
  if (opts.require && casesOptional && !opts.dryRun && !opts.apiKey && reports.some(r => r.cases > 0)) problems.unshift(missingKey);
  if (opts.require && !casesOptional && !reports.some(r => r.cases > 0)) {
    problems.push(`no labelled cases found${opts.casesDir ? ' under the cases directory' : ''} (expected <set>.jsonl, e.g. task-category.jsonl)`);
  }
  if (opts.require && reports.some(r => r.cases > 0 && r.fingerprint.source !== 'private')) {
    problems.push(`a benchmarked prompt is not in the private text: ${reports.filter(r => r.cases > 0 && r.fingerprint.source !== 'private').map(r => r.promptId).join(', ')}`);
  }
  if (opts.require && !opts.dryRun && reports.some(r => r.status === 'scored' && r.cases > r.notRun && r.errors === r.cases - r.notRun)) {
    problems.push(`every decision call failed for: ${reports.filter(r => r.status === 'scored' && r.cases > r.notRun && r.errors === r.cases - r.notRun).map(r => r.set).join(', ')}`);
  }
  if (reports.some(r => r.notRun > 0)) {
    problems.push(`the time budget ran out before every case was scored: ${reports.filter(r => r.notRun > 0).map(r => `${r.set} (${r.notRun} not run)`).join(', ')}`);
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

