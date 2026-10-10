/**
 * What an agent error trace means for the task, as opposed to whether it
 * happened. Every trace stays in the record whatever this says: the
 * presentation decides colour and placement, never retention.
 *
 *   needs_attention  changed or is blocking the outcome: red, counted
 *   recovered        failed, then the record shows the work got past it: muted
 *   noise            an expected exploratory non-zero (a grep that matched
 *                    nothing): never counted, inspectable in run evidence
 *   unclear          the rules cannot say; the decision model may, and when it
 *                    cannot either the trace stays here (shown, not red)
 *
 * Rules first (`classifyTracesByRule`), deterministic and cheap. Only the
 * `unclear` remainder is ever sent to the decision model
 * (lib/task-verdict-decision.ts), and only on a state change.
 */
import {
  BASH_FAILURE_PATTERN,
  BASH_RECOVERED_PATTERN,
  parseBashTraceExcerpt,
  verifyFamilyOf,
} from '@buildd/core/bash-failure-trace';

export type TracePresentation = 'needs_attention' | 'recovered' | 'noise' | 'unclear';

export interface ConsequenceTrace {
  id: string;
  workerId?: string | null;
  pattern: string;
  excerpt: string;
  source?: string | null;
  ts: Date | string | null;
}

export interface TraceConsequence {
  presentation: TracePresentation;
  /** One plain clause: why the trace reads this way. */
  reason: string;
  decidedBy: 'rule' | 'model';
  /**
   * A plain headline that stands in for the raw excerpt in the normal view,
   * when the rule knows what the event was (the excerpt stays in the evidence).
   */
  headline?: string;
}

/**
 * How a succeeded task got there. It words the "this did not stop it" reason:
 * only a merge is work that landed, a finished task without a PR (a report,
 * an artifact) did not land anything, and a PR waiting to merge has not yet.
 */
export type TraceSettledAs = 'shipped' | 'done' | 'ready_to_merge';

/**
 * One earlier attempt at the task, as far as the resume-branch rule needs it:
 * whether a fresh start lost anything depends on what that attempt produced.
 */
export interface PriorAttemptFact {
  workerId: string;
  branch: string | null;
  /** Epoch ms. */
  createdAt: number;
  /** A session actually ran (not booked `never_started`). */
  started: boolean;
  /** Commits of its own (`commitCount`; `lastCommitSha` alone is just HEAD). */
  commits: number;
  /** Its PR merged, so its work landed whatever happened to the branch. */
  merged: boolean;
}

/** How the task stands now, from the record. Only the fields the rules read. */
export interface TraceOutcomeContext {
  /** The task's work verifiably landed: PR merged, or completed with nothing red. */
  succeeded: boolean;
  /** The task ended failed. */
  failed: boolean;
  /** A gating check on the task's open PR is red right now. */
  gatingCheckRed: boolean;
  /** Which kind of success, for the reason's wording. Absent: 'done'. */
  settledAs?: TraceSettledAs | null;
  /** The task's attempts, for the resume-branch rule. Absent: that rule abstains. */
  priorAttempts?: readonly PriorAttemptFact[];
}

/** The worker columns `priorAttemptFactsOf` reads. */
export interface PriorAttemptWorker {
  id: string;
  branch?: string | null;
  createdAt: Date | string;
  startedAt?: Date | string | null;
  exitCause?: string | null;
  commitCount?: number | null;
  mergedAt?: Date | string | null;
}

export function priorAttemptFactsOf(rows: readonly PriorAttemptWorker[]): PriorAttemptFact[] {
  return rows.map(w => ({
    workerId: w.id,
    branch: w.branch ?? null,
    createdAt: new Date(w.createdAt).getTime(),
    started: !!w.startedAt && w.exitCause !== 'never_started',
    commits: w.commitCount ?? 0,
    merged: !!w.mergedAt,
  }));
}

export const RESUME_FALLBACK_PATTERN = 'resume_branch_fallback';
const RESUME_FALLBACK_EXCERPT = /^Branch "([^"]+)" was (missing|diverged) on remote/;

/**
 * A missing resume branch, judged by what the attempt that owned it produced.
 * Null: no rule applies (diverged, or no prior attempt on record to judge by).
 *
 *  - it made no commits and opened no PR: a routine fresh start, diagnostic
 *    only. The usual case is a retry of a session that never began, whose
 *    branch was assigned but never pushed;
 *  - its PR merged: the branch was cleaned up after landing, nothing lost;
 *  - it made commits that did not merge: that work is not on the remote and
 *    this attempt started without it. Real, and it stays real even when the
 *    task later succeeded, because the success did not include that work.
 */
