/**
 * The Missions list's three sections: Needs you, In motion, Waiting. Pure
 * rules over the shared delivery projection (lib/delivery-projection.ts).
 *
 * Each section carries its own ordering, and says so on screen:
 *   Needs you  oldest first        (longest-waiting decision first)
 *   In motion  slipping first      (repairing or audit-blocked, then the
 *                                   quietest; the projection carries no ETA, so
 *                                   "slipping" is read from repair and stall)
 *   Waiting    next to start first (capacity before dependencies, held last)
 */
import type { DeliveryKind } from './delivery-projection';
import type { PortfolioRow } from './mission-portfolio';
import type { StateKey } from '@/components/ui/states';

export type MissionSectionKey = 'needs' | 'motion' | 'waiting';

export const SECTION_META: Record<MissionSectionKey, { label: string; order: string }> = {
  needs: { label: 'Needs you', order: 'oldest first' },
  motion: { label: 'In motion', order: 'slipping first' },
  waiting: { label: 'Waiting', order: 'next to start first' },
};

export const SECTION_KEYS: readonly MissionSectionKey[] = ['needs', 'motion', 'waiting'];

const SECTION_OF: Record<DeliveryKind, MissionSectionKey> = {
  // A closed, unmerged PR is reconciled by the platform (it checks whether another
  // PR carries the work), so it is not an ask. A real escalation is `needs`.
  needs: 'needs',
  notlanded: 'motion', unavailable: 'motion', repair: 'motion', audit: 'motion', landing: 'motion', build: 'motion',
  waiting: 'waiting', held: 'waiting', planning: 'waiting',
  // A landed mission still open is about to complete: it is moving, not waiting.
  landed: 'motion',
};

export const sectionOf = (r: PortfolioRow): MissionSectionKey => SECTION_OF[r.delivery.kind];

/** A mission's delivery kind as the shared state vocabulary (glyph + word). */
export const STATE_OF_KIND: Record<DeliveryKind, StateKey | null> = {
  needs: 'needs_you', notlanded: 'recovering', unavailable: 'recovering',
  repair: 'fixing', audit: 'review', landing: 'landing', build: 'running', landed: 'landed',
  // Not started: no state pill; the row says why in words.
  waiting: null, held: null, planning: null,
};

const byId = (a: PortfolioRow, b: PortfolioRow) => a.delivery.id.localeCompare(b.delivery.id);
/** Epoch ms, a missing time last. */
const at = (r: PortfolioRow) => r.lastAdvancedAt ?? Infinity;

/** Slipping rank: repair, then an audit that cannot run, then everything else. */
const SLIP: Partial<Record<DeliveryKind, number>> = { repair: 0, unavailable: 1, notlanded: 1 };
const WAIT: Record<string, number> = { waiting: 0, planning: 1, held: 2 };

const ORDER: Record<MissionSectionKey, (a: PortfolioRow, b: PortfolioRow) => number> = {
  needs: (a, b) => at(a) - at(b) || byId(a, b),
  motion: (a, b) =>
    (SLIP[a.delivery.kind] ?? 9) - (SLIP[b.delivery.kind] ?? 9)
    || b.delivery.repairRounds - a.delivery.repairRounds
    || at(a) - at(b)
    || byId(a, b),
  waiting: (a, b) =>
    (WAIT[a.delivery.kind] ?? 9) - (WAIT[b.delivery.kind] ?? 9)
    || b.priority - a.priority
    || byId(a, b),
};

export interface MissionSection {
  key: MissionSectionKey;
  label: string;
  order: string;
  rows: PortfolioRow[];
  /** What the section's missions are heading for, e.g. `2 landing on trunk, 1 on a mission branch`. */
  destinations: string;
}

/**
 * Where the section's missions land. Missions on the mission-branch strategy
 * (`milestones.onTrunk` is a boolean) land on a mission branch first and reach
 * trunk later; the rest land straight on trunk. A group with nothing to name
 * (not planned, held) says so rather than inventing a target.
 */
export function describeDestinations(rows: readonly PortfolioRow[]): string {
  if (rows.length === 0) return '';
  const branch = rows.filter(r => r.delivery.milestones.onTrunk !== null).length;
  const trunk = rows.filter(r => r.delivery.milestones.onTrunk === null && r.delivery.total > 0).length;
  const unplanned = rows.length - branch - trunk;
  const parts = [
    trunk > 0 && `${trunk} landing on trunk`,
    branch > 0 && `${branch} on a mission branch`,
    unplanned > 0 && `${unplanned} not planned yet`,
  ].filter(Boolean);
  return parts.join(', ');
}

/** Open rows split into the three sections, each ordered by its own rule. Empty sections are dropped. */
export function buildMissionSections(open: readonly PortfolioRow[]): MissionSection[] {
  return SECTION_KEYS.flatMap(key => {
    const rows = open.filter(r => sectionOf(r) === key).sort(ORDER[key]);
    return rows.length === 0 ? [] : [{ key, ...SECTION_META[key], rows, destinations: describeDestinations(rows) }];
  });
}
