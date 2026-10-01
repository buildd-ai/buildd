/**
 * Task evidence — a small, structured record of what a task ran into, written
 * on `tasks.result.evidence` when it ends in failure, or in success with a
 * caveat. Pure assembly: no DB, no GitHub. `task-evidence-store.ts` loads the
 * inputs and persists the output.
 *
 * The record is the key error lines, never the log. A full transcript is too
 * much to read and an empty record leaves the outcome undiagnosable, so the
 * bounds here are the point: at most EVIDENCE_MAX_KEY_LINES lines of at most
 * EVIDENCE_MAX_LINE_CHARS, every one cleaned of terminal escapes and redacted.
 */
import type {
  TaskEvidence,
  TaskEvidenceErrorClass,
  TaskMismatch,
} from '@buildd/shared';
import { createSecretRedactor } from '@buildd/core/redaction';
import {
  BASH_FAILURE_PATTERN,
  BASH_RECOVERED_PATTERN,
  parseBashTraceExcerpt,
  verifyFamilyOf,
} from '@buildd/core/bash-failure-trace';
import { cleanLogText, redactLogText } from '@/lib/ci-failure-excerpts';

export const EVIDENCE_MAX_KEY_LINES = 40;
export const EVIDENCE_MAX_LINE_CHARS = 300;
export const EVIDENCE_MAX_COMMAND_CHARS = 300;
export const EVIDENCE_MAX_CI_CHECKS = 20;
/** Bash failures whose output feeds keyLines — the newest, since the last is what ended the task. */
const RECENT_FAILURES_FOR_KEY_LINES = 4;

const genericRedact = createSecretRedactor([]);

/** Strip terminal escapes, then redact credentials, ids and production-shaped counts. */
export function sanitizeEvidenceText(raw: string): string {
  return genericRedact(redactLogText(cleanLogText(raw)));
}

const SIGNAL = new RegExp(
  [
    String.raw`\b(?:error|errors|fail|failed|failure|failures|failing|fatal|exception|panic|denied|unauthori[sz]ed|forbidden)\b`,
    String.raw`\btime[ds]?[ -]?out\b`,
    String.raw`\b(?:assertion|expected|received|ratchet|cannot|unable to)\b`,
    String.raw`\(fail\)`,
    String.raw`error TS\d+`,
    String.raw`[✗✘×]`,
    String.raw`\b\d+ (?:fail|failed|failing)\b`,
  ].join('|'),
  'i',
);

function clipLine(line: string): string {
  const t = line.trim();
  return t.length > EVIDENCE_MAX_LINE_CHARS ? `${t.slice(0, EVIDENCE_MAX_LINE_CHARS)}…` : t;
}

/**
 * The lines of a log that say what went wrong: failing test names, assertion
 * and compiler messages. Falls back to the last few lines when nothing matches,
 * so a failure with unfamiliar wording still leaves something. When there are
 * more signal lines than the cap, keeps the first and the last — a run's first
 * error is usually the cause and its summary the verdict.
 */
export function extractKeyLines(text: string, max = EVIDENCE_MAX_KEY_LINES): string[] {
  const lines = text.split('\n').map(clipLine).filter(l => l !== '');
  const dedup = (arr: string[]) => arr.filter((l, i) => i === 0 || l !== arr[i - 1]);
  const signal = dedup(lines.filter(l => SIGNAL.test(l)));
  const picked = signal.length > 0 ? signal : dedup(lines).slice(-10);
  if (picked.length <= max) return picked;
  const head = Math.floor(max * 0.4);
  return [...picked.slice(0, head), ...picked.slice(picked.length - (max - head))];
}