function resumeFallbackConsequence(t: ConsequenceTrace, priors: readonly PriorAttemptFact[] | undefined): TraceConsequence | null {
  if (t.pattern !== RESUME_FALLBACK_PATTERN || !priors) return null;
  const m = RESUME_FALLBACK_EXCERPT.exec(t.excerpt);
  if (!m || m[2] !== 'missing') return null;
  const at = tsOf(t) || Number.POSITIVE_INFINITY;
  const owners = priors.filter(p => p.branch === m[1] && p.workerId !== t.workerId && p.createdAt <= at);
  if (owners.length === 0) return null;
  if (owners.some(p => p.commits > 0 && !p.merged)) {
    return {
      ...rule('needs_attention', 'This attempt started over without them; check whether that work needs redoing.'),
      headline: 'A previous attempt\'s commits were not on the remote',
    };
  }
  if (owners.some(p => p.merged)) {
    return { ...rule('noise', 'Its PR had merged, so nothing was lost.'), headline: 'Started fresh after the previous attempt\'s branch was cleaned up' };
  }
  if (owners.every(p => !p.started)) {
    return { ...rule('noise', 'It made no commits, so nothing was lost.'), headline: 'Started fresh after the previous session never began' };
  }
  return {
    ...rule('noise', 'It made no commits, so nothing was lost.'),
    headline: 'Started fresh; the previous attempt had pushed nothing',
  };
}

const SETTLED_REASON: Record<TraceSettledAs, string> = {
  shipped: 'The work merged; this did not stop it.',
  done: 'The task finished; this did not stop it.',
  ready_to_merge: 'The PR is ready to merge; this did not block it.',
};

/**
 * Commands that only read. A non-zero exit from one of these is how it says
 * "nothing matched" or "not there": grep exits 1 on no match, ls/cat/stat 1 or
 * 2 on a missing path, `test`/`[` 1 on false.
 */
const READ_ONLY = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'cat', 'head', 'tail', 'wc', 'find', 'stat', 'file',
  'test', '[', 'which', 'type', 'command', 'realpath', 'readlink', 'basename', 'dirname', 'pwd',
  'echo', 'printf', 'tree', 'du', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp', 'true', 'false',
  'cd', 'git-grep', 'awk', 'sed', 'nl', 'less', 'more', 'xargs',
]);

/** git subcommands that only read. */
const GIT_READ_ONLY = new Set(['grep', 'log', 'show', 'diff', 'status', 'ls-files', 'rev-parse', 'branch', 'cat-file', 'blame', 'describe', 'merge-base', 'ls-remote', 'remote']);

const NOISE_EXIT_CODES = new Set([1, 2]);

