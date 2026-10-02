/**
 * What the completed mission page's "What shipped" header shows, from the
 * stored record (knowledge-base: buildd/design/mission-shipped-report.md, "Surface" and
 * "Fallbacks"). Pure: the page loads the record, this decides the branch.
 *
 * Every degraded case falls back to what the page rendered before the header
 * existed, with only the mechanical facts we know. It never invents prose.
 */
import {
  isShippedRecordCurrent,
  parseShippedRecord,
  type ShippedChangeType,
  type ShippedHeroShot,
  type ShippedRecord,
} from '@/lib/mission-shipped';

export const SHIPPED_HEADER_ID = 'what-shipped';
export const NO_SCREENSHOTS_LINE = 'No screenshots were captured for this change.';

export const CHANGE_TYPE_LABEL: Record<NonNullable<ShippedChangeType>, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  both: 'Frontend and backend',
};

export interface ShippedHeaderView {
  /** The author's plain-language answer; null in the mechanical-only variant. */
  lede: string | null;
  changeTypeLabel: string | null;
  heroShots: ShippedHeroShot[];
  /** Set only for a frontend change with no screenshots. */
  noScreenshotsLine: string | null;
  offPlan: string[];
  completedByHand: boolean;
}

/**
 * The header for a completed mission, or null when the page should render as it
 * always did (no record, a record from before a reopen, or nothing to say).
 */
export function buildShippedHeaderView(
  rawRecord: unknown,
  missionCompletedAt: Date | string | null | undefined,
): ShippedHeaderView | null {
  const record: ShippedRecord | null = parseShippedRecord(rawRecord);
  if (!record || !isShippedRecordCurrent(record, missionCompletedAt)) return null;

  const lede = record.lede?.trim() ? record.lede.trim() : null;
  const heroShots = Array.isArray(record.heroShots) ? record.heroShots : [];
  const offPlan = lede && Array.isArray(record.offPlan) ? record.offPlan.slice(0, 2) : [];
  const changeType = record.changeType ?? null;
  const frontend = changeType === 'frontend' || changeType === 'both';
  const completedByHand = record.origin === 'manual';

  const view: ShippedHeaderView = {
    lede,
    changeTypeLabel: changeType ? CHANGE_TYPE_LABEL[changeType] : null,
    heroShots,
    noScreenshotsLine: frontend && heroShots.length === 0 ? NO_SCREENSHOTS_LINE : null,
    offPlan,
    completedByHand,
  };

  const hasFacts = view.changeTypeLabel != null || heroShots.length > 0 || completedByHand;
  return lede || hasFacts ? view : null;
}
