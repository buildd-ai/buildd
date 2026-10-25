/**
 * Why a PR's checks are red, in the words Home puts on its card
 * (docs/specs/surface-ia-home-missions-initiatives.md §11).
 *
 * "Tests are failing." told nobody which job failed or whether it was the code.
 * This names the job (folding a summary gate into the jobs it reports on),
 * takes the failing lines from the log rather than its tail, and decides by
 * rule whether the failure looks like a flake, so the card can offer a re-run
 * before it spends an agent on a fix.
 *
 * Pure and log-shaped, no network: the server side that fetches logs and
 * stores the record is `red-check-record.ts`. Home and the dev fixtures read
 * this from the client too, so it imports nothing.
 */

/** Log lines that name an infrastructure fault. Specific on purpose: a test failure must never match. */
export const INFRA_SIGNATURES: ReadonlyArray<{ slug: string; pattern: RegExp }> = [
  { slug: 'registry_rate_limit', pattern: /toomanyrequests|You have reached your (pull|unauthenticated pull) rate limit|Data limit exceeded/i },
  { slug: 'image_pull_failed', pattern: /error pulling image|Error response from daemon: (pull access denied|manifest .* not found|Get "https?:\/\/[^"]*": (dial tcp|net\/http|context deadline|EOF))/i },
  { slug: 'registry_unavailable', pattern: /TLS handshake timeout|received unexpected HTTP status: 5\d\d|failed to (resolve|copy): .*(5\d\d|i\/o timeout)/i },
  { slug: 'runner_lost', pattern: /The runner has received a shutdown signal|lost communication with the server|The hosted runner encountered an error/i },
];

/** Slug of the first infrastructure signature in a job log, or null. */
export function detectInfraFailure(log: string | null | undefined): string | null {
  if (!log) return null;
  for (const { slug, pattern } of INFRA_SIGNATURES) if (pattern.test(log)) return slug;
  return null;
}

/** The database server dropped the test's connections: the environment, not the code. */
const DB_CONNECTION_LOST = /terminating connection due to administrator command|Connection terminated unexpectedly|server closed the connection unexpectedly/i;

/**
 * scripts/run-db-tests.ts's summary. The job stops Postgres after it, and the
 * neon-sql-shim logs `terminating connection due to administrator command` for
 * every pooled client on the way down: that is teardown, not a cause.
 */
const DB_TESTS_SUMMARY = /^\[test:db\] \d+(?:\/\d+)? file\(s\) (?:failed|passed)/;

/** A test's result line; bun prints a test's output before it. */
const TEST_RESULT = /^\((?:pass|fail|skip|todo)\)\s/;

/**
 * The database dropped the connections while the tests ran, and that is all
 * that went wrong. Matched only before the job's own summary and teardown, and
 * every failing test must carry the termination in its own output: a test that
 * failed without it, or a type error, is the code's, whatever the shim prints
 * when Postgres stops.
 */
function dbConnectionLost(log: string): boolean {
  const lines = ownSteps(cleanLines(log)).map(l => l.trim());
  const summary = lines.findIndex(l => DB_TESTS_SUMMARY.test(l));
  const run = summary === -1 ? lines : lines.slice(0, summary);
  let lost = false;
  let lostInThisTest = false;
  for (const l of run) {
    if (DB_CONNECTION_LOST.test(l)) lost = lostInThisTest = true;
    if (/^\(fail\)\s/.test(l) && !lostInThisTest) return false;
    if (TEST_RESULT.test(l)) lostInThisTest = false;
    else if (ASSERTION.some(re => re.test(l))) return false;
  }
  return lost;
}

/**
 * What a re-run of the same code is expected to clear: the database dropping
 * its connections, or an infra signature. `ci-infra-failure.ts` re-runs on it.
 *
 * When the log names a failing test, only what came before the first one
 * counts: an environment fault that caused it precedes it, while a test that
 * failed on its own and then tore its database down logs the drop after
 * (e2ea3764: a real snapshot-column failure was re-run as infrastructure).
 */
export function detectRerunnableFailure(log: string | null | undefined): string | null {
  if (!log) return null;
  const lines = cleanLines(log);
  const firstFailure = lines.findIndex(l => ASSERTION.some(re => re.test(l.trim())));
  const text = firstFailure === -1 ? log : lines.slice(0, firstFailure).join('\n');
  if (dbConnectionLost(log)) return 'db_connection_lost';
  return detectInfraFailure(text);
}
/** The job or step ran out of time. */
const TIMED_OUT = /has timed out after \d+|exceeded the maximum execution time|SIGTERM received before the run finished/i;

// ── Failing lines ────────────────────────────────────────────────────────────

/** Actions prefixes every log line with an ISO timestamp (and the first with a BOM). */
const TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
/** Where a job's own steps end: everything after is checkout and cache cleanup. */
const POST_JOB = /^(?:Post job cleanup\.|##\[group\]Post |Cleaning up orphan processes)/;
/** Restates the exit code and crowds out the line that names the cause. */
const USELESS = /Process completed with exit code/;
/** A line that names a failing test or an error. */
const FAILING = [
  /^\(fail\)\s/,
  /^\s*x\s+\S/,
  /[✗✖]\s/,
  /\berror TS\d+:/,
  /^##\[error\]/,
  /^::error/,
  /^(?:error|ERROR):/,
  /\bAssertionError\b/,
  /^FAIL\s/,
  /failed so far:/,
  DB_CONNECTION_LOST,
  TIMED_OUT,
];
/** A line naming one failing test, and the name it carries. */
const TEST_NAME = [/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/, /^\s*x\s+(.+)$/, /^\s*[✗✖]\s+(.+)$/];
const MAX_LINES = 20;
const FALLBACK_TAIL = 15;

function cleanLines(log: string): string[] {
  return log.replace(/\r/g, '').split('\n').map(l => l.replace(TIMESTAMP, '').trimEnd());
}

/** The job's own output: the log up to its post-job cleanup. */
function ownSteps(lines: string[]): string[] {
  const end = lines.findIndex(l => POST_JOB.test(l.trim()));
  return end === -1 ? lines : lines.slice(0, end);
}

/** scripts/run-unit-tests.ts's own digest: `N of M unit test files failed:` up to `Full output:`. */
function unitTestDigest(lines: string[]): string[] | null {
  const start = lines.findIndex(l => /\d+ of \d+ unit test files? failed:/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start);
  const end = rest.findIndex(l => l.startsWith('Full output:'));
  const block = (end === -1 ? rest : rest.slice(0, end)).filter(l => l.trim() !== '');
  return block.length > 0 ? block : null;
}

/**
 * The failing test or error lines of a job log, never its last lines alone
 * (R-2): cleanup after the job's steps is cut, the runner's own digest wins
 * when present, then every failing line in order, deduped. Only when nothing
 * names a failure does it fall back to the end of the job's own steps.
 * Null for an empty log.
 */
export function failingLines(log: string | null | undefined, max = MAX_LINES): string | null {
  if (!log?.trim()) return null;
  const lines = ownSteps(cleanLines(log));
  const digest = unitTestDigest(lines);
  if (digest) return digest.slice(0, max).join('\n');
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l || USELESS.test(l) || seen.has(l) || !FAILING.some(re => re.test(l))) continue;
    seen.add(l);
    hits.push(l);
  }
  if (hits.length > 0) return hits.slice(0, max).join('\n');
  const tail = lines.map(l => l.trim()).filter(Boolean).slice(-FALLBACK_TAIL);
  return tail.length > 0 ? tail.join('\n') : null;
}

