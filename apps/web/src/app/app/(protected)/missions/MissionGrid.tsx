'use client';

import { useState, useMemo, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { MissionSegment, MissionSkylineData } from '@buildd/core/mission-helpers';
import { MissionBadges, MissionProgress } from '@/components/MissionProgress';
import { MissionSkylineChart } from '@/components/MissionSkylineChart';
import { SegmentStrip } from '@/components/SegmentStrip';
import { initiativeStatusChip } from '@/lib/initiative-presentation';
import {
  type MissionHealth,
  type MissionGroup,
  type FilterTab,
  SECTION_DISPLAY,
  GROUP_ACCENT_CLASS,
  GROUP_ORDER,
  FILTER_TO_GROUPS,
  healthToGroup,
  formatNextRun,
  timeAgo,
} from '@/lib/mission-helpers';

const DEFERRAL_LABELS: Record<string, string> = {
  concurrent_cap: 'Deferred: seats full',
  active_hours: 'Deferred: quiet hours',
  trigger_unchanged: 'Deferred: no change',
  orchestration_manual: 'Disarmed',
  budget_exhausted: 'Budget exhausted',
};

export interface InitiativeGroupData {
  id: string;
  title: string;
  rollupStatus: 'empty' | 'active' | 'blocked' | 'paused' | 'completed';
  progress: number;
  segments: MissionSegment[];
}

/**
 * Pure grouping function — maps missions to their initiative bucket.
 * Missions with no initiativeId or an unknown initiativeId go to `ungrouped`.
 * Safety invariant: every mission appears in exactly one bucket.
 */
export function groupMissionsByInitiative<T extends { id: string; initiativeId: string | null }>(
  missions: T[],
  initiativeIds: string[],
): { byInitiative: Map<string, T[]>; ungrouped: T[] } {
  const known = new Set(initiativeIds);
  const byInitiative = new Map<string, T[]>();
  for (const id of initiativeIds) byInitiative.set(id, []);
  const ungrouped: T[] = [];
  for (const m of missions) {
    if (m.initiativeId && known.has(m.initiativeId)) {
      byInitiative.get(m.initiativeId)!.push(m);
    } else {
      ungrouped.push(m);
    }
  }
  return { byInitiative, ungrouped };
}

// Completed missions older than this are collapsed by default
const COMPLETED_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface MissionItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  health: MissionHealth;
  totalTasks: number;
  completedTasks: number;
  progress: number;
  activeAgents: number;
  nextScanMins: number | null;
  nextRunAt: string | null;
  startAt: string | null;
  lastRunAt: string | null;
  /** ISO string of most recent task/worker activity; null if mission has no tasks. */
  lastActivityAt: string | null;
  /** ISO string of when this mission was created. */
  createdAt: string | null;
  lastDeferralReason: string | null;
  lastDeferredAt: string | null;
  teamName: string | null;
  role: { name: string; color: string } | null;
  latestFinding: { title: string; time: string } | null;
  workspaceId: string | null;
  workspaceName: string | null;
  primaryPrUrl: string | null;
  primaryPrNumber: number | null;
  latestTaskId: string | null;
  orchestrationMode: string | null;
  isHeld: boolean;
  costBudgetUsd: string | null;
  spendUsd: string | null;
  segments: MissionSegment[];
  effectivePolicyLabel: string | null;
  healthState: import('@/lib/mission-helpers').Health;
  inFlightTasks: import('@/lib/mission-helpers').InFlightTask[];
  blockedPRCount: number;
  initiativeId: string | null;
  initiativeName: string | null;
  priority: number;
  goalCriteriaCount: number;
  goalCriteriaOverall: 'pass' | 'fail' | 'UNVERIFIED' | null;
  skyline: MissionSkylineData | null;
  normalizationSlots: number;
}

interface WorkspaceBucket {
  workspaceName: string | null;
  workspaceId: string | null;
  missions: MissionItem[];
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'completed', label: 'Completed' },
];

