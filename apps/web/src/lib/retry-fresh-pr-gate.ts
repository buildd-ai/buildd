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
 * fresh PR is refused unless the subject's head is PROVABLY unusable — GitHub
 * reports the two heads as diverged. When one head is an ancestor of the
 * other (ahead / identical / behind) the subject PR can carry the work: push
 * to its branch instead. Every fresh PR that is let through carries a durable
 * reason in the gate ledger.
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

export type FreshRetryPrDecision =
  | { action: 'allow'; reason: 'not_a_retry' | 'subject_not_open' | 'same_branch' }
  | { action: 'allow_fresh'; reason: 'diverged' | 'unverified'; subjectPrNumber: number; compareStatus: CompareStatus | null }
  | { action: 'refuse'; subjectPrNumber: number; subjectHeadRef: string; subjectUrl: string | null; compareStatus: CompareStatus };

/** Pure: given what GitHub said, may this retry open a fresh PR? */
export function decideFreshRetryPr(opts: {
  subjectPrNumber: number | null;
  subject: SubjectPrView | null;
  head: string;
  compareStatus: CompareStatus | null;
}): FreshRetryPrDecision {
  const { subjectPrNumber, subject, head, compareStatus } = opts;
  if (subjectPrNumber == null) return { action: 'allow', reason: 'not_a_retry' };
  if (!subject) return { action: 'allow_fresh', reason: 'unverified', subjectPrNumber, compareStatus: null };
  if (subject.state !== 'open' || subject.merged) return { action: 'allow', reason: 'subject_not_open' };
  if (subject.headRef === head) return { action: 'allow', reason: 'same_branch' };
  if (!subject.headRef || !compareStatus) {
    return { action: 'allow_fresh', reason: 'unverified', subjectPrNumber, compareStatus };
  }
  if (compareStatus === 'diverged') {
    return { action: 'allow_fresh', reason: 'diverged', subjectPrNumber, compareStatus };
  }
  return {
    action: 'refuse',
    subjectPrNumber,
    subjectHeadRef: subject.headRef,
    subjectUrl: subject.url,
    compareStatus,
  };
}

const COMPARE_STATUSES = new Set<CompareStatus>(['ahead', 'identical', 'behind', 'diverged']);

/** Read the subject PR and the compare, then decide. Never throws. */
export async function checkFreshRetryPr(opts: {
  installationId: number;
  repoFullName: string;
  task: RetryTaskFields | null | undefined;
  head: string;
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

  return decideFreshRetryPr({ subjectPrNumber, subject, head: opts.head, compareStatus });
}

/** The refusal's caller-facing text: what to do instead. */
export function freshRetryPrRefusal(d: Extract<FreshRetryPrDecision, { action: 'refuse' }>, head: string): { error: string; hint: string } {
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