/**
 * The failing tests in a `.test-report.log` (scripts/run-unit-tests.ts): one
 * `--- <file> ---` section per failing file, each with bun's `(fail)` lines.
 * Read when the job log does not name the test (a killed or timed-out run).
 */
export function testReportFailures(report: string | null | undefined, max = MAX_LINES): string | null {
  if (!report?.trim()) return null;
  const out: string[] = [];
  for (const raw of cleanLines(report)) {
    const l = raw.trim();
    const file = l.match(/^--- (.+) ---$/);
    if (file) out.push(file[1]);
    else if (/^\(fail\)\s/.test(l)) out.push(`  x ${l.replace(/^\(fail\)\s+/, '').replace(/\s+\[[\d.]+m?s\]$/, '')}`);
    else if (/^INCOMPLETE RUN/.test(l)) out.push(l);
  }
  return out.length > 0 ? out.slice(0, max).join('\n') : null;
}

/** The first failing test the lines name, without timing; null when they name none. */
export function firstTestName(lines: string | null | undefined): string | null {
  for (const raw of (lines ?? '').split('\n')) {
    for (const re of TEST_NAME) {
      const m = raw.match(re);
      if (m?.[1]?.trim()) return m[1].trim();
    }
  }
  return null;
}

// ── Summary gates ────────────────────────────────────────────────────────────

/** A step whose only work is to check other jobs' results ("All build parts passed"). */
const SUMMARY_GATE_STEP = /^All\b.*\b(?:passed|succeeded)$/i;

