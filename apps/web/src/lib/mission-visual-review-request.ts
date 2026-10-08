/**
 * The one client path for a person asking for a mission's visual review: the
 * decision sheet's "Run visual audit" (completion blocked on a missing audit)
 * and the mission header's proactive "Visual review" both go through here, so
 * their copy, response handling and idempotency cannot drift.
 *
 * A visual review is a mission command, not a task a person writes. It always
 * calls POST /api/missions/[id]/surface-audit (`requestMissionSurfaceAudit`),
 * which owns the role, kind, evidence contract, dependencies, routes, dispatch
 * and dedup. Nothing here links to the generic task composer. Client-safe.
 */

/** What the Visual review sheet shows before anything is filed (GET on the same route). */
export interface VisualReviewPreview {
  /** An audit that is open or done already: the request would return it, not file another. */
  existing: { taskId: string; status: string } | null;
  /** Screens a new audit would be asked to capture. Empty: the auditor derives them from the mission's changes. */
  routes: string[];
  viewports: Array<'mobile' | 'desktop'>;
  /** Where the pages come from. Null while an audit exists (it already decided). */
  capture: {
    /** `mission`: the mission's integration branch; `trunk`: the workspace trunk. */
    branch: 'mission' | 'trunk';
    ref: string | null;
    /** The workspace's visual QA page source setting. */
    pageSource: 'sandbox' | 'vercel-preview' | 'auto';
  } | null;
  /** A browser-capable runner is online for the workspace. Null: unknown. */
  browserRunnerOnline: boolean | null;
  /** `executor: local`: buildd's runners will not claim the audit. */
  executorLocal: boolean;
}

export type VisualReviewRequestOutcome =
  | { kind: 'created'; taskId: string; status: string }
  | { kind: 'existing'; taskId: string; status: string }
  | { kind: 'refused'; code: string | null; message: string }
  | { kind: 'error'; message: string };

export const RUN_VISUAL_REVIEW_LABEL = 'Run visual review';

const DONE = new Set(['completed']);

export const visualReviewRequestUrl = (missionId: string) => `/api/missions/${encodeURIComponent(missionId)}/surface-audit`;

/** POST the mission's visual review. Never throws. */
export async function requestMissionVisualReview(
  missionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VisualReviewRequestOutcome> {
  try {
    const res = await fetchImpl(visualReviewRequestUrl(missionId), { method: 'POST' });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      return {
        kind: 'refused',
        code: typeof body.code === 'string' ? body.code : null,
        message: typeof body.error === 'string' && body.error
          ? body.error
          : `Could not add the visual review (HTTP ${res.status}).`,
      };
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    const status = typeof body.status === 'string' ? body.status : 'pending';
    return body.created === false ? { kind: 'existing', taskId, status } : { kind: 'created', taskId, status };
  } catch {
    return { kind: 'error', message: 'Could not reach buildd. The visual review was not added.' };
  }
}

/** GET what a request would do. Null on any failure: the sheet then offers the action bare. */
export async function loadVisualReviewPreview(
  missionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VisualReviewPreview | null> {
  try {
    const res = await fetchImpl(visualReviewRequestUrl(missionId), { method: 'GET' });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { preview?: VisualReviewPreview } | null;
    return body?.preview ?? null;
  } catch {
    return null;
  }
}

/** The status line after a request: one wording for every surface that asks. */
export function visualReviewOutcomeText(outcome: VisualReviewRequestOutcome): string {
  switch (outcome.kind) {
    case 'created':
      return 'Visual review queued. It was added to this mission, and its screens show here as they are captured.';
    case 'existing':
      return DONE.has(outcome.status)
        ? 'This mission already has a finished visual review. Open it to see the screens.'
        : 'A visual review is already on this mission. Nothing was duplicated.';
    case 'refused':
    case 'error':
      return outcome.message;
  }
}

/** Is this outcome a review on the mission (new or existing)? */
export const visualReviewOnMission = (o: VisualReviewRequestOutcome | null): o is Extract<VisualReviewRequestOutcome, { kind: 'created' | 'existing' }> =>
  !!o && (o.kind === 'created' || o.kind === 'existing');

/** The browser constraint, said plainly with its next step. Null when there is nothing to say. */
export function browserRunnerNote(preview: Pick<VisualReviewPreview, 'browserRunnerOnline' | 'executorLocal'>): string | null {
  if (preview.executorLocal) {
    return 'This mission runs on your own machine, so buildd\'s runners will not pick the review up. Run it from a session with a browser.';
  }
  if (preview.browserRunnerOnline === false) {
    return 'No runner with a browser is online for this workspace. The review waits in the queue until one connects: start a runner on a machine that can open a browser.';
  }
  return null;
}

/** Where the pages come from, in words. */
export function captureSourceText(capture: NonNullable<VisualReviewPreview['capture']>): string {
  const branch = capture.branch === 'mission'
    ? `the mission branch${capture.ref ? ` (${capture.ref})` : ''}`
    : `trunk${capture.ref ? ` (${capture.ref})` : ''}`;
  if (capture.pageSource === 'vercel-preview') return `The preview deployment of ${branch}`;
  if (capture.pageSource === 'auto') return `The preview deployment of ${branch}, else a local build`;
  return `A local build of ${branch}`;
}

export const VIEWPORT_LABEL: Record<'mobile' | 'desktop', string> = { mobile: 'Phone', desktop: 'Desktop' };
