import { formatTokens } from '@/lib/usage-drilldown';
import { buildMissionWithInitiativeUrl } from '@/lib/initiative-breadcrumb';
import {
  EFFORT_WINDOW_DAYS,
  VERDICT_WINDOW_DAYS,
  derivePendingCounts,
  noPendingCounts,
} from '@/lib/initiative-pulse';
import type { Confidence } from '@/lib/verdict-presentation';
import type { EffortDay, PendingCounts, PulseMission } from '@/lib/initiative-pulse';

/**
 * The arithmetic behind the three blocks §5.1 adds to initiative detail — the
 * verdict evidence line, the pending-action strip and the large sparkline.
 *
 * Pure on purpose. The page itself is an async server component that cannot be
 * mounted in a unit test, so everything that could be wrong lives here and is
 * tested directly: chip selection, the copy, the link resolution, and the
 * window totals.
 *
 * NOTHING here derives a verdict or issues a query. §6.2 allows exactly one
 * loader — `lib/initiative-pulse.ts` — and this module only formats what that
 * loader already produced. `derivePendingCounts` is re-used per mission (see
 * `missionContributions`) rather than reimplemented, because the strip needs to
 * know *which* mission owns a count in order to link to it, and a second
 * counting rule here would be exactly the divergence §5.2 forbids.
 *
 * Server-side only, because it imports the loader for its counting rule. The
 * presentation vocabulary it needs (`Confidence`) comes from
 * `verdict-presentation.ts` as a type, which is erased.
 */

/**
 * §6.4 sets `84×24` as the default mount and `≥168×32` for this page: 14 slots
 * across 84px give ~5px bars, which is legible in a list row but unreadable as
 * the page's only history. Doubling both axes is the minimum §1 allows.
 */
export const DETAIL_SPARKLINE_WIDTH = 168;
export const DETAIL_SPARKLINE_HEIGHT = 32;

/** In-page target for a count owned by more than one mission. */
export const MISSIONS_ANCHOR = '#initiative-missions';

/** In-page target for "nothing checked this" — the KPI panel (§5.1). */
export const KPI_ANCHOR = '#initiative-kpis';

export type PendingKey = keyof PendingCounts;

/**
 * Strip order. Fixed, and deliberately not sorted by size: the reader learns
 * one layout, and a chip does not move because a number grew overnight.
 *
 * Unlike the list subline (§4.2), `shippedThisWeek` is NOT suppressed when the
 * other three are non-zero — §5.1 says "one chip per non-zero count", and the
 * detail page is the surface where the full picture belongs.
 */
export const PENDING_CHIP_ORDER: readonly PendingKey[] = [
  'awaitingVerification',
  'blocked',
  'held',
  'shippedThisWeek',
];

/** §4.2's copy, reused verbatim so the two surfaces name the same count alike. */
const PENDING_CHIP_NOUN: Record<PendingKey, string> = {
  awaitingVerification: 'awaiting merge',
  blocked: 'blocked',
  held: 'held',
  shippedThisWeek: 'shipped this week',
};

/** One mission's share of the four counts, used to resolve each chip's link. */
export interface MissionContribution {
  missionId: string;
  counts: PendingCounts;
}

export interface PendingChip {
  key: PendingKey;
  count: number;
  /** e.g. `2 awaiting merge`. */
  label: string;
  /** Always non-empty — the strip is links (§1), never inert text. */
  href: string;
}

/**
 * Split the aggregate counts back into per-mission shares by calling the shared
 * `derivePendingCounts` once per mission.
 *
 * The loader's counters are additive over mission rows, so running it per
 * mission and summing yields exactly the aggregate the Initiatives list shows —
 * asserted in the tests, because this is the one place the strip could invent a
 * number the list does not have.
 *
 * Deliberately a runtime import of the loader: an independent per-mission
 * counting rule here is what §5.2 exists to prevent.
 */
export function missionContributions(
  missionRows: Array<PulseMission & { id: string }>,
  initiativeId: string,
): MissionContribution[] {
  return missionRows.map((row) => ({
    missionId: row.id,
    counts: derivePendingCounts([{ ...row, initiativeId }]).get(initiativeId) ?? noPendingCounts(),
  }));
}