export interface RedJobInput { name: string; step: string | null }

export function isSummaryGate(job: RedJobInput): boolean {
  return !!job.step && SUMMARY_GATE_STEP.test(job.step.trim());
}

/**
 * R-1: a summary gate is folded into the jobs it reports on, so `build` is
 * never the named failure while a real job failed. Alone, it is named.
 */
export function foldSummaryGates<T extends RedJobInput>(jobs: readonly T[]): T[] {
  const real = jobs.filter(j => !isSummaryGate(j));
  return real.length > 0 ? real : [...jobs];
}

// ── Cause ────────────────────────────────────────────────────────────────────

export type RedCauseKind = 'flake' | 'failure' | 'unknown';

/**
 * Which rule decided. `db_connection_lost`, `timeout_no_assertion` and the
 * infra slugs read as a likely flake; `test` and `error` as a real failure.
 * `red_on_base` and `unrelated_to_diff` say the job is red for a reason that
 * is not this PR's code, whatever its lines show (`applyNotThisPr`).
 */
export type RedRule = 'db_connection_lost' | 'timeout_no_assertion' | 'registry_rate_limit' | 'image_pull_failed' | 'registry_unavailable' | 'runner_lost' | 'red_on_base' | 'unrelated_to_diff' | 'test' | 'error' | 'none';

export interface RedJob {
  name: string;
  step: string | null;
  /** Failing lines (`failingLines`, or the test report's when the log names no test). */
  lines: string | null;
  rule: RedRule;
  /**
   * Set when the base branch's run at the same time was read: true when the
   * job was not red there. Absent when no base run could be compared.
   */
  baseGreen?: boolean;
}

/** A line that shows the code itself is wrong: a failing test, a type error, a thrown assertion. */
const ASSERTION = [/^\(fail\)\s/, /^\s*x\s+\S/, /[✗✖]\s/, /\berror TS\d+:/, /\bAssertionError\b/, /\d+ of \d+ unit test files? failed:/];

/**
 * R-3, by rule: one job. The full log decides the environment signatures (they
 * can sit outside the failing lines); the failing lines decide the rest. A
 * timeout counts as a flake only when nothing failed an assertion first.
 */
