/**
 * Controlled replay evaluation of local models: pure rules.
 *
 * A "case" is a past, already-fixed bug of this repository. The agent gets the
 * original problem statement and an export of the pre-fix tree with no Git
 * history; the evaluator, afterwards and outside that tree, injects hidden
 * regression tests and runs them. Nothing here touches disk, Git, Ollama or
 * the database; `scripts/local-eval/` does the I/O and
 * `apps/web/src/lib/model-observation-store.ts` stores the result.
 *
 * Replay results are CONTROLLED (same cases, prompt, budgets and context for
 * every model) but they are replays of public history: a model may have seen
 * the fix in training. They are replay evidence, never a claim about
 * uncontaminated generalisation, and every case carries that note.
 */
import { createHash } from 'node:crypto';
import { buildObservation, type ObservationValues } from './model-observation';

export const SUITE_FORMAT_VERSION = 1;
/** Bump when scoring, tamper rules or the prompt template change; old results stay comparable only within one value. */
export const SCORING_VERSION = 'score-v1';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface CaseAdmission {
  /** The hidden regression, run on the pre-fix tree. Must fail. */
  preFix: 'fail' | 'pass' | 'unrun';
  /** The same checks on the reference fix. Must pass. */
  reference: 'fail' | 'pass' | 'unrun';
  /** The visible (already existing) checks on the pre-fix tree. Must pass, or they cannot detect breakage. */
  visibleOnPreFix: 'fail' | 'pass' | 'unrun';
  admittedOn: string | null;
  toolchain: string;
}

export interface SuiteCase {
  id: string;
  title: string;
  difficulty: Difficulty;
  /** Plain-language problem, written from the public change title; the only text the agent receives about the bug. */
  problem: string;
  /** Public provenance: merge commit subject of the reference fix. */
  reference: { fixSha: string; preFixSha: string; subject: string };
  /** Test files the evaluator copies in after the run (from `fixSha`). Never present in the agent tree. */
  hiddenTests: string[];
  /** Existing test files that must still pass (present at the pre-fix SHA). */
  visibleTests: string[];
  /** Source files the reference fix changed (not the tests): size of the work, never shown to the agent. */
  fixTouchesFiles: number;
  setup: { requires: string[]; network: false; credentials: false };
  expected: string;
  contamination: string;
  admission: CaseAdmission;
}

export interface Suite {
  suiteId: string;
  suiteVersion: string;
  formatVersion: number;
  scoringVersion: string;
  policy: RunPolicy;
  cases: SuiteCase[];
}

/** Identical for every model and trial. */
export interface RunPolicy {
  promptTemplate: string;
  maxTurns: number;
  wallClockSeconds: number;
  contextTokens: number[];
  trials: number;
  context: 'problem-and-pre-fix-tree-only';
}

export interface ModelEntry {
  tag: string;
  /** Digest as pulled; null until a run records the observed value. Never guessed. */
  digest: string | null;
  tier: 'baseline' | 'candidate' | 'later';
}

