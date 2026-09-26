/**
 * Home's Missions section (docs/design/mission-feed-mobile-continuity.md, W1, S5).
 *
 * Every card is the same `MissionCard` the missions list renders, built by the
 * same `buildMissionCardView`, so a mission reads identically on both. Groups
 * come from the card model (`healthToGroup`): a mission with live agents is
 * RUNNING NOW, never NEEDS ATTENTION (AC-14), and the header's "N active"
 * counts with that same grouping (D8).
 *
 * Release state is not here: it is workspace-level and lives once, in the
 * Release Queue widget below this section (D6).
 */
import Link from 'next/link';
import MissionCard from '@/components/missions/MissionCard';
import type { MissionCardView } from '@/lib/mission-card-view';
import { countActiveMissions, MISSION_CARD_VIEW_CAP } from '@/lib/mission-card-view';
import { SECTION_DISPLAY, type MissionGroup } from '@/lib/mission-helpers';

export interface HomeMissionSummary {
  id: string;
  group: MissionGroup;
  nextScanMins: number | null;
}

/** Home shows at most this many scheduled missions, soonest first. */
export const HOME_SCHEDULED_CAP = 3;

const ACTIVE = new Set<MissionGroup>(['running', 'attention', 'review']);
/** Section order on Home. */
export const HOME_GROUP_ORDER: readonly MissionGroup[] = ['review', 'running', 'attention', 'scheduled'];

/**
 * Which missions Home renders as cards: every active one, then the soonest
 * scheduled ones. All scheduled missions are candidates (not just those within
 * 24h), so an active mission on an infrequent cron is never hidden.
 */
export function selectHomeMissions(missions: readonly HomeMissionSummary[]): {
  visibleIds: string[];
  activeCount: number;
  completedCount: number;
  /** Scheduled missions with NO card (past HOME_SCHEDULED_CAP) — shown ones are not "more". */
  scheduledCount: number;
  hiddenCount: number;
  /** Hidden missions in no named bucket (e.g. paused), so the "+N more" parts sum to N. */
  otherHiddenCount: number;
  /** Active missions past MISSION_CARD_VIEW_CAP: counted in the header, not drawn. */
  cappedActiveCount: number;
} {
  const active = missions.filter(m => ACTIVE.has(m.group));
  const scheduled = missions
    .filter(m => m.group === 'scheduled')
    .sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));
  // Capped here, not by the view loader, so hiddenCount and the "+N more"
  // line account for every mission that does not get a card.
  const visible = [...active, ...scheduled.slice(0, HOME_SCHEDULED_CAP)].slice(0, MISSION_CARD_VIEW_CAP);
  const visibleSet = new Set(visible.map(m => m.id));
  const hiddenCount = missions.length - visible.length;
  const completedCount = missions.filter(m => m.group === 'completed').length;
  const scheduledCount = scheduled.filter(m => !visibleSet.has(m.id)).length;
  const cappedActiveCount = active.filter(m => !visibleSet.has(m.id)).length;
  return {
    visibleIds: visible.map(m => m.id),
    activeCount: countActiveMissions(missions.map(m => m.group)),
    completedCount,
    scheduledCount,
    hiddenCount,
    otherHiddenCount: Math.max(0, hiddenCount - completedCount - scheduledCount - cappedActiveCount),
    cappedActiveCount,
  };
}

/** "+N more (2 active, 5 completed, 1 scheduled) →", naming only non-zero parts. */
export function homeMissionsMoreLabel(sel: ReturnType<typeof selectHomeMissions>): string {
  if (sel.hiddenCount <= 0) return 'View all missions';
  const parts = [
    sel.cappedActiveCount > 0 && `${sel.cappedActiveCount} active`,
    sel.completedCount > 0 && `${sel.completedCount} completed`,
    sel.scheduledCount > 0 && `${sel.scheduledCount} scheduled`,
    sel.otherHiddenCount > 0 && `${sel.otherHiddenCount} other`,
  ].filter(Boolean);
  return `+${sel.hiddenCount} more${parts.length > 0 ? ` (${parts.join(', ')})` : ''} →`;
}

export function HomeMissions({
  missions,
  views,
}: {
  /** Every mission Home loaded, summarised (for counts). */
  missions: readonly HomeMissionSummary[];
  /** Card views for the visible missions, in `selectHomeMissions` order. */
  views: readonly MissionCardView[];
}) {
  const selection = selectHomeMissions(missions);
  const { activeCount } = selection;

  return (
    <div className="mb-8 md:mb-0" data-testid="home-missions">
      <div className="flex items-center justify-between mb-4">
        <div className="section-label">Missions</div>
        {missions.length > 0 && (
          <Link href="/app/missions" className="inline-flex items-center min-h-11 md:min-h-0 text-xs text-text-muted hover:text-text-secondary" data-testid="home-missions-count">
            {activeCount > 0 ? `${activeCount} active` : `${missions.length} total →`}
          </Link>
        )}
      </div>
      {missions.length === 0 ? (
        <div className="border border-dashed border-border-default p-6">
          <p className="text-[14px] text-text-secondary">
            No missions yet. <Link href="/app/missions/new" className="text-accent-text hover:underline">Create one</Link>.
          </p>
        </div>
      ) : views.length === 0 ? (
        <div className="border border-dashed border-border-default p-4">
          <p className="text-[13px] text-text-secondary">
            No active missions.{' '}
            <Link href="/app/missions" className="text-text-muted hover:text-text-secondary underline underline-offset-2">
              View all {missions.length}
            </Link>
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {HOME_GROUP_ORDER.map((groupKey) => {
            const items = views.filter(v => v.group === groupKey);
            if (items.length === 0) return null;
            return (
              <div key={groupKey} className="space-y-2" data-testid="mission-group" data-group={groupKey}>
                <div className="flex items-center gap-2">
                  <span className="section-label-missions text-[11px] text-text-muted">{SECTION_DISPLAY[groupKey].label}</span>
                  <span className="text-[11px] text-text-muted font-mono">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.map(view => <MissionCard key={view.id} view={view} />)}
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-2 pt-1">
            {/* Wraps rather than truncating: the breakdown is the point of it. */}
            <Link href="/app/missions" className="inline-flex items-center min-h-11 md:min-h-0 text-xs text-text-muted hover:text-text-secondary min-w-0 [overflow-wrap:anywhere]">
              {homeMissionsMoreLabel(selection)}
            </Link>
            <Link href="/app/missions/new" className="inline-flex items-center min-h-11 md:min-h-0 text-xs text-text-muted hover:text-accent-text shrink-0 pl-2">
              + New Mission
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
