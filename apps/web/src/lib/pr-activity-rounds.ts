// @ui-copy
/**
 * Each review round as buildd judged it (spec r7 §7, AC-24): the round, the head it
 * read and buildd's verdict there, plus one note that GitHub lists buildd's reviews
 * on a PR it opened as Commented. GitHub refuses the App a native approve or
 * request-changes on its own PR (#5139), so a reader comparing GitHub's review
 * states with ours would otherwise take "Commented" for "nothing asked for".
 *
 * get_pr, the task page's checks list and the PR activity comment all print this
 * line beside the review summary line (`reviewSummaryLine`), so the three read the
 * same rounds the same way. Pure and client-safe.
 */
import type { RoundSnapshot, Verdict } from './workflow/types';

export interface ReviewRoundReading {
  round: number;
  /** The head the round read, short. */
  head: string;
  /** buildd's verdict (the effective one when the kernel adjusted it); null before one. */
  verdict: Verdict | null;
  words: string;
}

export interface ReviewRoundsReading {
  rounds: ReviewRoundReading[];
  /** "Round 1 at abc1234: changes requested · Round 2 at def5678: changes requested". */
  line: string;
  /** Present once buildd has posted a verdict on GitHub. */
  githubNote: string | null;
}

export const GITHUB_COMMENTED_NOTE =
  'buildd recorded these verdicts. On a PR buildd opened, GitHub lists each of these reviews as Commented.';

const VERDICT_WORDS: Record<Verdict, string> = {
  approve: 'approved',
  request_changes: 'changes requested',
  escalate: 'handed to a person',
};

function wordsOf(r: RoundSnapshot, verdict: Verdict | null): string {
  if (r.status === 'decided' && verdict) return VERDICT_WORDS[verdict];
  if (r.status === 'reviewing') return 'in review';
  if (r.status === 'queued') return 'queued';
  return 'review did not finish';
}

/** Null before the first round. A round superseded before it ran is not a round. */
export function reviewRoundsOf(rounds: readonly RoundSnapshot[] | null | undefined): ReviewRoundsReading | null {
  const live = [...(rounds ?? [])].filter((r) => r.status !== 'superseded').sort((a, b) => a.round - b.round);
  if (live.length === 0) return null;
  const read = live.map((r): ReviewRoundReading => {
    const verdict = r.status === 'decided' ? (r.effectiveVerdict ?? r.verdict) : null;
    return { round: r.round, head: r.headSha.slice(0, 7), verdict, words: wordsOf(r, verdict) };
  });
  const posted = read.some((r) => r.verdict === 'approve' || r.verdict === 'request_changes');
  return {
    rounds: read,
    line: read.map((r) => `Round ${r.round} at ${r.head}: ${r.words}`).join(' · '),
    githubNote: posted ? GITHUB_COMMENTED_NOTE : null,
  };
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/**
 * GitHub's formal review states on the PR, in GitHub's own words, printed beside
 * buildd's verdict and never in place of it (AC-24): a COMMENTED review is not a
 * request for changes, and buildd's verdict is not a GitHub review state.
 */
export function githubReviewStatesLine(r: { approved?: number; changesRequested?: number; commented?: number } | null | undefined): string | null {
  if (!r) return null;
  const parts = ([[r.approved ?? 0, 'Approved'], [r.changesRequested ?? 0, 'Changes requested'], [r.commented ?? 0, 'Commented']] as const)
    .filter(([n]) => n > 0)
    .map(([n, state], i) => (i === 0 ? `${countWord(n)} ${n === 1 ? 'review' : 'reviews'} ${state}` : `${countWord(n)} ${state}`));
  return parts.length > 0 ? `On GitHub: ${parts.join(', ')}` : null;
}