export function classifyJob(log: string | null | undefined, lines: string | null): RedRule {
  const text = log ?? '';
  const failed = (lines ?? '').split('\n').some(l => ASSERTION.some(re => re.test(l.trim())));
  if (dbConnectionLost(text)) return 'db_connection_lost';
  const infra = detectInfraFailure(text) as RedRule | null;
  if (infra) return infra;
  if (failed) return 'test';
  if (TIMED_OUT.test(text) || TIMED_OUT.test(lines ?? '')) return 'timeout_no_assertion';
  if ((lines ?? '').split('\n').some(l => /^##\[error\]|^::error|^(?:error|ERROR):/.test(l.trim()) && !USELESS.test(l))) return 'error';
  return 'none';
}

/** Rules that say the job is red for a reason other than this PR's code. */
const NOT_THIS_PR_RULES: ReadonlySet<RedRule> = new Set(['red_on_base', 'unrelated_to_diff']);
const FLAKE_RULES: ReadonlySet<RedRule> = new Set(['db_connection_lost', 'timeout_no_assertion', 'registry_rate_limit', 'image_pull_failed', 'registry_unavailable', 'runner_lost', ...NOT_THIS_PR_RULES]);

// ── Not this PR's code ───────────────────────────────────────────────────────

/**
 * A job whose result depends only on some paths: a PR that changes none of
 * them cannot have turned it red. Mirrors the job's own path filter, so a job
 * missing here is never called unrelated.
 */
export interface JobPathScope { job: RegExp; paths: RegExp }

/**
 * buildd's own scoped jobs (.github/workflows/build.yml `runner-changes`):
 * the Windows runner job tests only what the runner loads.
 */
export const DEFAULT_JOB_PATH_SCOPES: readonly JobPathScope[] = [
  {
    job: /^Runner unit tests \(windows\)$/,
    paths: /^(apps\/runner\/|packages\/(core|shared|ai-kit|dispatch-contract|spec-contract)\/|scripts\/(run-unit-tests|stub-server-only)\.ts$|bunfig\.toml$|bun\.lock$|package\.json$|\.gitattributes$|\.github\/workflows\/build\.yml$)/,
  },
];

/**
 * R-3, rule: the job is scoped to paths this PR's diff does not touch. A null
 * or empty `changed` (the diff could not be read) never decides.
 */
export function unrelatedToDiff(jobName: string, changed: readonly string[] | null, scopes: readonly JobPathScope[] = DEFAULT_JOB_PATH_SCOPES): boolean {
  if (!changed || changed.length === 0) return false;
  const scope = scopes.find(s => s.job.test(jobName));
  return !!scope && !changed.some(p => scope.paths.test(p));
}

/**
 * R-3, rules over the log rules: a job red on the base branch at the same
 * time, or scoped to paths the diff does not touch, is not the PR's code
 * whatever its lines say. The lines are kept for the card.
 */
export function applyNotThisPr(
  jobs: readonly RedJob[],
  ctx: { redOnBase?: ReadonlySet<string> | null; changed?: readonly string[] | null; scopes?: readonly JobPathScope[] },
): RedJob[] {
  return jobs.map(j => {
    const base = ctx.redOnBase ? { baseGreen: !ctx.redOnBase.has(j.name) } : {};
    if (ctx.redOnBase?.has(j.name)) return { ...j, ...base, rule: 'red_on_base' as const };
    if (unrelatedToDiff(j.name, ctx.changed ?? null, ctx.scopes)) return { ...j, ...base, rule: 'unrelated_to_diff' as const };
    return { ...j, ...base };
  });
}

export function causeOf(jobs: readonly RedJob[]): RedCauseKind {
  if (jobs.length === 0) return 'unknown';
  if (jobs.some(j => j.rule === 'test' || j.rule === 'error')) return 'failure';
  if (jobs.every(j => FLAKE_RULES.has(j.rule))) return 'flake';
  return 'unknown';
}

/** Stable across runs of the same failure: the job, its rule and the test it names. */
export function signatureOf(jobs: readonly RedJob[]): string {
  return jobs.map(j => [j.name, j.rule, firstTestName(j.lines) ?? ''].join('|')).sort().join('\n');
}

// ── The stored record ────────────────────────────────────────────────────────

/**
 * The decision model's reading of a head the rules left `unknown`
 * (`buildd.red_check_cause`, written by `red-check-decision.ts`). It answers
 * for the signature it read; a different failure on the same head is asked again.
 */
export interface RedJudgement {
  decision: 'environment' | 'code';
  /** Model answers only. */
  confidence: number | null;
  /** `model`, or `fallback` when no confident model answer (always `code`). */
  source: string;
  model: string | null;
  reasonCode: string;
  policyVersion: string;
  signature: string;
  at: string;
}

/** One re-run a person asked for (R-4): who, when, which run. */
export interface RedRerun { at: string; by: string; runId: number; signature: string }

/**
 * What `red-check-record.ts` keeps on the PR's owner task (`context.redChecks`)
 * for its current red head. Home reads it from there, never from GitHub.
 */
export interface RedCheckRecord {
  headSha: string;
  runId: number | null;
  runAttempt: number | null;
  at: string;
  /** Failed jobs, summary gates folded (R-1). */
  jobs: RedJob[];
  cause: RedCauseKind;
  signature: string;
  /** Re-runs asked for on this head, newest last. */
  reruns?: RedRerun[];
  /** A re-run of this head failed again with the same signature. */
  failedAfterRerun?: boolean;
  /** The decision model's reading, when the rules left the cause `unknown`. */
  judgement?: RedJudgement;
}

/**
 * The cause the card acts on: the rules', or, when they left it `unknown`,
 * the decision model's judgement of this same failure.
 */
export function effectiveCause(record: Pick<RedCheckRecord, 'cause' | 'signature' | 'judgement'>): RedCauseKind {
  const j = record.judgement;
  if (record.cause !== 'unknown' || !j || j.signature !== record.signature) return record.cause;
  return j.decision === 'environment' ? 'flake' : 'failure';
}

/**
 * Carry re-run history onto a fresh reading. The same head failing again after
 * a re-run with the same signature is `failedAfterRerun`; a new head starts clean.
 */
export function mergeRedRecord(prev: RedCheckRecord | null | undefined, next: RedCheckRecord): RedCheckRecord {
  if (!prev || prev.headSha !== next.headSha) return next;
  const reruns = prev.reruns ?? [];
  const last = reruns[reruns.length - 1];
  const reran = !!last && next.runAttempt != null && prev.runAttempt != null && next.runAttempt > prev.runAttempt;
  const failedAfterRerun = !!prev.failedAfterRerun || (reran && last.signature === next.signature);
  // A judgement answers for the failure it read: kept while the signature holds.
  const judgement = prev.judgement?.signature === next.signature ? prev.judgement : undefined;
  return { ...next, reruns, failedAfterRerun, ...(judgement ? { judgement } : {}) };
}

/** A stored value read back from JSON: the record, or null when it is not one. */
export function parseRedRecord(v: unknown): RedCheckRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<RedCheckRecord>;
  if (typeof r.headSha !== 'string' || !Array.isArray(r.jobs) || typeof r.cause !== 'string') return null;
  return r as RedCheckRecord;
}

// ── Card words ───────────────────────────────────────────────────────────────

/** Earlier automatic fixes on the PR that did not help (R-3). */
export interface RedFixHistory { pushedNothing: number; noChange: number }

/**
 * From the heads finished CI fixes were filed for: a fix filed for the head
 * that is still the head pushed nothing; one filed for an earlier head pushed
 * and the PR is still red, so it did not change the result.
 */
export function ciFixHistory(fixHeads: ReadonlyArray<string | null>, currentHead: string): RedFixHistory {
  const known = fixHeads.filter((h): h is string => !!h);
  return { pushedNothing: known.filter(h => h === currentHead).length, noChange: known.filter(h => h !== currentHead).length };
}

export type RedCheckAction = 'rerun' | 'fix';

export interface RedCheckView {
  /** The named failing jobs, gates folded. */
  checks: string[];
  cause: RedCauseKind;
  /** One plain sentence or three: what failed, why, what the fixes did. */
  sentence: string;
  primary: RedCheckAction;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function jobSentence(job: RedJob): string {
  const n = job.name;
  switch (job.rule) {
    case 'db_connection_lost': return `${n} failed: the Postgres tests lost their database connection.`;
    case 'runner_lost': return `${n} failed: the CI runner was lost.`;
    case 'registry_rate_limit': return `${n} failed: the image registry rate-limited the runner.`;
    case 'image_pull_failed':
    case 'registry_unavailable': return `${n} failed: the runner could not pull its image.`;
    case 'timeout_no_assertion': return `${n} timed out before any test failed.`;
    case 'red_on_base': return `${n} is failing on the base branch too, so it is not this PR's code.`;
    case 'unrelated_to_diff': return `${n} failed, but this PR changes nothing it tests.`;
    default: {
      const test = firstTestName(job.lines);
      if (test) return `${n} failed: ${test}.`;
      return job.step ? `${n} failed at "${job.step}".` : `${n} failed.`;
    }
  }
}

function list(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * The card's view of a red head (R-1, R-3 to R-5): which checks, why, and
 * whether Re-run or Start fix leads. A likely flake leads with Re-run until a
 * re-run of the same head fails the same way.
 */
export function redCheckView(record: RedCheckRecord, history: RedFixHistory = { pushedNothing: 0, noChange: 0 }): RedCheckView {
  const checks = record.jobs.map(j => j.name);
  const parts: string[] = [];
  if (record.jobs.length === 1) parts.push(jobSentence(record.jobs[0]));
  else if (record.jobs.length > 1) {
    // Several jobs: name them all, then the one whose cause is known.
    parts.push(`${list(checks)} failed.`);
    const lead = record.jobs.find(j => j.rule !== 'none');
    if (lead) parts.push(jobSentence(lead));
  }
  const cause = effectiveCause(record);
  const flake = cause === 'flake';
  // The not-this-PR sentences already say why; "looks like a flake" would contradict them.
  const saysWhy = record.jobs.length > 0 && record.jobs.every(j => NOT_THIS_PR_RULES.has(j.rule));
  // The verdict rides on the first sentence: it is the one line the card shows
  // unfolded, and the line is what says why Re-run or Start fix leads.
  if (parts.length > 0 && record.failedAfterRerun) {
    parts[0] = parts[0].replace(/ (failed|timed out)(:?)/, ' $1 twice, before and after a re-run$2');
    parts.splice(1, 0, 'So it is probably not a flake.');
  } else if (parts.length > 0 && flake && !saysWhy) {
    parts[0] = `${parts[0].replace(/\.$/, '')}, which looks like a flake, not the code.`;
  }
  if (history.pushedNothing > 0) parts.push(`${plural(history.pushedNothing, 'automatic fix', 'automatic fixes')} pushed nothing.`);
  if (history.noChange > 0) parts.push(`${plural(history.noChange, 'automatic fix', 'automatic fixes')} did not change the result.`);
  return {
    checks,
    cause,
    sentence: parts.join(' ') || 'A check failed.',
    primary: flake && !record.failedAfterRerun ? 'rerun' : 'fix',
  };
}
