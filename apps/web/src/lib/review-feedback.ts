/**
 * Mapping GitHub review payloads onto `review_feedback` rows.
 *
 * Pure on purpose. The webhook handler owns the DB write; everything that can
 * be wrong about a row — which id dedupes it, which field carries the path when
 * a comment has gone stale, what counts as feedback at all — is decided here so
 * it can be tested without stubbing the database. Mocking `db` would make every
 * one of those decisions unobservable, which is how field-mapping bugs survive
 * their own tests.
 *
 * See the `reviewFeedback` table comment for why the rows exist.
 */

export type ReviewFeedbackRow = {
  githubId: string;
  taskId: string | null;
  workerId: string | null;
  headSha: string | null;
  kind: 'review' | 'inline_comment';
  state: 'approved' | 'changes_requested' | 'commented' | null;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  body: string;
  authorLogin: string | null;
  authorType: 'user' | 'bot';
  submittedAt: Date | null;
};

/** The PR owner fields a row needs, as resolved from `workers`. */
export type PrOwner = {
  id?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
} | null | undefined;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function ts(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** GitHub marks app/bot actors with `type: 'Bot'`; everything else is a person. */
function actorType(user: unknown): 'user' | 'bot' {
  return (user as { type?: unknown } | null)?.type === 'Bot' ? 'bot' : 'user';
}

/**
 * A top-level review submission.
 *
 * Returns null when there is nothing retrievable. An approval with no body is
 * the common case and carries no engineering content — the verdict itself is
 * already recorded on the mission timeline, so storing an empty row here would
 * add a join with no payload.
 */
export function reviewRowFromEvent(review: any): ReviewFeedbackRow | null {
  const body = String(review?.body ?? '').trim();
  if (!body) return null;
  if (review?.id == null) return null;

  const state = String(review?.state ?? '').toLowerCase();
  // 'commented' is a review with prose but no verdict. It is still feedback —
  // dropping it would lose reviewer reasoning that never became a formal
  // request for changes.
  const mapped: ReviewFeedbackRow['state'] =
    state === 'approved' ? 'approved'
    : state === 'changes_requested' ? 'changes_requested'
    : state === 'commented' ? 'commented'
    : null;
  if (!mapped) return null;

  return {
    githubId: String(review.id),
    taskId: null,
    workerId: null,
    headSha: str(review.commit_id),
    kind: 'review',
    state: mapped,
    path: null,
    line: null,
    diffHunk: null,
    body,
    authorLogin: str(review.user?.login),
    authorType: actorType(review.user),
    submittedAt: ts(review.submitted_at),
  };
}

/**
 * An inline comment, anchored to a file and line.
 *
 * These are the highest-value rows in the table and were previously discarded
 * outright: they are the only feedback GitHub gives us with a `path` already
 * attached, which is what makes an objection retrievable by the file it is
 * about rather than only by the PR it came from.
 */
export function commentRowFromEvent(comment: any): ReviewFeedbackRow | null {
  const body = String(comment?.body ?? '').trim();
  if (!body) return null;
  if (comment?.id == null) return null;

  return {
    githubId: String(comment.id),
    taskId: null,
    workerId: null,
    // `commit_id` is the SHA the comment was left against, which is the code
    // actually being judged — not the PR head, which may have moved since.
    headSha: str(comment.commit_id),
    kind: 'inline_comment',
    state: 'commented',
    path: str(comment.path),
    // `line` goes null once a comment is outdated by a force-push or a later
    // commit, but `original_line` still says where it was written. Preferring
    // the live value and falling back keeps stale comments locatable instead of
    // silently unanchored.
    line: typeof comment.line === 'number' ? comment.line
      : typeof comment.original_line === 'number' ? comment.original_line
      : null,
    diffHunk: str(comment.diff_hunk),
    body,
    authorLogin: str(comment.user?.login),
    authorType: actorType(comment.user),
    submittedAt: ts(comment.created_at),
  };
}

/** Attach the resolved PR owner. Separate so the mappers stay pure. */
export function withOwner(row: ReviewFeedbackRow, owner: PrOwner): ReviewFeedbackRow {
  return { ...row, taskId: owner?.taskId ?? null, workerId: owner?.id ?? null };
}
