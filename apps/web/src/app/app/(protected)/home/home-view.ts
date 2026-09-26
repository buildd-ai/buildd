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

export type InFlightKind =
  | 'docfix-pr-open' | 'fixing-ci' | 'resolving' | 'docfix-running'
  | 'ci-running' | 'auto-merge' | 'docfix-rerun' | 'other';

/** What an in-flight card is waiting on — the key repeated cards fold by. */
export function inFlightKind(item: Pick<ActionQueueItem, 'chip' | 'docFixTaskStatus' | 'docFixPrLifecycleStatus'>): InFlightKind {
  switch (item.chip) {
    case 'FIXING_SPEC':
      if (item.docFixTaskStatus !== 'completed') return 'docfix-running';
      // Same test as the card: only a known-merged PR is "awaiting the re-run".
      if (item.docFixPrLifecycleStatus === 'merged' || item.docFixPrLifecycleStatus == null) return 'docfix-rerun';
      return 'docfix-pr-open';
    case 'FIXING_CI': return 'fixing-ci';
    case 'RESOLVING': return 'resolving';
    case 'CI_RUNNING': return 'ci-running';
    case 'AUTO_MERGE': return 'auto-merge';
    default: return 'other';
  }
}

/**
 * Order: something a human can still move (an open doc-fix PR to merge)
 * first, then agents actively working, then bounded waits nobody can speed
 * up (a merged doc fix waiting on the next checker run).
 */
const IN_FLIGHT_RANK: Record<InFlightKind, number> = {
  'docfix-pr-open': 0, 'fixing-ci': 1, resolving: 1, 'docfix-running': 2,
  'ci-running': 3, 'auto-merge': 3, other: 3, 'docfix-rerun': 4,
};

export const IN_FLIGHT_GROUP_COPY: Record<InFlightKind, { chip: string; detail: string }> = {
  'docfix-pr-open': { chip: 'Doc fix PRs open', detail: 'Merge them to continue' },
  'fixing-ci': { chip: 'Fixing CI', detail: 'Agents are fixing red checks' },
  resolving: { chip: 'Resolving conflicts', detail: 'Agents are rebasing these PRs' },
  'docfix-running': { chip: 'Doc fixes', detail: 'Agents are rewriting these specs' },
  'ci-running': { chip: 'CI running', detail: 'Waiting on checks' },
  'auto-merge': { chip: 'Auto-merging', detail: 'Merges when checks pass' },
  'docfix-rerun': { chip: 'Doc fixes shipped', detail: 'Waiting on the conformance re-run' },
  other: { chip: 'In flight', detail: '' },
};

export type InFlightEntry<T> =
  | { kind: 'single'; item: T }
  | { kind: 'group'; key: InFlightKind; items: T[] };

/**
 * Fold the In-flight column's repeated kinds into one card each. Six doc
 * fixes that all shipped and all wait on the same re-run are one fact, not
 * six. A kind seen once stays a plain card; nothing is dropped.
 */
export function groupInFlight<T extends Pick<ActionQueueItem, 'chip' | 'docFixTaskStatus' | 'docFixPrLifecycleStatus'>>(
  items: readonly T[],
  opts: { minGroup?: number } = {},
): InFlightEntry<T>[] {
  const minGroup = opts.minGroup ?? 2;
  const byKind = new Map<InFlightKind, T[]>();
  for (const it of items) {
    const k = inFlightKind(it);
    byKind.set(k, [...(byKind.get(k) ?? []), it]);
  }
  const entries: Array<{ rank: number; first: number; entry: InFlightEntry<T> }> = [];
  for (const [key, group] of byKind) {
    const rank = IN_FLIGHT_RANK[key];
    if (key !== 'other' && group.length >= minGroup) {
      entries.push({ rank, first: items.indexOf(group[0]), entry: { kind: 'group', key, items: group } });
    } else {
      for (const it of group) entries.push({ rank, first: items.indexOf(it), entry: { kind: 'single', item: it } });
    }
  }
  return entries.sort((a, b) => a.rank - b.rank || a.first - b.first).map(e => e.entry);
}

export type HomeAudience = 'operator' | 'member';

/**
 * Who Home is laid out for. Owners and admins run the fleet, so the fleet
 * panel sits near the top; members get what needs them and their missions
 * first, and the fleet as one expandable line. A personal team resolves to
 * `owner` (getUserTeamRole), which covers a solo user and their own runners.
 */
export function homeAudience(role: 'owner' | 'admin' | 'member' | null | undefined): HomeAudience {
  return role === 'owner' || role === 'admin' ? 'operator' : 'member';
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
  return parts.length > 0 ? parts.join(' · ') : 'Nothing waiting on you';
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