const CLASS_RULES: Array<[TaskEvidenceErrorClass, RegExp]> = [
  ['type_error', /error TS\d+|\bType error\b|is not assignable to|\btsc\b.*\b(?:error|failed)\b/i],
  ['lint_ratchet', /\bratchet\b|\beslint\b|\bbiome\b|\bprettier\b|\blint(?:ing)? (?:error|failed)/i],
  ['test_failure', /\(fail\)|\bAssertionError\b|expect\(|\b\d+ (?:tests? )?(?:fail|failed|failing)\b|\btests? failed\b|unit test files? failed|\bFAIL\b|[✗✘]/i],
  ['timeout', /\btime[ds]?[ -]?out\b|\bETIMEDOUT\b|\bdeadline exceeded\b/i],
  ['auth', /\b401\b|\b403\b|\bunauthori[sz]ed\b|\bBad credentials\b|invalid (?:api key|token)|authentication failed|permission denied \(publickey\)|\boauth\b.*\b(?:expired|invalid)\b/i],
  ['infra', /\bENOENT\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEAI_AGAIN\b|No space left|\bOOM\b|Killed$|\bbwrap\b|rate.?limit|\b50[234]\b|No such file or directory|command not found|^fatal: /im],
];

const INFRA_PATTERNS = new Set([
  'cd_no_such_file', 'no_such_file', 'command_not_found', 'enoent', 'oom_killed', 'git_fatal',
  'connection_refused', 'bwrap_namespace_denied', 'sandbox_mount_gap', 'rate_limit',
]);

/**
 * Classify by the wording of what the task hit. Order matters: a red tsc or a
 * ratchet is named before the test run it broke, and a test that timed out is a
 * test failure, not "timeout".
 */
export function classifyErrorClass(text: string, patternSlugs: readonly string[] = []): TaskEvidenceErrorClass {
  for (const [cls, re] of CLASS_RULES) if (re.test(text)) return cls;
  if (patternSlugs.some(p => INFRA_PATTERNS.has(p))) return 'infra';
  if (patternSlugs.includes('permission_denied')) return 'auth';
  if (patternSlugs.includes('timeout')) return 'timeout';
  return 'unknown';
}

export interface EvidenceTrace {
  pattern: string;
  excerpt: string;
  ts: Date | string | null;
}

export interface EvidenceInput {
  status: 'completed' | 'failed';
  summary: string | null;
  /** The task's own error line (worker.error / result.error). */
  error: string | null;
  diff: { files: number; added: number; removed: number };
  traces: readonly EvidenceTrace[];
  /** The CI failure digest the task was handed, for CI-fix tasks. */
  ciDigest: string | null;
  /** Checks on the PR head when the task ended; null when they could not be read. */
  ciChecks: TaskEvidence['ciChecks'] | null;
  links: TaskEvidence['links'];
}

function tsOf(t: EvidenceTrace): number {
  if (!t.ts) return 0;
  const n = t.ts instanceof Date ? t.ts.getTime() : new Date(t.ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}

interface BashFailure { command: string; exitCode: number | null; output: string; ts: number }

function bashFailures(traces: readonly EvidenceTrace[]): BashFailure[] {
  return traces
    .filter(t => t.pattern === BASH_FAILURE_PATTERN)
    .map(t => {
      const parsed = parseBashTraceExcerpt(t.excerpt);
      return parsed ? { ...parsed, ts: tsOf(t) } : null;
    })
    .filter((f): f is BashFailure => f !== null)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * The last test / typecheck / lint command that failed and was not followed by
 * a passing run of the same kind. Read from the failure traces and the runner's
 * `bash_verify_recovered` markers.
 */
export function unrecoveredVerifyFailure(traces: readonly EvidenceTrace[]): BashFailure | null {
  const recovered = traces
    .filter(t => t.pattern === BASH_RECOVERED_PATTERN)
    .map(t => ({ family: verifyFamilyOf(parseBashTraceExcerpt(t.excerpt)?.command ?? ''), ts: tsOf(t) }));
  const open = bashFailures(traces).filter(f => {
    const family = verifyFamilyOf(f.command);
    if (!family) return false;
    return !recovered.some(r => r.family === family && r.ts >= f.ts);
  });
  return open.length > 0 ? open[open.length - 1] : null;
}

const PUSHED = /\b(?:pushed|committed|opened (?:a |the )?(?:pr|pull request)|the (?:fix|change|changes) (?:is|are) (?:in|on) (?:the )?(?:branch|pr))\b/i;
const NEGATED_PUSH = /\b(?:not|never|no|n't|unable to|failed to|could ?n[o']t|without|didn't)\b[^.\n]{0,25}\b(?:push|pushed|commit|committed|pushing|committing)\b/i;

export function detectMismatches(input: {
  status: 'completed' | 'failed';
  summary: string | null;
  diff: EvidenceInput['diff'];
  traces: readonly EvidenceTrace[];
  ciChecks: EvidenceInput['ciChecks'];
}): TaskMismatch[] {
  const out: TaskMismatch[] = [];
  const { summary, diff } = input;

  if (
    summary && PUSHED.test(summary) && !NEGATED_PUSH.test(summary) &&
    diff.files === 0 && diff.added === 0 && diff.removed === 0
  ) {
    out.push({
      kind: 'pushed_without_diff',
      detail: 'The summary says work was committed or pushed, but the recorded diff is 0 files, +0, -0.',
    });
  }

  if (input.status === 'completed') {
    const red = (input.ciChecks ?? []).filter(c => c.state === 'failed');
    if (red.length > 0) {
      const names = red.slice(0, 3).map(c => c.name).join(', ');
      out.push({
        kind: 'success_with_red_check',
        detail: `Reported success while ${red.length === 1 ? 'a check was' : `${red.length} checks were`} failing: ${names}.`,
      });
    }
    const last = unrecoveredVerifyFailure(input.traces);
    if (last) {
      out.push({
        kind: 'last_command_failed',
        detail: `Reported success, but the last ${verifyFamilyOf(last.command)} command exited ${last.exitCode ?? 'non-zero'} and never passed afterwards: ${sanitizeEvidenceText(last.command).slice(0, 120)}`,
      });
    }
  }
  return out;
}

const CI_DIGEST_MAX_CHARS = 8000;

/**
 * Build the record. Returns `evidence: null` for a success with nothing to
 * flag: a clean run leaves no evidence, only tasks that failed or completed
 * with a caveat carry one.
 */
export function buildTaskEvidence(
  input: EvidenceInput,
  now: Date = new Date(),
): { evidence: TaskEvidence | null; mismatch: TaskMismatch[] } {
  const mismatch = detectMismatches(input);
  const redChecks = (input.ciChecks ?? []).some(c => c.state === 'failed');
  if (input.status === 'completed' && mismatch.length === 0 && !redChecks) {
    return { evidence: null, mismatch };
  }

  const failures = bashFailures(input.traces);
  const recent = failures.slice(-RECENT_FAILURES_FOR_KEY_LINES);
  const otherTraces = input.traces.filter(
    t => t.pattern !== BASH_FAILURE_PATTERN && t.pattern !== BASH_RECOVERED_PATTERN,
  );

  const traceText = [
    ...recent.map(f => f.output),
    ...otherTraces.map(t => t.excerpt),
  ].join('\n');
  const traceLines = traceText.trim() ? extractKeyLines(sanitizeEvidenceText(traceText)) : [];

  const digestLines = input.ciDigest
    ? extractKeyLines(sanitizeEvidenceText(input.ciDigest.slice(0, CI_DIGEST_MAX_CHARS)))
    : [];
  const errorLines = input.error ? extractKeyLines(sanitizeEvidenceText(input.error), 10) : [];

  // What the task hit leads; the digest it was handed fills the rest, so a CI
  // fix that added nothing still carries the failure it was sent to fix.
  const traceShare = digestLines.length > 0 ? Math.min(traceLines.length, Math.ceil(EVIDENCE_MAX_KEY_LINES * 0.6)) : traceLines.length;
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (l: string) => { if (!seen.has(l) && merged.length < EVIDENCE_MAX_KEY_LINES) { seen.add(l); merged.push(l); } };
  traceLines.slice(0, traceShare).forEach(push);
  digestLines.forEach(push);
  if (merged.length === 0) errorLines.forEach(push);
  traceLines.slice(traceShare).forEach(push);

  const keyLinesSource: TaskEvidence['keyLinesSource'] =
    traceLines.length > 0 ? 'traces'
    : digestLines.length > 0 ? 'ci_digest'
    : errorLines.length > 0 ? 'error'
    : 'none';

  const classText = [...merged, ...recent.map(f => f.command)].join('\n');
  const errorClass = classifyErrorClass(classText, otherTraces.map(t => t.pattern));

  const lastFailure = failures.length > 0 ? failures[failures.length - 1] : null;
  const ciChecks = input.ciChecks?.slice(0, EVIDENCE_MAX_CI_CHECKS);

  const evidence: TaskEvidence = {
    errorClass,
    keyLines: merged,
    ...(lastFailure ? {
      lastFailingCommand: {
        command: sanitizeEvidenceText(lastFailure.command).slice(0, EVIDENCE_MAX_COMMAND_CHARS),
        exitCode: lastFailure.exitCode,
      },
    } : {}),
    ...(ciChecks && ciChecks.length > 0 ? { ciChecks } : {}),
    diff: input.diff,
    links: input.links,
    keyLinesSource,
    capturedAt: now.toISOString(),
  };
  return { evidence, mismatch };
}

/** A one-line reading of an evidence record, for surfaces that show only a hint. */
export function evidenceHint(evidence: TaskEvidence | null | undefined, lines = 3): { errorClass: TaskEvidenceErrorClass; keyLines: string[] } | null {
  if (!evidence) return null;
  return { errorClass: evidence.errorClass, keyLines: evidence.keyLines.slice(0, lines) };
}

/** What a surface shows of a task's `result`: the hint plus mismatch flags, or null when it carries neither. */
export function evidenceViewOf(result: unknown, lines = 3): {
  errorClass: string;
  keyLines: string[];
  mismatch: TaskMismatch[];
} | null {
  const r = (result ?? null) as { evidence?: TaskEvidence; mismatch?: TaskMismatch[] } | null;
  const hint = evidenceHint(r?.evidence, lines);
  const mismatch = Array.isArray(r?.mismatch) ? r.mismatch : [];
  if (!hint && mismatch.length === 0) return null;
  return { errorClass: hint?.errorClass ?? 'unknown', keyLines: hint?.keyLines ?? [], mismatch };
}

interface RawCheckRun { name?: string; status?: string; conclusion?: string | null; html_url?: string | null; details_url?: string | null }

const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** GitHub check-runs reduced to name, passed/failed/pending and a job URL. Failing checks sort first so the cap never hides the red one. */
export function summarizeCheckRuns(runs: readonly (RawCheckRun | null | undefined)[]): NonNullable<TaskEvidence['ciChecks']> {
  const rank = { failed: 0, pending: 1, passed: 2 } as const;
  const out: NonNullable<TaskEvidence['ciChecks']> = [];
  for (const r of runs) {
    if (!r || typeof r.name !== 'string') continue;
    const state: 'passed' | 'failed' | 'pending' =
      r.status !== 'completed' ? 'pending'
      : r.conclusion && RED_CONCLUSIONS.has(r.conclusion) ? 'failed'
      : 'passed';
    out.push({ name: r.name.slice(0, 120), state, url: r.html_url ?? r.details_url ?? null });
  }
  return out.sort((a, b) => rank[a.state] - rank[b.state]).slice(0, EVIDENCE_MAX_CI_CHECKS);
}
