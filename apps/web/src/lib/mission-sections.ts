/**
 * The Missions list's sections: Needs you, In motion, Waiting, and the
 * collapsed On dev, criteria pending group. Pure rules over the shared
 * delivery projection (lib/delivery-projection.ts).
 *
 * Each section carries its own ordering, and says so on screen:
 *   Needs you  oldest first        (longest-waiting decision first)
 *   In motion  slipping first      (repairing or audit-blocked, then the
 *                                   quietest; the projection carries no ETA, so
 *                                   "slipping" is read from repair and stall)
 *   Waiting    next to start first (capacity before dependencies, held last)
 *   On dev     oldest first        (every task landed; a goal criterion has
 *                                   not passed yet, so the mission is open)
 */
import type { DeliveryKind } from './delivery-projection';
import type { PortfolioRow } from './mission-portfolio';

export type MissionSectionKey = 'needs' | 'motion' | 'waiting' | 'landed';

export const SECTION_META: Record<MissionSectionKey, { label: string; order: string }> = {
  needs: { label: 'Needs you', order: 'oldest first' },
  motion: { label: 'In motion', order: 'slipping first' },
  waiting: { label: 'Waiting', order: 'next to start first' },
  landed: { label: 'On dev, criteria pending', order: 'oldest first' },
};

export const SECTION_KEYS: readonly MissionSectionKey[] = ['needs', 'motion', 'waiting', 'landed'];

const SECTION_OF: Record<DeliveryKind, MissionSectionKey> = {
  needs: 'needs', notlanded: 'needs',
  unavailable: 'motion', repair: 'motion', audit: 'motion', landing: 'motion', build: 'motion',
  waiting: 'waiting', held: 'waiting', planning: 'waiting',
  // Open with every task landed: on dev, waiting on a goal criterion. A
  // mission-branch mission in that state is `landing` (not on trunk yet).
  landed: 'landed',
};

export const sectionOf = (r: PortfolioRow): MissionSectionKey => SECTION_OF[r.delivery.kind];

// Lives with the projection so Home's mission rows can read it too.
export { STATE_OF_KIND } from './delivery-projection';

const byId = (a: PortfolioRow, b: PortfolioRow) => a.delivery.id.localeCompare(b.delivery.id);
/** Epoch ms, a missing time last. */
const at = (r: PortfolioRow) => r.lastAdvancedAt ?? Infinity;

/** Slipping rank: repair, then an audit that cannot run, then everything else. */
const SLIP: Partial<Record<DeliveryKind, number>> = { repair: 0, unavailable: 1 };
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
  landed: (a, b) => at(a) - at(b) || byId(a, b),
};

export interface MissionSection {
  key: MissionSectionKey;
  label: string;
  order: string;
  rows: PortfolioRow[];
}

/** Open rows split into the sections, each ordered by its own rule. Empty sections are dropped. */
export function buildMissionSections(open: readonly PortfolioRow[]): MissionSection[] {
  return SECTION_KEYS.flatMap(key => {
    const rows = open.filter(r => sectionOf(r) === key).sort(ORDER[key]);
    return rows.length === 0 ? [] : [{ key, ...SECTION_META[key], rows }];
  });
}
