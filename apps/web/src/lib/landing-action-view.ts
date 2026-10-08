/**
 * What the landing action screen shows once a tap has run, and where its
 * "open the task" link goes. Pure, and free of token signing, so the client
 * confirm component can import it.
 */

/**
 * Where "open the PR's task" goes: the task the page was raised for (signed into
 * the link), else the PR's resolved open worker's task, else home. The PR number
 * alone can match several workers; the link's task is the one the alert means.
 */
export function taskPageHref(linkTaskId: string | null | undefined, workerTaskId?: string | null): string {
  const id = linkTaskId || workerTaskId;
  return id ? `/app/tasks/${encodeURIComponent(id)}` : '/app/home';
}

/** Outcomes where buildd is landing the PR by itself: nothing failed, nothing is owed. */
const PROGRESSING_OUTCOMES: ReadonlySet<string> = new Set(['waiting_ci', 'updating_branch']);

export interface TapResultView {
  heading: string;
  body: string;
  /** Landing is under way on its own; the page must not read as a failed fix. */
  progressing: boolean;
}

/** What the screen says once a tap has run, from the stored result. */
export function describeTapResult(r: { summary: string; outcome?: string }): TapResultView {
  const summary = r.summary.trim();
  if (r.outcome && PROGRESSING_OUTCOMES.has(r.outcome)) {
    return {
      heading: 'Landing is under way',
      body: `${summary} Nothing failed: buildd merges it once the current commit's checks and review pass, and pages you again only if it stops making progress.`,
      progressing: true,
    };
  }
  if (r.outcome === 'merged') return { heading: 'Merged', body: summary, progressing: false };
  if (r.outcome === 'needs_fix') return { heading: 'A fix is under way', body: summary, progressing: true };
  if (r.outcome === 'needs_human') return { heading: 'Still needs a person', body: summary, progressing: false };
  return { heading: 'Done', body: summary, progressing: false };
}