function firstWord(segment: string): { word: string; rest: string } {
  // Drop leading env assignments (FOO=1 grep …) and a `sudo`-free subshell paren.
  const tokens = segment.trim().replace(/^\(+/, '').split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  const word = (tokens[0] ?? '').replace(/^.*\//, '');
  return { word, rest: tokens.slice(1).join(' ') };
}

function isReadOnlySegment(segment: string): boolean {
  const { word, rest } = firstWord(segment);
  if (!word) return true;
  if (word === 'git') return GIT_READ_ONLY.has(rest.split(/\s+/).find(t => !t.startsWith('-')) ?? '');
  if (!READ_ONLY.has(word)) return false;
  // sed/awk that write in place, or a find that deletes/execs, are not reads.
  if (word === 'sed' && /(^|\s)-[a-zA-Z]*i/.test(rest)) return false;
  if (word === 'find' && /\s-(?:delete|exec|execdir|ok)\b/.test(` ${rest}`)) return false;
  if (word === 'xargs') return isReadOnlySegment(rest);
  return true;
}

/**
 * A command made only of reads: every segment of its pipes and `&&`/`||`/`;`
 * chains starts with a read-only command, and nothing is redirected into a
 * file (`> /dev/null` and `2>&1` excepted).
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.replace(/\s*…\s*$/, '');
  const writesFile = /(?:^|[^0-9&])>{1,2}\s*(?!\/dev\/null|&)\S/.test(cmd.replace(/\d?>\s*\/dev\/null/g, '').replace(/2>&1/g, ''));
  if (writesFile) return false;
  // ` ⏎ ` joins the lines of a multi-line command (bash-failure-trace.ts).
  const segments = cmd.split(/\|\||&&|\||;|⏎|\n/).map(s => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

/** A Bash failure that is noise by rule: a read-only command exiting 1 or 2. */
export function isExplorationNoise(trace: Pick<ConsequenceTrace, 'pattern' | 'excerpt'>): boolean {
  if (trace.pattern !== BASH_FAILURE_PATTERN) return false;
  const parsed = parseBashTraceExcerpt(trace.excerpt);
  if (!parsed || parsed.exitCode == null || !NOISE_EXIT_CODES.has(parsed.exitCode)) return false;
  return isReadOnlyCommand(parsed.command);
}

function tsOf(t: ConsequenceTrace): number {
  if (!t.ts) return 0;
  const n = t.ts instanceof Date ? t.ts.getTime() : new Date(t.ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}

const rule = (presentation: TracePresentation, reason: string): TraceConsequence => ({ presentation, reason, decidedBy: 'rule' });

/**
 * Classify every trace by the deterministic rules. Returns one entry per
 * trace id; an `unclear` entry is what the decision model may refine.
 *
 * Order of the rules is the order of confidence:
 *   0. a missing resume branch is judged by what the prior attempt produced
 *      (`resumeFallbackConsequence`), before the outcome, since a later
 *      success says nothing about whether earlier work was lost;
 *   1. a read-only command exiting 1/2 is noise;
 *   2. the runner's own "verify passed again" marker is a recovery;
 *   3. a test/typecheck/lint failure followed by a pass of the same kind is recovered;
 *   4. once the task's work verifiably landed, nothing in its history is current;
 *   5. on a failed task, or with a gating check red, an unrecovered
 *      verify failure is what needs attention, and so is the run's last failure.
 */
export function classifyTracesByRule(
  traces: readonly ConsequenceTrace[],
  outcome: TraceOutcomeContext,
): Map<string, TraceConsequence> {
  const out = new Map<string, TraceConsequence>();
  const recoveredMarks = traces
    .filter(t => t.pattern === BASH_RECOVERED_PATTERN)
    .map(t => ({ family: verifyFamilyOf(parseBashTraceExcerpt(t.excerpt)?.command ?? ''), ts: tsOf(t), workerId: t.workerId ?? null }));
  const failures = traces.filter(t => t.pattern === BASH_FAILURE_PATTERN && !isExplorationNoise(t));
  const lastFailure = failures.reduce<ConsequenceTrace | null>((acc, t) => (!acc || tsOf(t) >= tsOf(acc) ? t : acc), null);

  for (const t of traces) {
    const fallback = resumeFallbackConsequence(t, outcome.priorAttempts);
    if (fallback) {
      out.set(t.id, fallback);
      continue;
    }
    if (isExplorationNoise(t)) {
      out.set(t.id, rule('noise', 'A read-only command found nothing; expected while exploring.'));
      continue;
    }
    if (t.pattern === BASH_RECOVERED_PATTERN) {
      out.set(t.id, rule('recovered', 'The check passed again after an earlier failure.'));
      continue;
    }
    const parsed = t.pattern === BASH_FAILURE_PATTERN ? parseBashTraceExcerpt(t.excerpt) : null;
    const family = parsed ? verifyFamilyOf(parsed.command) : null;
    if (family && recoveredMarks.some(r => r.family === family && r.ts >= tsOf(t) && (r.workerId == null || t.workerId == null || r.workerId === t.workerId))) {
      out.set(t.id, rule('recovered', `A later ${family} run passed.`));
      continue;
    }
    if (outcome.succeeded) {
      out.set(t.id, rule('recovered', SETTLED_REASON[outcome.settledAs ?? 'done']));
      continue;
    }
    if ((outcome.failed || outcome.gatingCheckRed) && family) {
      out.set(t.id, rule('needs_attention', `A ${family} run failed and never passed afterwards.`));
      continue;
    }
    if (outcome.failed && lastFailure && t.id === lastFailure.id) {
      out.set(t.id, rule('needs_attention', 'The last command that failed before the task ended.'));
      continue;
    }
    out.set(t.id, rule('unclear', 'The record does not say whether this affected the outcome.'));
  }
  return out;
}

/** The model's answer for an unclear trace, mapped onto a presentation. */
export function consequenceFromModel(answer: 'real' | 'noise'): TraceConsequence {
  return answer === 'real'
    ? { presentation: 'needs_attention', reason: 'Judged a real failure from the record.', decidedBy: 'model' }
    : { presentation: 'noise', reason: 'Judged exploration noise from the record.', decidedBy: 'model' };
}

/**
 * Rules, then any cached model answers for traces the rules left unclear.
 * A model answer never overrides a rule.
 */
export function resolveTraceConsequences(
  traces: readonly ConsequenceTrace[],
  outcome: TraceOutcomeContext,
  modelAnswers: Readonly<Record<string, 'real' | 'noise'>> = {},
): Map<string, TraceConsequence> {
  const byRule = classifyTracesByRule(traces, outcome);
  for (const [id, c] of byRule) {
    const answer = modelAnswers[id];
    if (c.presentation === 'unclear' && answer) byRule.set(id, consequenceFromModel(answer));
  }
  return byRule;
}

/** How many traces should read as a current problem (the only red count). */
export function attentionCount(consequences: ReadonlyMap<string, TraceConsequence>): number {
  let n = 0;
  for (const c of consequences.values()) if (c.presentation === 'needs_attention') n++;
  return n;
}
