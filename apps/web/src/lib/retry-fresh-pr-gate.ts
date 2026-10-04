/**
 * A retry updates its subject PR; it does not open a second one.
 *
 * A retry attempt (CI fix, review fix, conflict retry) is bound to one PR by
 * its retry key. When the runner cannot check out that PR's branch — most
 * often because another worktree still holds it — it cuts a fresh branch from
 * the same tip, and `create_pr` used to open a NEW PR from it and then close
 * the subject as "superseded". The lineage forked: a second PR, a second
 * review, and a fix of that review forking again.
 *
 * `closeAncestorRetryPrs` (retry-pr-supersession.ts) still cleans up after a
 * fresh PR. This is the gate in front of it: while the subject PR is open, a
 * fresh PR is refused unless the subject's head is PROVABLY unusable. When one
 * head is an ancestor of the other (ahead / identical / behind) the subject PR
 * can carry the work: push to its branch instead. Diverged heads are not proof
 * on their own — they show only that the worker did not build on the subject's
 * head — so a fresh PR is let through only when the runner ALSO recorded why
 * it could not resume (a `resume_branch_fallback` trace naming the branch
 * missing or diverged). Otherwise the worker is told to rebase onto the
 * subject branch. Every fresh PR that is let through carries a durable reason
 * (the compare status and the runner's cause) in the gate ledger and the PR.
 *
 * Fails open (allows, records `unverified`) when GitHub cannot be read: a
 * worker whose work is pushed must not be stranded by a flaky read, and the
 * cleanup path still closes the subject.
 */
import { githubApi } from '@/lib/github';

/** The retry-bound task fields this gate reads. */
export interface RetryTaskFields {
  taskClass?: string | null;
  reviewerRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  conflictRetryPrNumber?: number | null;
}

/** The PR a retry attempt is bound to, or null for anything that is not a retry. */
export function retrySubjectPrNumber(task: RetryTaskFields | null | undefined): number | null {
  if (!task || task.taskClass !== 'attempt') return null;
  return task.reviewerRetryPrNumber ?? task.ciRetryPrNumber ?? task.conflictRetryPrNumber ?? null;
}

export interface SubjectPrView {
  number: number;
  state: string | null;
  merged: boolean;
  headRef: string | null;
  headSha: string | null;
  url: string | null;
}

/** GitHub compare status of `subject.headSha...head`. */
export type CompareStatus = 'ahead' | 'identical' | 'behind' | 'diverged';

/**
 * Why the runner did not resume the subject branch, from its own trace (see
 * `resolveSupersessionCause`). Only `missing` and `diverged` say the head could
 * not be used; `checked_out` means another worktree held it — the branch was
 * fine — and `unknown` means nothing was recorded at all.
 */
export type ResumeCause = 'missing' | 'diverged' | 'checked_out' | 'unknown';
const PROVES_UNRESUMABLE: ReadonlySet<ResumeCause> = new Set(['missing', 'diverged']);

export type FreshRetryPrDecision =
  | { action: 'allow'; reason: 'not_a_retry' | 'subject_not_open' | 'same_branch' }
  | {
      action: 'allow_fresh';
      reason: 'diverged' | 'unverified';
      subjectPrNumber: number;
      compareStatus: CompareStatus | null;
      /** The runner's recorded cause, for `diverged`. */
      resumeCause?: ResumeCause;
    }
  | {
      action: 'refuse';
      subjectPrNumber: number;
      subjectHeadRef: string;
      subjectUrl: string | null;
      compareStatus: CompareStatus;
      resumeCause?: ResumeCause;
    };

/** Pure: given what GitHub said, may this retry open a fresh PR? */
export function decideFreshRetryPr(opts: {
  subjectPrNumber: number | null;
  subject: SubjectPrView | null;
  head: string;
  compareStatus: CompareStatus | null;
  /** Read only for diverged heads; absent counts as `unknown`. */
  resumeCause?: ResumeCause | null;
}): FreshRetryPrDecision {
  const { subjectPrNumber, subject, head, compareStatus } = opts;
  if (subjectPrNumber == null) return { action: 'allow', reason: 'not_a_retry' };
  if (!subject) return { action: 'allow_fresh', reason: 'unverified', subjectPrNumber, compareStatus: null };
  if (subject.state !== 'open' || subject.merged) return { action: 'allow', reason: 'subject_not_open' };
  if (subject.headRef === head) return { action: 'allow', reason: 'same_branch' };
  if (!subject.headRef || !compareStatus) {
    return { action: 'allow_fresh', reason: 'unverified', subjectPrNumber, compareStatus };
  }
  const resumeCause = opts.resumeCause ?? 'unknown';
  if (compareStatus === 'diverged' && PROVES_UNRESUMABLE.has(resumeCause)) {
    return { action: 'allow_fresh', reason: 'diverged', subjectPrNumber, compareStatus, resumeCause };
  }
  return {
    action: 'refuse',
    subjectPrNumber,
    subjectHeadRef: subject.headRef,
    subjectUrl: subject.url,
    compareStatus,
    ...(compareStatus === 'diverged' ? { resumeCause } : {}),
  };
}

const COMPARE_STATUSES = new Set<CompareStatus>(['ahead', 'identical', 'behind', 'diverged']);