export function MissionGrid({
  missions,
  initiativeGroups = [],
}: {
  missions: MissionItem[];
  initiativeGroups?: InitiativeGroupData[];
}) {
  const [filter, setFilter] = useState<FilterTab>('all');
  // workspaceId (or '__unassigned__') → expanded old completions
  const [expandedOldCompletions, setExpandedOldCompletions] = useState<Set<string>>(new Set());

  // Initiative groups with ≥6 missions default to collapsed
  const [collapsedInitiatives, setCollapsedInitiatives] = useState<Set<string>>(() => {
    const collapsed = new Set<string>();
    for (const g of initiativeGroups) {
      const count = missions.filter((m) => m.initiativeId === g.id).length;
      if (count >= 6) collapsed.add(g.id);
    }
    return collapsed;
  });

  const grouped = useMemo(() => {
    const groups: Record<MissionGroup, MissionItem[]> = {
      running: [], attention: [], review: [], scheduled: [], paused: [], completed: [],
    };
    for (const m of missions) {
      groups[healthToGroup(m.health, m.progress)].push(m);
    }
    groups.scheduled.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));
    return groups;
  }, [missions]);

  const counts: Record<FilterTab, number> = useMemo(() => ({
    all: missions.length,
    active: grouped.running.length + grouped.attention.length + grouped.review.length,
    scheduled: grouped.scheduled.length,
    completed: grouped.completed.length,
  }), [missions.length, grouped]);

  const allowedGroups = FILTER_TO_GROUPS[filter];

  // Filter missions based on current tab
  const filteredMissions = useMemo(() => {
    if (!allowedGroups) return missions;
    return missions.filter(m => allowedGroups.includes(healthToGroup(m.health, m.progress)));
  }, [missions, allowedGroups]);

  // Split filtered missions into initiative groups + ungrouped
  const { byInitiative, ungrouped: ungroupedMissions } = useMemo(
    () => groupMissionsByInitiative(filteredMissions, initiativeGroups.map((g) => g.id)),
    [filteredMissions, initiativeGroups],
  );

  // Group filtered missions by workspace — only ungrouped missions when initiatives exist
  const workspaceBuckets: WorkspaceBucket[] = useMemo(() => {
    const missionsForBuckets = initiativeGroups.length > 0 ? ungroupedMissions : filteredMissions;
    const map = new Map<string | null, MissionItem[]>();
    for (const m of missionsForBuckets) {
      const key = m.workspaceName ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    const buckets: WorkspaceBucket[] = [];
    // Named workspaces first (sorted by name)
    const named = [...map.entries()].filter(([k]) => k !== null) as [string, MissionItem[]][];
    named.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, ms] of named) {
      buckets.push({ workspaceName: name, workspaceId: ms[0].workspaceId, missions: ms });
    }
    // Unassigned at the bottom
    if (map.has(null)) {
      buckets.push({ workspaceName: null, workspaceId: null, missions: map.get(null)! });
    }
    return buckets;
  }, [filteredMissions, ungroupedMissions, initiativeGroups]);

  const multiWorkspace = workspaceBuckets.length > 1 || (workspaceBuckets.length === 1 && workspaceBuckets[0].workspaceName === null);

  function toggleInitiative(id: string) {
    setCollapsedInitiatives((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleOldCompletions(wsKey: string) {
    setExpandedOldCompletions(prev => {
      const next = new Set(prev);
      if (next.has(wsKey)) next.delete(wsKey); else next.add(wsKey);
      return next;
    });
  }

  const hasInitiativeGroups = initiativeGroups.length > 0;

  if (filteredMissions.length === 0) {
    return (
      <div className="space-y-4">
        <FilterTabBar filter={filter} counts={counts} onSelect={setFilter} />
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary">No missions in this view.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FilterTabBar filter={filter} counts={counts} onSelect={setFilter} />

      {/* Initiative group sections */}
      {initiativeGroups.map((group) => {
        const groupMissions = byInitiative.get(group.id) ?? [];
        if (groupMissions.length === 0) return null;
        const isCollapsed = collapsedInitiatives.has(group.id);
        return (
          <InitiativeGroupSection
            key={group.id}
            group={group}
            missions={groupMissions}
            isCollapsed={isCollapsed}
            onToggle={() => toggleInitiative(group.id)}
          />
        );
      })}

      {/* "Other" header — only when initiative groups exist and there are ungrouped missions */}
      {hasInitiativeGroups && ungroupedMissions.length > 0 && (
        <div className="flex items-center gap-2 pt-2">
          <span className="font-mono text-[14px] font-semibold text-text-muted">Other</span>
          <span className="text-[10px] text-text-muted font-mono">{ungroupedMissions.length}</span>
        </div>
      )}

      {/* Ungrouped missions — workspace buckets (or all missions when no initiative groups) */}
      {(!hasInitiativeGroups || ungroupedMissions.length > 0) && workspaceBuckets.map((bucket) => {
        const wsKey = bucket.workspaceName ?? '__unassigned__';
        const isExpanded = expandedOldCompletions.has(wsKey);

        // Sub-group this workspace's missions by health group
        const subGroups: Record<MissionGroup, MissionItem[]> = {
          running: [], attention: [], review: [], scheduled: [], paused: [], completed: [],
        };
        for (const m of bucket.missions) {
          subGroups[healthToGroup(m.health, m.progress)].push(m);
        }
        subGroups.scheduled.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));

        // Split completed into recent vs old for progressive disclosure
        // Use lastActivityAt as the recency signal (actual task activity), falling back to lastRunAt
        const now = Date.now();
        const completedAgeMs = (m: MissionItem) => {
          const ref = m.lastActivityAt ?? m.lastRunAt;
          return ref ? now - new Date(ref).getTime() : Infinity;
        };
        const recentCompleted = subGroups.completed.filter(
          m => completedAgeMs(m) < COMPLETED_AGE_THRESHOLD_MS
        );
        const oldCompleted = subGroups.completed.filter(
          m => completedAgeMs(m) >= COMPLETED_AGE_THRESHOLD_MS
        );

        const hasContent = GROUP_ORDER.some(g => subGroups[g].length > 0);
        if (!hasContent) return null;

        // Compact bucket: workspace has no active/scheduled/paused missions and no recent completions
        // — de-emphasise it so active workspaces aren't buried
        const isAllOldCompleted = multiWorkspace
          && subGroups.running.length === 0
          && subGroups.attention.length === 0
          && subGroups.scheduled.length === 0
          && subGroups.paused.length === 0
          && recentCompleted.length === 0
          && oldCompleted.length > 0;

        if (isAllOldCompleted && !isExpanded) {
          return (
            <div key={wsKey} className="flex items-center gap-2 py-1.5 opacity-40 hover:opacity-60 transition-opacity">
              <span className="text-[11px] font-mono uppercase tracking-wide text-text-muted">
                {bucket.workspaceName ?? 'Unassigned'}
              </span>
              <span className="text-[10px] text-text-muted font-mono">{bucket.missions.length} completed</span>
              <button
                onClick={() => toggleOldCompletions(wsKey)}
                className="text-[11px] text-text-muted hover:text-text-secondary font-mono ml-auto"
              >
                Show {oldCompleted.length} older ↓
              </button>
            </div>
          );
        }

        return (
          <div key={wsKey} className="space-y-3">
            {multiWorkspace && (
              isAllOldCompleted ? (
                <div className="flex items-center gap-2 pt-2">
                  <span className="section-label text-text-muted/70">
                    {bucket.workspaceName ?? 'Unassigned'}
                  </span>
                  <span className="text-[10px] text-text-muted font-mono">{bucket.missions.length}</span>
                  <button
                    onClick={() => toggleOldCompletions(wsKey)}
                    className="text-[11px] text-text-muted hover:text-text-secondary font-mono ml-auto"
                  >
                    Hide ↑
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 pt-2">
                  <span className="section-label">
                    {bucket.workspaceName ?? 'Unassigned'}
                  </span>
                  <span className="text-[10px] text-text-muted font-mono">
                    {bucket.missions.length}
                  </span>
                </div>
              )
            )}

            {GROUP_ORDER.map((groupKey) => {
              const items = subGroups[groupKey];
              if (items.length === 0) return null;

              const section = SECTION_DISPLAY[groupKey];
              const isCompact = groupKey === 'completed';

              // Paused: compact cards, all items always visible (no progressive disclosure)
              if (groupKey === 'paused') {
                return (
                  <div key={groupKey} className="space-y-2">
                    <div className="flex items-center gap-2 pt-1">
                      <span className="section-label-missions" style={{ color: section.color }}>
                        {section.label}
                      </span>
                      <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                    </div>
                    <div className="space-y-1.5">
                      {items.map(mission => (
                        <CompactMissionCard key={mission.id} mission={mission} group={groupKey} />
                      ))}
                    </div>
                  </div>
                );
              }

              if (isCompact) {
                // When the whole bucket is expanded from compact mode, show all completed
                const visibleItems = isAllOldCompleted
                  ? subGroups.completed
                  : (isExpanded ? subGroups.completed : recentCompleted);
                const hiddenCount = isAllOldCompleted ? 0 : oldCompleted.length;

                return (
                  <div key={groupKey} className="space-y-2">
                    {(!multiWorkspace || visibleItems.length > 0 || hiddenCount > 0) && (
                      <div className="flex items-center gap-2 pt-1">
                        <span className="section-label-missions" style={{ color: section.color }}>
                          {section.label}
                        </span>
                        <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {visibleItems.map(mission => (
                        <CompactMissionCard key={mission.id} mission={mission} group={groupKey} />
                      ))}
                    </div>
                    {hiddenCount > 0 && (
                      <button
                        onClick={() => toggleOldCompletions(wsKey)}
                        className="text-[11px] text-text-muted hover:text-text-secondary font-mono pl-1 mt-1"
                      >
                        {isExpanded ? `Hide older ↑` : `Show ${hiddenCount} older ↓`}
                      </button>
                    )}
                  </div>
                );
              }

              return (
                <div key={groupKey} className="space-y-2">
                  <div className="flex items-center gap-2 pt-1">
                    <span className="section-label-missions" style={{ color: section.color }}>
                      {section.label}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map(mission => (
                      <FullMissionCard key={mission.id} mission={mission} group={groupKey} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ── Initiative group section (collapsible) ── */
function InitiativeGroupSection({
  group,
  missions,
  isCollapsed,
  onToggle,
}: {
  group: InitiativeGroupData;
  missions: MissionItem[];
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const chip = initiativeStatusChip(group.rollupStatus);

  // Sub-group by health inside the initiative
  const subGroups: Record<MissionGroup, MissionItem[]> = {
    running: [], attention: [], review: [], scheduled: [], paused: [], completed: [],
  };
  for (const m of missions) {
    subGroups[healthToGroup(m.health, m.progress)].push(m);
  }
  subGroups.scheduled.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));

  return (
    <div className="space-y-1.5">
      {/* Header row: chevron | name (link) | status chip | progress % */}
      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={onToggle}
          className="shrink-0 text-text-muted hover:text-text-secondary transition-colors"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${group.title}` : `Collapse ${group.title}`}
        >
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <Link
          href={`/app/initiatives/${group.id}`}
          className="font-mono text-[14px] font-semibold text-text-primary truncate flex-1 hover:text-accent-text transition-colors"
        >
          {group.title}
        </Link>
        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 border ${chip.className}`}>
          {chip.label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-accent-text shrink-0">{group.progress}%</span>
      </div>

      {/* Rollup segment strip — always visible, gives summary when collapsed */}
      {group.segments.length > 0 && (
        <div className="pl-6">
          <SegmentStrip
            segments={group.segments}
            continuous
            label={`${group.title}: ${group.progress}% complete`}
          />
        </div>
      )}

      {/* Mission cards — hidden when collapsed */}
      {!isCollapsed && (
        <div className="space-y-3 pt-1">
          {GROUP_ORDER.map((groupKey) => {
            const items = subGroups[groupKey];
            if (items.length === 0) return null;
            const section = SECTION_DISPLAY[groupKey];
            const isCompact = groupKey === 'completed' || groupKey === 'paused';
            return (
              <div key={groupKey} className="space-y-2">
                <div className="flex items-center gap-2 pt-1">
                  <span className="section-label-missions" style={{ color: section.color }}>
                    {section.label}
                  </span>
                  <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.map((mission) =>
                    isCompact
                      ? <CompactMissionCard key={mission.id} mission={mission} group={groupKey} />
                      : <FullMissionCard key={mission.id} mission={mission} group={groupKey} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterTabBar({
  filter, counts, onSelect,
}: {
  filter: FilterTab;
  counts: Record<FilterTab, number>;
  onSelect: (f: FilterTab) => void;
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
      {FILTER_TABS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className={`filter-pill ${filter === key ? 'filter-pill-active' : ''}`}
        >
          {label}{counts[key] > 0 && <span className="ml-1 opacity-60">{counts[key]}</span>}
        </button>
      ))}
    </div>
  );
}

/* ── Verification pill — compact indicator for goal criteria state ── */
function VerificationPill({ criteriaCount, overall }: { criteriaCount: number; overall: 'pass' | 'fail' | 'UNVERIFIED' | null }) {
  if (criteriaCount === 0) return null;
  if (overall === 'pass') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-status-success/40 text-status-success font-mono text-[10px] rounded-sm" title="All goal criteria verified">
        ✓ Verified
      </span>
    );
  }
  if (overall === 'fail') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-status-error/40 text-status-error font-mono text-[10px] rounded-sm" title="Goal criteria not met">
        ✗ Not met
      </span>
    );
  }
  // null or UNVERIFIED
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-status-warning/40 text-status-warning font-mono text-[10px] rounded-sm" title="Goal criteria set but not yet verified">
      ? Needs verification
    </span>
  );
}

/* ── Arm button — releases a held mission ── */
function ArmButton({ missionId }: { missionId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function handleArm() {
    try {
      await fetch(`/api/missions/${missionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arm: true }),
      });
      startTransition(() => router.refresh());
    } catch {
      // non-fatal
    }
  }

  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleArm(); }}
      disabled={isPending}
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-medium bg-primary text-white border border-primary hover:bg-primary-hover transition-colors disabled:opacity-50"
      title="Arm this mission — release all tasks for workers to claim"
    >
      {isPending ? 'Arming…' : 'Arm →'}
    </button>
  );
}

const RECENCY_BADGE_MS = 7 * 24 * 60 * 60 * 1000;

function isRecentlyCreated(createdAt: string | null): boolean {
  if (!createdAt) return false;
  return Date.now() - new Date(createdAt).getTime() < RECENCY_BADGE_MS;
}

/* ── Full Mission Card (running, scheduled, attention) ── */
function FullMissionCard({ mission, group }: { mission: MissionItem; group: MissionGroup }) {
  const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
  const isHibernating = nextRun.urgency === 'far';
  const hasFooterLinks = mission.primaryPrUrl || mission.latestTaskId;
  const showNewBadge = isRecentlyCreated(mission.createdAt);

  return (
    <div
      className={`card mission-card hover:bg-[var(--card-hover)] hover:-translate-y-px transition-all duration-150 ${GROUP_ACCENT_CLASS[group]} ${isHibernating ? 'mission-card-hibernating' : ''}`}
    >
      {/* Main body — links to mission detail */}
      <div className="block p-4">
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            {mission.role && (
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: mission.role.color }}
              />
            )}
            <Link href={`/app/missions/${mission.id}`} className="text-[15px] font-medium text-text-primary leading-tight line-clamp-2 hover:text-accent-text">
              {mission.title}
            </Link>
          </div>
        </div>

        {mission.description && (
          <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-2.5">
            {mission.description}
          </p>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          {mission.isHeld
            ? (
              <>
                <span className="font-mono text-[10px] uppercase tracking-wide border border-border-strong text-text-muted px-1.5 py-0.5">Held</span>
                <ArmButton missionId={mission.id} />
              </>
            )
            : mission.startAt && new Date(mission.startAt).getTime() > Date.now()
            ? <span className="font-mono text-[10px] uppercase tracking-wide border border-status-info text-status-info px-1.5 py-0.5">Starts in {nextRun.text}</span>
            : <MissionBadges mission={mission} health={mission.healthState} nextRun={nextRun} isReviewReady={group === 'review'} />}
          {mission.workspaceId && mission.effectivePolicyLabel && group !== 'review' && (
            <Link
              href={`/app/settings/workspace/${mission.workspaceId}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-border-default text-[10px] font-mono text-text-muted hover:text-text-secondary hover:border-border-strong transition-colors"
              title={`Merge policy: ${mission.effectivePolicyLabel}`}
              onClick={e => e.stopPropagation()}
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14m-7-7l7 7 7-7" />
              </svg>
              {mission.effectivePolicyLabel}
            </Link>
          )}
          {mission.initiativeId && mission.initiativeName && (
            <Link
              href={`/app/initiatives/${mission.initiativeId}`}
              className="text-[10px] font-mono text-accent-text px-1.5 py-0.5 border border-accent-border/30 rounded-sm hover:border-accent-border/60 transition-colors"
              title={`Initiative: ${mission.initiativeName}`}
              onClick={e => e.stopPropagation()}
            >
              {mission.initiativeName.length > 24 ? `${mission.initiativeName.slice(0, 24)}…` : mission.initiativeName}
            </Link>
          )}
          {mission.priority > 0 && (
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 border ${
                mission.priority === 10
                  ? 'text-status-error border-status-error/30'
                  : 'text-status-warning border-status-warning/30'
              }`}
            >
              {mission.priority === 10 ? 'High' : 'Medium'}
            </span>
          )}
          {showNewBadge && (
            <span className="text-[9px] font-mono uppercase tracking-wide border border-status-success/50 text-status-success px-1.5 py-0.5">
              New
            </span>
          )}
          <VerificationPill criteriaCount={mission.goalCriteriaCount} overall={mission.goalCriteriaOverall} />
        </div>
        {mission.totalTasks > 0 && <div className="my-2.5"><MissionProgress missionId={mission.id} segments={mission.segments} completedTasks={mission.completedTasks} totalTasks={mission.totalTasks} inFlightTasks={mission.inFlightTasks} /></div>}

        <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
          {mission.role && (
            <span>{mission.role.name}</span>
          )}
          {mission.activeAgents > 0 && (
            <>
              {mission.role && <span className="mx-0.5">&middot;</span>}
              <span className="text-status-success">
                {mission.activeAgents} agent{mission.activeAgents !== 1 ? 's' : ''} active
              </span>
            </>
          )}
          {mission.lastDeferralReason && (
            <>
              <span className="mx-0.5">&middot;</span>
              <span
                className={mission.lastDeferralReason === 'budget_exhausted' ? 'text-status-error' : 'text-status-warning'}
                title={mission.lastDeferredAt ? `Last deferred ${timeAgo(mission.lastDeferredAt)}` : undefined}
              >
                {DEFERRAL_LABELS[mission.lastDeferralReason] ?? 'Deferred'}
              </span>
            </>
          )}
          {mission.status === 'budget_exhausted' && mission.costBudgetUsd && !mission.lastDeferralReason && (
            <>
              <span className="mx-0.5">&middot;</span>
              <span className="text-status-error">Budget exhausted</span>
            </>
          )}
          {mission.costBudgetUsd && mission.status !== 'budget_exhausted' && (
            <>
              <span className="mx-0.5">&middot;</span>
              <span className="tabular-nums">
                {mission.spendUsd ? `$${Number(mission.spendUsd).toFixed(2)} / $${Number(mission.costBudgetUsd).toFixed(2)}` : `Budget: $${Number(mission.costBudgetUsd).toFixed(2)}`}
              </span>
            </>
          )}
          {mission.latestFinding && !mission.lastDeferralReason && !mission.costBudgetUsd && (
            <>
              <span className="mx-0.5">&middot;</span>
              <span className="text-accent-text truncate max-w-[180px]">
                {mission.latestFinding.title}
              </span>
            </>
          )}
          {mission.blockedPRCount > 0 && (
            <>
              <span className="mx-0.5">&middot;</span>
              <Link
                href="/app/home"
                className="text-primary font-medium hover:underline"
              >
                blocked on {mission.blockedPRCount} PR{mission.blockedPRCount !== 1 ? 's' : ''}
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Footer row: PR link + latest run link */}
      {hasFooterLinks && (
        <div className="px-4 py-2 border-t border-border-default flex items-center gap-3 text-[11px] font-mono">
          {mission.latestTaskId && (
            <Link
              href={`/app/tasks/${mission.latestTaskId}`}
              className="text-text-muted hover:text-text-secondary transition-colors"
            >
              Latest run →
            </Link>
          )}
          {mission.primaryPrUrl && (
            <a
              href={mission.primaryPrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted hover:text-accent-text transition-colors"
            >
              PR #{mission.primaryPrNumber}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Compact Mission Card (completed/paused) ── */
function CompactMissionCard({ mission, group }: { mission: MissionItem; group: MissionGroup }) {
  const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
  const showNewBadge = isRecentlyCreated(mission.createdAt);

  return (
    <div className={`card mission-card mission-card-compact hover:bg-[var(--card-hover)] hover:-translate-y-px transition-all duration-150 ${GROUP_ACCENT_CLASS[group]}`}>
      <div className="block px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href={`/app/missions/${mission.id}`} className="text-[14px] font-medium text-text-secondary leading-tight truncate hover:text-accent-text">
              {mission.title}
            </Link>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {mission.isHeld
            ? (
              <>
                <span className="font-mono text-[10px] uppercase tracking-wide border border-border-strong text-text-muted px-1.5 py-0.5">Held</span>
                <ArmButton missionId={mission.id} />
              </>
            )
            : mission.startAt && new Date(mission.startAt).getTime() > Date.now()
            ? <span className="font-mono text-[10px] uppercase tracking-wide border border-status-info text-status-info px-1.5 py-0.5">Starts in {nextRun.text}</span>
            : <MissionBadges mission={mission} health={mission.healthState} nextRun={nextRun} isReviewReady={group === 'review'} />}
          {mission.workspaceId && mission.effectivePolicyLabel && group !== 'review' && (
            <Link
              href={`/app/settings/workspace/${mission.workspaceId}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-border-default text-[10px] font-mono text-text-muted hover:text-text-secondary hover:border-border-strong transition-colors"
              title={`Merge policy: ${mission.effectivePolicyLabel}`}
              onClick={e => e.stopPropagation()}
            >
              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14m-7-7l7 7 7-7" />
              </svg>
              {mission.effectivePolicyLabel}
            </Link>
          )}
          {mission.initiativeId && mission.initiativeName && (
            <Link
              href={`/app/initiatives/${mission.initiativeId}`}
              className="text-[10px] font-mono text-accent-text px-1.5 py-0.5 border border-accent-border/30 rounded-sm hover:border-accent-border/60 transition-colors"
              title={`Initiative: ${mission.initiativeName}`}
              onClick={e => e.stopPropagation()}
            >
              {mission.initiativeName.length > 24 ? `${mission.initiativeName.slice(0, 24)}…` : mission.initiativeName}
            </Link>
          )}
          {mission.priority > 0 && (
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 border ${
                mission.priority === 10
                  ? 'text-status-error border-status-error/30'
                  : 'text-status-warning border-status-warning/30'
              }`}
            >
              {mission.priority === 10 ? 'High' : 'Medium'}
            </span>
          )}
          {showNewBadge && (
            <span className="text-[9px] font-mono uppercase tracking-wide border border-status-success/50 text-status-success px-1.5 py-0.5">
              New
            </span>
          )}
          <VerificationPill criteriaCount={mission.goalCriteriaCount} overall={mission.goalCriteriaOverall} />
        </div>
        {group === 'completed' && mission.skyline ? (
          <div className="mt-2">
            <MissionSkylineChart skyline={mission.skyline} normalizationSlots={mission.normalizationSlots} />
          </div>
        ) : mission.totalTasks > 0 ? (
          <div className="mt-2"><MissionProgress missionId={mission.id} segments={mission.segments} completedTasks={mission.completedTasks} totalTasks={mission.totalTasks} inFlightTasks={mission.inFlightTasks} /></div>
        ) : null}
        <div className="text-[11px] text-text-muted mt-1 flex items-center gap-1.5 flex-wrap">
          <span title={mission.lastActivityAt ? `Last activity: ${mission.lastActivityAt}` : undefined}>
            {mission.lastActivityAt ? timeAgo(mission.lastActivityAt) : 'never'}
          </span>
          {mission.latestFinding && !mission.lastActivityAt && (
            <>
              <span>&middot;</span>
              <span className="text-accent-text truncate">{mission.latestFinding.title}</span>
            </>
          )}
        </div>
      </div>
      {(mission.primaryPrUrl || mission.latestTaskId) && (
        <div className="px-4 pb-2 flex items-center gap-3 text-[11px] font-mono -mt-1">
          {mission.latestTaskId && (
            <Link
              href={`/app/tasks/${mission.latestTaskId}`}
              className="text-text-muted hover:text-text-secondary transition-colors"
            >
              Latest run →
            </Link>
          )}
          {mission.primaryPrUrl && (
            <a
              href={mission.primaryPrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted hover:text-accent-text transition-colors"
            >
              PR #{mission.primaryPrNumber}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
