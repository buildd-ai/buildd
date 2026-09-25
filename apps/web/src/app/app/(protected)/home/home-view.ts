/**
 * Pure view logic for /app/home, kept out of the 2,000-line page so each rule
 * the page renders (counts, grouping, empty states) has a test.
 */
import { after } from 'next/server';
import { isActionableChip, type ActionQueueItem } from '@/lib/action-queue';
import type { Stage } from '@/lib/stage';

/**
 * Split the Waiting-on-You queue into what needs the human and what an agent
 * is already handling (RESOLVING / FIXING_CI / CI_RUNNING / FIXING_SPEC).
 * Queue order is kept within each half.
 */
export function splitWaitingOnYou<T extends Pick<ActionQueueItem, 'chip'>>(queue: readonly T[]): {
  needsYou: T[];
  inFlight: T[];
} {
  const needsYou: T[] = [];
  const inFlight: T[] = [];
  for (const item of queue) (isActionableChip(item.chip) ? needsYou : inFlight).push(item);
  return { needsYou, inFlight };
}

/** "1 needs you · 4 in flight" — null when both halves are empty. */
export function waitingOnYouSummary(needsYouCount: number, inFlightCount: number): string | null {
  const parts: string[] = [];
  if (needsYouCount > 0) parts.push(`${needsYouCount} need${needsYouCount === 1 ? 's' : ''} you`);
  if (inFlightCount > 0) parts.push(`${inFlightCount} in flight`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The line under the greeting. Its "needs you" clause uses the same count and
 * wording as the Waiting-on-You header, over the same (initiative-filtered)
 * queue, so the two can never disagree.
 */
export function homeSubheading(shipClause: string | null, needsYouCount: number): string {
  const parts = [shipClause, waitingOnYouSummary(needsYouCount, 0)].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' · ') : 'Your agents are standing by';
}

export type RightNowState = 'active' | 'create-workspace' | 'get-started' | 'idle';

/**
 * Which Right Now block Home renders. "Create a workspace" is gated on the
 * workspaces Home actually queried, never on a side list (the filter dropdown
 * used to be that list, and it was empty whenever the team cookie was).
 */
export function rightNowState(input: {
  inFlightCount: number;
  workspaceCount: number;
  totalTaskCount: number;
}): RightNowState {
  if (input.inFlightCount > 0) return 'active';
  if (input.workspaceCount === 0) return 'create-workspace';
  if (input.totalTaskCount === 0) return 'get-started';
  return 'idle';
}

/**
 * Stages whose StageChip renders the PR number (the soft variant). A test
 * renders StageChip for every stage and checks this set against it.
 */
const PR_NUMBER_CHIP_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  'SUBJECT_DEAD', 'MISSION_BUDGET', 'REVIEWING', 'OPEN', 'CI', 'CI_FAILING', 'MERGE', 'VERIFY', 'DONE',
]);

export function stageChipShowsPrNumber(stage: Stage): boolean {
  return PR_NUMBER_CHIP_STAGES.has(stage);
}

/**
 * Drop a leading "PR #N:" (or "#N —") from a title when the row's chip already
 * shows #N. Only strips the matching number, and never empties the title.
 */
export function stripLeadingPrRef(title: string, prNumber: number | null | undefined): string {
  if (prNumber == null) return title;
  const m = title.match(/^\s*(?:PR\s*)?#(\d+)\s*[:\-–—]\s*([\s\S]+)$/i);
  if (!m || Number(m[1]) !== prNumber) return title;
  const rest = m[2].trim();
  return rest.length > 0 ? rest : title;
}

/**
 * Run a render-time write off the render path, best-effort. Home used to
 * await its bookkeeping writes inside the page's one big try, so a single
 * failed upsert (a read-only replica, DISABLE_WRITES, a dropped connection)
 * skipped every query after it and rendered an empty Home.
 *
 * `after()` runs the write once the response is sent. Outside a request scope
 * (after() throws there) it runs inline, still caught.
 */
export function recordBestEffort(
  label: string,
  write: () => unknown,
  opts: {
    schedule?: (fn: () => Promise<void>) => void;
    onError?: (err: unknown) => void;
  } = {},
): void {
  const onError = opts.onError ?? ((err: unknown) => console.error(`[home] ${label} write failed (non-fatal):`, err));
  const run = async () => {
    try {
      await write();
    } catch (err) {
      onError(err);
    }
  };
  try {
    (opts.schedule ?? after)(run);
  } catch {
    void run();
  }
}
