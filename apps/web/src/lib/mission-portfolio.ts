/**
 * The Missions portfolio: sort, filter and count rules over the shared
 * delivery projection (lib/delivery-projection.ts). Pure; the page loads the
 * rows and MissionGrid renders them. Nothing here derives delivery state —
 * every chip, fraction and "next" comes from `MissionDelivery`.
 *
 * Design: docs/prototypes/cross-surface-delivery (`#missions`).
 */
import type { StateKey } from '@/components/ui/states';
import { deliveryCounts, type DeliveryCounts, type DeliveryKind, type MissionDelivery } from './delivery-projection';
import { sectionOf, type MissionSectionKey } from './mission-sections';

/** One portfolio row: the projection plus the list's own sort and filter facts. */
export interface PortfolioRow {
  delivery: MissionDelivery;
  /** `missions.status`. */
  status: string;
  workspaceId: string | null;
  workspaceName: string | null;
  /** `missions.priority`; higher first. */
  priority: number;
  /** Live workers on the mission right now. */
  liveAgents: number;
  /** Epoch ms of the mission's most recent task movement; null if none. */
  lastAdvancedAt: number | null;
  /** Epoch ms the mission completed; null while open. */
  completedAt: number | null;
  /** Recurring missions: minutes to the next scheduled run. */
  nextScanMins: number | null;
  /** One display state per task, in strip order (lib/mission-strip-order.ts); absent draws an empty strip. */
  strip?: StateKey[];
}

/** Completed missions inside this window show in the history disclosure; older ones sit behind "show older". */
export const COMPLETED_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function splitPortfolio(rows: readonly PortfolioRow[], now: number) {
  const open: PortfolioRow[] = [];
  const done: PortfolioRow[] = [];
  // The projection's own `open` flag, the one the header counter reads: an
  // archived mission is history, not an open row the counter skips.
  for (const r of rows) (r.delivery.open ? open : done).push(r);
  done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.delivery.id.localeCompare(b.delivery.id));
  const recent = (r: PortfolioRow) => r.completedAt != null && now - r.completedAt < COMPLETED_HISTORY_WINDOW_MS;
  return { open, recentDone: done.filter(recent), olderDone: done.filter(r => !recent(r)) };
}

// ── Sort ────────────────────────────────────────────────────────────────────

export type PortfolioSort = 'attention' | 'recent' | 'closest' | 'priority';

/** `label` is what the select shows, kept short so it fits beside Search at phone width; `title` is the full meaning. */
export const PORTFOLIO_SORTS: ReadonlyArray<{ key: PortfolioSort; label: string; title: string }> = [
  { key: 'attention', label: 'Attention', title: 'Needs attention' },
  { key: 'recent', label: 'Recent', title: 'Recently advanced' },
  { key: 'closest', label: 'Closest', title: 'Closest to landing' },
  { key: 'priority', label: 'Priority', title: 'Priority' },
];

/** Most attention-worthy first. Same order the projection uses to pick a mission's chip. */
const ATTENTION: readonly DeliveryKind[] = ['needs', 'notlanded', 'unavailable', 'repair', 'audit', 'landing', 'build', 'waiting', 'held', 'planning', 'landed'];
/** Nearest a delivery milestone first; anything not moving sorts after. */
const STAGE: Partial<Record<DeliveryKind, number>> = { landing: 0, audit: 1, repair: 2, build: 3 };

const attention = (r: PortfolioRow) => ATTENTION.indexOf(r.delivery.kind);
const share = (r: PortfolioRow) => (r.delivery.total > 0 ? r.delivery.landed / r.delivery.total : 0);
const stage = (r: PortfolioRow) => STAGE[r.delivery.kind] ?? 9;
const byId = (a: PortfolioRow, b: PortfolioRow) => a.delivery.id.localeCompare(b.delivery.id);