/**
 * §5.1's pending-action strip: one chip per non-zero count, each linking to the
 * surface that resolves it.
 *
 * Link resolution — §5.1 names the target ("the mission or task that owns the
 * PR"; "the mission") but not the case where several missions own one count.
 * A chip is a single aggregate, so:
 *   - exactly one owning mission → that mission, carrying initiative context so
 *     the reader can come back;
 *   - several → the missions list further down this same page, which is the
 *     surface that enumerates them. No invented route, and never a dead chip.
 */
export function buildPendingChips(
  contributions: MissionContribution[],
  opts: { initiativeId: string },
): PendingChip[] {
  const chips: PendingChip[] = [];

  for (const key of PENDING_CHIP_ORDER) {
    let count = 0;
    const owners: string[] = [];
    for (const c of contributions) {
      const n = c.counts[key];
      if (n > 0) {
        count += n;
        owners.push(c.missionId);
      }
    }
    // A zero count renders no chip (§5.1). Absence is the empty state.
    if (count === 0) continue;

    chips.push({
      key,
      count,
      label: `${count} ${PENDING_CHIP_NOUN[key]}`,
      href:
        owners.length === 1
          ? buildMissionWithInitiativeUrl(owners[0], opts.initiativeId)
          : MISSIONS_ANCHOR,
    });
  }

  return chips;
}

/**
 * The numbers the verdict was derived from (§5.1). Mandatory: a verdict a
 * reader cannot audit is a slogan, so this line renders even when every input
 * is zero — `0 merged · 0 attempts · 0 tokens · 7d` is itself the finding.
 *
 * The window stated is the *verdict* window (7d), not the 14-day effort window
 * the sparkline draws, because these three numbers are what the §6.5 ladder read.
 */
export function formatVerdictEvidence(i: {
  merges7d: number;
  attempts7d: number;
  tokens7d: number;
  windowDays?: number;
}): string {
  const windowDays = i.windowDays ?? VERDICT_WINDOW_DAYS;
  const attempts = i.attempts7d === 1 ? '1 attempt' : `${i.attempts7d} attempts`;
  return `${i.merges7d} merged · ${attempts} · ${formatTokens(i.tokens7d)} tokens · ${windowDays}d`;
}

/**
 * The sparkline's window total (§5.1). Labelled from the array's own length so
 * a caller passing a shorter window cannot mislabel it as 14 days.
 */
export function formatEffortTotal(days: EffortDay[]): string {
  const total = days.reduce((n, d) => n + d.tokens, 0);
  const windowDays = days.length || EFFORT_WINDOW_DAYS;
  return `${formatTokens(total)} tokens · ${windowDays}d`;
}

/**
 * Collapse each task's worker list to its newest entry.
 *
 * The page's own query used to ask for `limit: 1` worker per task, which is what
 * `computeMissionProgress` and its segment states were tuned against. Adding
 * the pending counts required the *full* worker list (an open PR is not always
 * on the newest worker), so the query widened — and this restores the old
 * one-worker view for the progress rollup so widening the query cannot silently
 * change the rendered progress bar. Callers pass rows already ordered newest-first.
 */
export function latestWorkerPerTask<T extends { workers?: unknown[] | null }>(tasks: T[]): T[] {
  return tasks.map((t) => ({
    ...t,
    workers: (t.workers ?? []).slice(0, 1),
  }));
}

/**
 * Where an `unverified` verdict sends the reader so the fix for "nothing
 * checked this" is one click from the claim (§5.1).
 *
 * There is no KPI *editor* route in the app: KPIs are edited through the
 * `InitiativeKPIPanel` on this page, which only mounts when the arc already has
 * KPIs. So an arc with KPIs gets the in-page anchor, and an arc with none gets
 * no link rather than a link to nowhere.
 */
export function verdictEvidenceAnchor(i: {
  confidence: Confidence;
  kpiCount: number;
}): string | null {
  if (i.confidence !== 'unverified') return null;
  return i.kpiCount > 0 ? KPI_ANCHOR : null;
}
