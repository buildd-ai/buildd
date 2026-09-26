/**
 * "How it landed": the chain from first attempt to merge for a task's PR,
 * including CI failures that were handed to a fresh worker on the same branch
 * (CI-retry attempt tasks). Built from stored rows only — worker counters, the
 * retry task's `ciRetryHeadSha` + `context.failureContext`, and the PR
 * lifecycle — so it renders without GitHub. Check-run detail per commit is an
 * optional enrichment layered on by the caller.
 */
import { formatOffset, basename } from './task-activity';

export interface AttemptInput {
  runner: string | null;
  roleName: string | null;
  commits: number;
  add: number;
  rem: number;
  files: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Last commit this attempt pushed, if recorded. */
  headSha: string | null;
}

export interface RetryInput {
  createdAt: number;
  /** The head commit whose CI failure triggered the retry. */
  headSha: string | null;
  failure: { job?: string; test?: string; excerpt?: string } | null;
}

export type LineageKind = 'attempt' | 'ci_failed' | 'retry' | 'ci_running' | 'ci_green' | 'merged';

export interface LineageStep {
  kind: LineageKind;
  /** Attempt number for attempt steps. */
  n?: number;
  title: string;
  sub: string;
  at: string | null;
}

export interface CommitChecks {
  attempt: number;
  /** Short SHA for display. */
  sha: string;
  /** Full ref as stored, for fetching check runs. */
  ref: string;
  state: 'failed' | 'passed' | 'running' | 'unknown';
  failure: RetryInput['failure'];
}

export interface Lineage {
  steps: LineageStep[];
  totals: { add: number; rem: number; files: number; commits: number; attempts: number; claimToMerge: string | null };
  commits: CommitChecks[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const GREEN = new Set(['ci_green', 'merged', 'approved', 'mergeable']);

export function buildLineage({
  attempts,
  retries,
  pr,
}: {
  attempts: AttemptInput[];
  retries: RetryInput[];
  pr: { lifecycle: string | null; mergedAt: number | null };
}): Lineage {
  const steps: LineageStep[] = [];
  const commits: CommitChecks[] = [];
  const merged = !!pr.mergedAt || pr.lifecycle === 'merged';

  attempts.forEach((a, i) => {
    const n = i + 1;
    const who = [a.roleName, a.runner].filter(Boolean).join(' on ');
    const tail = i === 0 ? 'PR opened' : 'same branch';
    steps.push({
      kind: 'attempt',
      n,
      title: `Attempt ${n}`,
      sub: `${who ? `${who} · ` : ''}${plural(a.commits, 'commit')}, ${tail}`,
      at: a.startedAt != null && a.completedAt != null
        ? formatOffset(a.completedAt - a.startedAt)
        : i > 0 && a.completedAt == null ? 'running' : null,
    });

    const retry = retries[i];
    const isLast = i === attempts.length - 1;
    const commit = (ref: string | null, state: CommitChecks['state'], failure: CommitChecks['failure']) => {
      if (ref) commits.push({ attempt: n, sha: ref.slice(0, 7), ref, state, failure });
    };

    if (retry) {
      const failSub = [retry.failure?.job, retry.failure?.test ? basename(retry.failure.test) : null].filter(Boolean).join(' · ');
      steps.push({
        kind: 'ci_failed',
        title: 'CI failed',
        sub: failSub || 'checks failed',
        at: a.completedAt != null ? `${formatOffset(retry.createdAt - a.completedAt)} after push` : null,
      });
      const next = attempts[i + 1];
      steps.push({
        kind: 'retry',
        title: 'Retry sent',
        sub: 'Failure excerpt handed to a fresh builder',
        at: next?.startedAt != null ? `+${formatOffset(next.startedAt - retry.createdAt)}` : null,
      });
      commit(retry.headSha ?? a.headSha, 'failed', retry.failure);
      return;
    }

    if (!isLast) return;
    // A retry still at work: the PR's CI state is still the failure it is
    // fixing, so there is no CI step for this attempt yet.
    if (i > 0 && a.completedAt == null && !merged) return;
    const lc = pr.lifecycle ?? '';
    if (merged || GREEN.has(lc)) {
      steps.push({ kind: 'ci_green', title: 'CI green', sub: 'checks passed', at: null });
      commit(a.headSha, 'passed', null);
    } else if (lc === 'ci_failed') {
      steps.push({ kind: 'ci_failed', title: 'CI failed', sub: 'checks failed', at: null });
      commit(a.headSha, 'failed', null);
    } else if (lc === 'ci_running') {
      steps.push({ kind: 'ci_running', title: 'CI running', sub: 'checks in progress', at: null });
      commit(a.headSha, 'running', null);
    } else {
      commit(a.headSha, 'unknown', null);
    }
    if (merged) {
      const lastDone = a.completedAt;
      steps.push({
        kind: 'merged',
        title: 'Merged',
        sub: 'PR landed',
        at: pr.mergedAt != null && lastDone != null ? `+${formatOffset(pr.mergedAt - lastDone)}` : null,
      });
    }
  });

  const sum = (f: (a: AttemptInput) => number) => attempts.reduce((s, a) => s + (f(a) || 0), 0);
  const first = attempts[0];
  return {
    steps,
    commits,
    totals: {
      add: sum(a => a.add),
      rem: sum(a => a.rem),
      files: sum(a => a.files),
      commits: sum(a => a.commits),
      attempts: attempts.length,
      claimToMerge: pr.mergedAt != null && first ? formatOffset(pr.mergedAt - first.createdAt) : null,
    },
  };
}