const SHA = /^[0-9a-f]{40}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Errors that make a suite unusable; an empty array is a valid suite. */
export function validateSuite(s: Suite): string[] {
  const errs: string[] = [];
  if (s.formatVersion !== SUITE_FORMAT_VERSION) errs.push(`formatVersion must be ${SUITE_FORMAT_VERSION}`);
  if (s.scoringVersion !== SCORING_VERSION) errs.push(`scoringVersion must be ${SCORING_VERSION}`);
  if (!s.suiteVersion) errs.push('suiteVersion is required');
  if (!s.policy.promptTemplate.includes('{{problem}}')) errs.push('promptTemplate must contain {{problem}}');
  if (!(s.policy.trials >= 1)) errs.push('policy.trials must be at least 1');
  const seen = new Set<string>();
  for (const c of s.cases) {
    const at = `case ${c.id}`;
    if (seen.has(c.id)) errs.push(`${at}: duplicate id`);
    seen.add(c.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errs.push(`${at}: id must be kebab-case`);
    if (!SHA.test(c.reference.fixSha) || !SHA.test(c.reference.preFixSha)) errs.push(`${at}: shas must be full 40-hex`);
    if (c.reference.fixSha === c.reference.preFixSha) errs.push(`${at}: fix and pre-fix sha are the same`);
    if (!c.hiddenTests.length) errs.push(`${at}: needs at least one hidden test`);
    for (const t of c.hiddenTests) if (!TEST_FILE.test(t)) errs.push(`${at}: hidden test ${t} is not a test file`);
    for (const t of c.visibleTests) if (c.hiddenTests.includes(t)) errs.push(`${at}: ${t} is both hidden and visible`);
    if (!c.contamination.trim()) errs.push(`${at}: contamination note is required`);
    if (c.setup.network !== false || c.setup.credentials !== false) errs.push(`${at}: must need no network and no credentials`);
    if (!DIFFICULTIES.includes(c.difficulty)) errs.push(`${at}: unknown difficulty`);
    // The agent sees `problem` only. It must not carry the answer or a production identifier.
    const answerBearing = [c.reference.fixSha, c.reference.preFixSha.slice(0, 10), c.reference.fixSha.slice(0, 10), ...c.hiddenTests];
    for (const a of answerBearing) if (c.problem.includes(a)) errs.push(`${at}: problem text leaks ${a}`);
    if (UUID.test(c.problem)) errs.push(`${at}: problem text contains a UUID`);
    if (/\(#\d+\)|pull\/\d+/.test(c.problem)) errs.push(`${at}: problem text cites a PR`);
    const a = c.admission;
    if (a.admittedOn !== null) {
      if (a.preFix !== 'fail') errs.push(`${at}: admitted but the regression did not fail on the pre-fix tree`);
      if (a.reference !== 'pass') errs.push(`${at}: admitted but the reference fix did not pass`);
      if (a.visibleOnPreFix !== 'pass') errs.push(`${at}: admitted but visible tests do not pass on the pre-fix tree`);
    }
  }
  return errs;
}

export function admittedCases(s: Suite): SuiteCase[] {
  return s.cases.filter((c) => c.admission.admittedOn !== null);
}

/** The exact prompt, identical across models. Hash it so a run record proves what was sent. */
export function buildPrompt(s: Suite, c: SuiteCase): { text: string; hash: string } {
  const text = s.policy.promptTemplate.replaceAll('{{problem}}', c.problem);
  return { text, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

/** What the agent-visible workspace looks like, as measured by the harness. */
export interface WorkspaceProbe {
  paths: string[];
  /**
   * Hidden test paths whose content in the workspace equals the fix commit's
   * version. A hidden test file usually exists in an older form at the pre-fix
   * SHA; only the fixed form gives the answer away.
   */
  answerBearingTests: string[];
  /** Output of `git log --format=%H --all` in the workspace; empty when there is no repository. */
  commits: string[];
  /** Remotes configured in the workspace's Git metadata. */
  remotes: string[];
}

/** Anything the agent could read that gives away the answer. Empty = isolated. */
export function leakFindings(c: SuiteCase, probe: WorkspaceProbe): string[] {
  const out: string[] = [];
  for (const t of probe.answerBearingTests) if (c.hiddenTests.includes(t)) out.push(`hidden test present: ${t}`);
  for (const p of probe.paths) {
    if (/(^|\/)(reference|solution)[^/]*\.(patch|diff)$/i.test(p) || /(^|\/)local-suite\//.test(p)) out.push(`grading material present: ${p}`);
  }
  if (probe.commits.length > 1) out.push(`workspace has ${probe.commits.length} commits; expected one baseline commit`);
  if (probe.commits.includes(c.reference.fixSha)) out.push('workspace history contains the fix commit');
  if (probe.remotes.length) out.push('workspace has a Git remote');
  return out;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Unified diff of the file; may be empty for a binary or a delete. */
  patch: string;
}

const SKIP_ADDED = /(\b(it|test|describe)\.(skip|todo)\b|\b(xit|xdescribe|xtest)\s*\(|\.skipIf\s*\(|\bif\s*\(\s*(false|0)\s*\))/;
const RUNNER_FILES = /^(bunfig\.toml|scripts\/run-unit-tests\.ts|scripts\/affected-tests\.ts|package\.json)$/;
const ASSERT_LINE = /\b(expect|assert)\b\s*[.(]|\b(it|test)\s*\(/;

/**
 * Edits that make a test pass without making the code right. Findings are
 * evidence for a human or the reviewer; any finding makes the run `invalid`
 * under score-v1. Adding new tests is fine.
 */
export function detectTestTampering(changed: readonly ChangedFile[], c: Pick<SuiteCase, 'hiddenTests' | 'visibleTests'>): string[] {
  const out: string[] = [];
  const watched = new Set([...c.hiddenTests, ...c.visibleTests]);
  for (const f of changed) {
    const isTest = TEST_FILE.test(f.path);
    if (RUNNER_FILES.test(f.path) && f.status !== 'added') {
      // package.json: only a change to a script entry matters; others are ordinary dependency edits.
      if (f.path !== 'package.json' || /^[-+]\s*"(test|test:[^"]*)"\s*:/m.test(f.patch)) out.push(`test runner configuration edited: ${f.path}`);
    }
    if (!isTest) continue;
    if (f.status === 'deleted') { out.push(`test file deleted: ${f.path}`); continue; }
    if (watched.has(f.path) && f.status === 'added') out.push(`protected test path replaced: ${f.path}`);
    let removed = 0;
    let added = 0;
    for (const line of f.patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+') && SKIP_ADDED.test(line)) out.push(`test disabled in ${f.path}: ${line.slice(1).trim().slice(0, 80)}`);
      if (line.startsWith('-') && ASSERT_LINE.test(line)) removed++;
      if (line.startsWith('+') && ASSERT_LINE.test(line)) added++;
    }
    if (f.status === 'modified' && removed > 0 && added < removed) out.push(`assertions removed in ${f.path} (${removed} removed, ${added} added)`);
  }
  return [...new Set(out)];
}

export type RunResult = 'pass' | 'fail' | 'invalid' | 'error' | 'unscored';

export interface CheckOutcome { ran: boolean; passed: boolean | null }

/**
 * score-v1. `pass` needs the hidden regression AND every visible test green
 * and no tampering. Exact patch equality is never required. A harness failure
 * (the model never ran, the checkout broke) is `error`, not a model failure.
 */
export function scoreRun(input: { harnessError: boolean; hidden: CheckOutcome; visible: CheckOutcome; tampering: string[]; leaks: string[] }): RunResult {
  if (input.harnessError) return 'error';
  if (input.leaks.length) return 'invalid';
  if (input.tampering.length) return 'invalid';
  if (!input.hidden.ran) return 'unscored';
  if (input.hidden.passed !== true) return 'fail';
  if (!input.visible.ran) return 'unscored';
  return input.visible.passed === true ? 'pass' : 'fail';
}

export interface ReviewRecord {
  /** Fixed reviewer model and rubric, the same for every run. */
  reviewer: string;
  rubricVersion: string;
  verdict: 'approved' | 'changes_requested';
  reworkRounds: number;
}

/** One executed run: the artifact the runner writes and the ingest route accepts. */
export interface RunRecord {
  runId: string;
  suiteId: string;
  suiteVersion: string;
  scoringVersion: string;
  caseId: string;
  trial: number;
  /** Model tag + context, e.g. `qwen3-coder:30b@16384`. Stable across trials. */
  configId: string;
  model: { tag: string; digest: string | null; quantization: string | null };
  contextTokens: number;
  promptHash: string;
  harness: { name: string; version: string | null };
  runtime: { os?: string; arch?: string; gpu?: string; gpuMemoryMb?: number } | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number | null;
  peakVramMb: number | null;
  vramSamples: number | null;
  result: RunResult;
  hidden: CheckOutcome;
  visible: CheckOutcome;
  tampering: string[];
  leaks: string[];
  review: ReviewRecord | null;
  harnessNote: string | null;
}

/** Stored on the observation row. Marks it controlled and says which case and configuration it answers. */
export interface EvaluationAttribution {
  provenance: 'controlled_replay';
  suiteId: string;
  suiteVersion: string;
  scoringVersion: string;
  caseId: string;
  trial: number;
  runId: string;
  configId: string;
  contextTokens: number;
  promptHash: string;
  result: RunResult;
}

export function evaluationOf(r: RunRecord): EvaluationAttribution {
  return {
    provenance: 'controlled_replay',
    suiteId: r.suiteId,
    suiteVersion: r.suiteVersion,
    scoringVersion: r.scoringVersion,
    caseId: r.caseId,
    trial: r.trial,
    runId: r.runId,
    configId: r.configId,
    contextTokens: r.contextTokens,
    promptHash: r.promptHash,
    result: r.result,
  };
}

/** A stable UUID-shaped id from a seed, so re-ingesting the same run updates one row. */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Why a run record cannot be ingested; empty = fine. The route runs this on untrusted input. */
export function validateRunRecord(r: unknown): string[] {
  const errs: string[] = [];
  const o = (r ?? {}) as Partial<RunRecord>;
  for (const k of ['runId', 'suiteId', 'suiteVersion', 'scoringVersion', 'caseId', 'configId', 'promptHash', 'startedAt', 'endedAt'] as const) {
    if (typeof o[k] !== 'string' || !(o[k] as string) || (o[k] as string).length > 120) errs.push(`${k} is required`);
  }
  if (!Number.isInteger(o.trial) || (o.trial as number) < 1) errs.push('trial must be a positive integer');
  if (!o.model || typeof o.model.tag !== 'string' || !o.model.tag) errs.push('model.tag is required');
  if (!['pass', 'fail', 'invalid', 'error', 'unscored'].includes(o.result as string)) errs.push('result is not a known value');
  if (o.scoringVersion && o.scoringVersion !== SCORING_VERSION) errs.push(`scoringVersion ${o.scoringVersion} is not ${SCORING_VERSION}`);
  if (Number.isNaN(Date.parse(o.startedAt ?? '')) || Number.isNaN(Date.parse(o.endedAt ?? ''))) errs.push('startedAt and endedAt must be ISO times');
  return errs;
}

/**
 * Map a run to the observation row it ingests as. Unknown stays unknown:
 * tokens, VRAM and review are null when the run did not measure them.
 * `result: error` (a harness failure) is recorded with the closed exit cause `silent_start`, so `failureOrigin` is `harness`; `fail`
 * and `invalid` are model failures of the task, not of the attempt.
 */
export function runToObservation(
  r: RunRecord,
  scope: { workspaceId: string; teamId: string },
): { values: ObservationValues; evaluation: EvaluationAttribution; evidence: { reviewVerdict: 'approved' | 'changes_requested' | null; ciState: 'passed' | 'failed' | null; specVerdict: 'pass' | 'fail' | null; reworked: boolean } } {
  const workerId = deterministicUuid(`worker:${r.runId}`);
  const values = buildObservation({
    workerId,
    attempt: r.trial,
    taskId: null,
    workspaceId: scope.workspaceId,
    teamId: scope.teamId,
    // The case is the matching unit: every configuration run on it shares this chain.
    chainId: deterministicUuid(`case:${r.suiteId}:${r.suiteVersion}:${r.caseId}`),
    parentWorkerId: null,
    resolvedModel: r.model.tag,
    taskClass: `replay/${r.caseId}`,
    modelRoute: null,
    localModel: true,
    startedAt: new Date(r.startedAt),
    endedAt: new Date(r.endedAt),
    durationMs: r.durationMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    turns: r.turns,
    retries: 0,
    status: r.result === 'error' ? 'failed' : 'completed',
    exitCause: r.result === 'error' ? 'silent_start' : null,
    costUsd: null,
    costBasis: null,
    priced: false,
    descriptor: {
      endpointKind: 'local_loopback',
      modelVersion: r.model.digest ?? undefined,
      quantization: r.model.quantization ?? undefined,
      contextWindow: r.contextTokens,
      backend: r.harness.name,
      harnessVersion: r.harness.version ?? undefined,
      runtime: r.runtime ?? undefined,
      peakVramMb: r.peakVramMb ?? undefined,
      vramSamples: r.vramSamples ?? undefined,
      attempt: r.trial,
    },
  });
  const graded = r.result === 'pass' || r.result === 'fail' || r.result === 'invalid';
  return {
    values,
    evaluation: evaluationOf(r),
    evidence: {
      // The hidden regression plus visible tests are independent of the worker's own claim.
      specVerdict: graded ? (r.result === 'pass' ? 'pass' : 'fail') : null,
      ciState: r.visible.ran ? (r.visible.passed ? 'passed' : 'failed') : null,
      reviewVerdict: r.review?.verdict ?? null,
      reworked: (r.review?.reworkRounds ?? 0) > 0,
    },
  };
}

/** Parse `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`. */
export function parseGpuMemory(output: string): { usedMb: number; totalMb: number }[] | null {
  const gpus: { usedMb: number; totalMb: number }[] = [];
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(\d+)\s*,\s*(\d+)$/.exec(t);
    if (!m) return null;
    gpus.push({ usedMb: Number(m[1]), totalMb: Number(m[2]) });
  }
  return gpus.length ? gpus : null;
}

/**
 * Whether a model may be loaded now. Needs a readable GPU, nothing else
 * already loaded in Ollama, and `minFreeMb` free. Unknown readings refuse:
 * a run on an unmeasured GPU would record memory it cannot back.
 */
export function gpuGate(input: { gpus: { usedMb: number; totalMb: number }[] | null; loadedModels: string[]; minFreeMb: number }): { ok: boolean; reason: string } {
  if (!input.gpus) return { ok: false, reason: 'GPU memory could not be read (nvidia-smi missing or unparsable); refusing to load a model' };
  if (input.loadedModels.length) return { ok: false, reason: `Ollama already has ${input.loadedModels.join(', ')} loaded; unload it first (one GPU model at a time)` };
  const free = input.gpus.reduce((n, g) => n + (g.totalMb - g.usedMb), 0);
  if (free < input.minFreeMb) return { ok: false, reason: `only ${free} MiB free, ${input.minFreeMb} MiB needed; another process is using the GPU` };
  return { ok: true, reason: `${free} MiB free` };
}

/** Whether an Ollama tag's digest matches what the suite expects; a null expectation records, never matches. */
export function digestCheck(expected: string | null, observed: string | null): { ok: boolean; note: string } {
  if (!observed) return { ok: false, note: 'digest not reported by Ollama' };
  if (expected === null) return { ok: true, note: `first observation, record ${observed}` };
  return expected === observed ? { ok: true, note: 'matches' } : { ok: false, note: `digest changed: expected ${expected}, got ${observed}` };
}