const COMPARE: Record<PortfolioSort, (a: PortfolioRow, b: PortfolioRow) => number> = {
  attention: (a, b) => attention(a) - attention(b) || byId(a, b),
  recent: (a, b) => (b.lastAdvancedAt ?? -Infinity) - (a.lastAdvancedAt ?? -Infinity) || byId(a, b),
  closest: (a, b) => share(b) - share(a) || stage(a) - stage(b) || byId(a, b),
  priority: (a, b) => b.priority - a.priority || attention(a) - attention(b) || byId(a, b),
};

/** A sorted copy; the tiebreak is always the id, so the order is stable across renders. */
export function sortPortfolio(rows: readonly PortfolioRow[], sort: PortfolioSort): PortfolioRow[] {
  return [...rows].sort(COMPARE[sort]);
}

// ── Filter ──────────────────────────────────────────────────────────────────

/** The list's filters are its sections, so a chip shows exactly one section. */
export type PortfolioStatusFilter = 'all' | MissionSectionKey;

export const PORTFOLIO_STATUS_FILTERS: ReadonlyArray<{ key: PortfolioStatusFilter; label: string; title: string }> = [
  { key: 'all', label: 'All', title: 'Every open mission' },
  { key: 'needs', label: 'Needs you', title: 'Waiting on a decision, or finished without landing' },
  { key: 'motion', label: 'In motion', title: 'Buildd is building, auditing, repairing or landing it' },
  { key: 'waiting', label: 'Waiting', title: 'Waiting on capacity or earlier work, held, or not planned yet' },
  { key: 'landed', label: 'On dev', title: 'Every task landed on dev; a goal criterion has not passed yet' },
];

const MATCH: Record<PortfolioStatusFilter, (r: PortfolioRow) => boolean> = {
  all: () => true,
  needs: r => sectionOf(r) === 'needs',
  motion: r => sectionOf(r) === 'motion',
  waiting: r => sectionOf(r) === 'waiting',
  landed: r => sectionOf(r) === 'landed',
};

export interface PortfolioFilter {
  q?: string;
  workspaceId?: string | null;
  status?: PortfolioStatusFilter;
}

export function filterPortfolio(rows: readonly PortfolioRow[], f: PortfolioFilter): PortfolioRow[] {
  const q = f.q?.trim().toLowerCase() ?? '';
  const match = MATCH[f.status ?? 'all'];
  return rows.filter(r =>
    match(r)
    // Team-level missions (no workspace) belong to every workspace view, as on the server filter.
    && (!f.workspaceId || r.workspaceId === f.workspaceId || r.workspaceId == null)
    && (!q || r.delivery.title.toLowerCase().includes(q) || (r.workspaceName ?? '').toLowerCase().includes(q)));
}

export function portfolioFilterCounts(rows: readonly PortfolioRow[]): Record<PortfolioStatusFilter, number> {
  const out = { all: 0, needs: 0, motion: 0, waiting: 0, landed: 0 } as Record<PortfolioStatusFilter, number>;
  for (const r of rows) for (const { key } of PORTFOLIO_STATUS_FILTERS) if (MATCH[key](r)) out[key]++;
  return out;
}

// ── Counters ────────────────────────────────────────────────────────────────

/** The header's three numbers, from the projection's count contract. */
export function portfolioCounts(rows: readonly PortfolioRow[], slots: { live: number; max: number }): DeliveryCounts {
  return deliveryCounts({
    missions: rows.map(r => ({ status: r.status, liveAgents: r.liveAgents })),
    liveAgents: slots.live,
    capacity: slots.max,
  });
}

/** What each counter counts, shown as tooltips and in the "What these count" disclosure. */
export const COUNTER_DEFINITIONS = {
  open: 'Missions not yet completed or archived, whatever they are doing right now.',
  executing: 'Open missions with at least one agent working right now. Audits, CI and merges run without an agent and do not count.',
  slots: 'Agents working now, out of the agent seats your team’s accounts allow.',
} as const;