/** Read the subject PR and the compare, then decide. Never throws. */
export async function checkFreshRetryPr(opts: {
  installationId: number;
  repoFullName: string;
  task: RetryTaskFields | null | undefined;
  head: string;
  /** The runner's recorded resume cause for this worker; asked only for diverged heads. */
  resolveResumeCause?: () => Promise<ResumeCause>;
}): Promise<FreshRetryPrDecision> {
  const subjectPrNumber = retrySubjectPrNumber(opts.task);
  if (subjectPrNumber == null) return decideFreshRetryPr({ subjectPrNumber, subject: null, head: opts.head, compareStatus: null });

  let subject: SubjectPrView | null = null;
  try {
    const pr = await githubApi(opts.installationId, `/repos/${opts.repoFullName}/pulls/${subjectPrNumber}`);
    subject = {
      number: subjectPrNumber,
      state: typeof pr?.state === 'string' ? pr.state : null,
      merged: pr?.merged === true,
      headRef: typeof pr?.head?.ref === 'string' ? pr.head.ref : null,
      headSha: typeof pr?.head?.sha === 'string' ? pr.head.sha : null,
      url: typeof pr?.html_url === 'string' ? pr.html_url : null,
    };
  } catch (err) {
    console.warn(`[retry-fresh-pr] could not read subject PR #${subjectPrNumber}:`, err);
  }

  let compareStatus: CompareStatus | null = null;
  if (subject && subject.state === 'open' && !subject.merged && subject.headSha && subject.headRef !== opts.head) {
    try {
      const cmp = await githubApi(
        opts.installationId,
        `/repos/${opts.repoFullName}/compare/${encodeURIComponent(subject.headSha)}...${encodeURIComponent(opts.head)}`,
      );
      if (COMPARE_STATUSES.has(cmp?.status)) compareStatus = cmp.status;
    } catch (err) {
      console.warn(`[retry-fresh-pr] could not compare ${opts.head} with PR #${subjectPrNumber}:`, err);
    }
  }

  let resumeCause: ResumeCause = 'unknown';
  if (compareStatus === 'diverged' && opts.resolveResumeCause) {
    try {
      resumeCause = await opts.resolveResumeCause();
    } catch (err) {
      console.warn(`[retry-fresh-pr] could not read the resume trace for PR #${subjectPrNumber}:`, err);
    }
  }

  return decideFreshRetryPr({ subjectPrNumber, subject, head: opts.head, compareStatus, resumeCause });
}

/** The refusal's caller-facing text: what to do instead. */
export function freshRetryPrRefusal(d: Extract<FreshRetryPrDecision, { action: 'refuse' }>, head: string): { error: string; hint: string } {
  if (d.compareStatus === 'diverged') {
    return {
      error:
        `This retry is bound to PR #${d.subjectPrNumber}, which is still open, and '${head}' does not build on its head — ` +
        `but nothing shows that head could not be resumed (runner cause: ${d.resumeCause ?? 'unknown'}). ` +
        `A second PR would fork the lineage. Put the work on PR #${d.subjectPrNumber} instead.`,
      hint:
        `Run \`git fetch origin ${d.subjectHeadRef} && git rebase origin/${d.subjectHeadRef}\` (or cherry-pick your commits onto it), ` +
        `then \`git push origin HEAD:${d.subjectHeadRef}\` and call create_pr with head='${d.subjectHeadRef}'. ` +
        `A fresh PR is only allowed when the runner recorded that the subject branch was missing or diverged.`,
    };
  }
  const pushable = d.compareStatus === 'ahead';
  return {
    error:
      `This retry is bound to PR #${d.subjectPrNumber}, which is still open, and '${head}' ` +
      (pushable ? `only adds commits on top of its head` : `adds nothing its head does not already have`) +
      ` — a second PR would fork the lineage. Update PR #${d.subjectPrNumber} instead.`,
    hint: pushable
      ? `Run \`git push origin HEAD:${d.subjectHeadRef}\` (a fast-forward of PR #${d.subjectPrNumber}'s branch), then call create_pr with head='${d.subjectHeadRef}' to record it. A fresh PR is only allowed when the two heads have diverged.`
      : `Nothing to open: PR #${d.subjectPrNumber} already carries this work. Call create_pr with head='${d.subjectHeadRef}' to record it.`,
  };
}

/**
 * The attempt line a retry stamps on its PR body. It states what actually
 * happened — the PR was updated, or a new one was opened and why — instead of
 * the old unconditional "resume failed; new branch", which every fresh retry
 * PR carried whether or not a resume had been tried.
 */
export function retryAttemptFooter(opts: {
  attempt: number;
  maxIterations: number;
  decision: FreshRetryPrDecision | 'updated';
}): string {
  const prefix = `_Attempt ${opts.attempt}/${opts.maxIterations} — `;
  const d = opts.decision;
  if (d === 'updated') return `${prefix}updated this PR._`;
  if (d.action === 'allow_fresh' && d.reason === 'diverged') {
    return `${prefix}new PR: PR #${d.subjectPrNumber}'s branch was ${d.resumeCause ?? 'unusable'} on the runner and the heads diverged._`;
  }
  if (d.action === 'allow_fresh') return `${prefix}new PR: PR #${d.subjectPrNumber}'s head could not be verified._`;
  if (d.action === 'allow' && d.reason === 'subject_not_open') return `${prefix}new PR: the PR it was fixing is no longer open._`;
  return `${prefix}new PR._`;
}

/** Matches any attempt line `retryAttemptFooter` writes, and the older wording. */
export const ATTEMPT_FOOTER_PATTERN = /_Attempt \d+\/\d+ — [^\n]*?\._/;
