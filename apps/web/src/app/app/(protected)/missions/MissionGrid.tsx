'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { MissionSegment } from '@buildd/core/mission-helpers';
import { MissionBadges, MissionProgress } from '@/components/MissionProgress';
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
  costBudgetUsd: string | null;
  spendUsd: string | null;
  segments: MissionSegment[];
  effectivePolicyLabel: string | null;
  healthState: import('@/lib/mission-helpers').Health;
  inFlightTasks: import('@/lib/mission-helpers').InFlightTask[];
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

export function MissionGrid({ missions }: { missions: MissionItem[] }) {
  const [filter, setFilter] = useState<FilterTab>('all');
  // workspaceId (or '__unassigned__') → expanded old completions
  const [expandedOldCompletions, setExpandedOldCompletions] = useState<Set<string>>(new Set());

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

  // Group filtered missions by workspace
  const workspaceBuckets: WorkspaceBucket[] = useMemo(() => {
    const map = new Map<string | null, MissionItem[]>();
    for (const m of filteredMissions) {
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
  }, [filteredMissions]);

  const multiWorkspace = workspaceBuckets.length > 1 || (workspaceBuckets.length === 1 && workspaceBuckets[0].workspaceName === null);

  function toggleOldCompletions(wsKey: string) {
    setExpandedOldCompletions(prev => {
      const next = new Set(prev);
      if (next.has(wsKey)) next.delete(wsKey); else next.add(wsKey);
      return next;
    });
  }

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

      {workspaceBuckets.map((bucket) => {
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
        const now = Date.now();
        const recentCompleted = subGroups.completed.filter(
          m => m.lastRunAt && now - new Date(m.lastRunAt).getTime() < COMPLETED_AGE_THRESHOLD_MS
        );
        const oldCompleted = subGroups.completed.filter(
          m => !m.lastRunAt || now - new Date(m.lastRunAt).getTime() >= COMPLETED_AGE_THRESHOLD_MS
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

/* ── Full Mission Card (running, scheduled, attention) ── */
function FullMissionCard({ mission, group }: { mission: MissionItem; group: MissionGroup }) {
  const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
  const isHibernating = nextRun.urgency === 'far';
  const hasFooterLinks = mission.primaryPrUrl || mission.latestTaskId;

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
          {mission.progress > 0 && (
            <span className="text-[20px] font-semibold text-accent-text shrink-0 tabular-nums">
              {mission.progress}%
            </span>
          )}
        </div>

        {mission.description && (
          <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-2.5">
            {mission.description}
          </p>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          {mission.startAt && new Date(mission.startAt).getTime() > Date.now()
            ? <span className="font-mono text-[10px] uppercase tracking-wide border border-status-info text-status-info px-1.5 py-0.5">Starts in {nextRun.text}</span>
            : <MissionBadges mission={mission} health={mission.healthState} nextRun={nextRun} />}
          {mission.workspaceId && mission.effectivePolicyLabel && (
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
        </div>
        {mission.totalTasks > 0 && <div className="my-2.5"><MissionProgress missionId={mission.id} segments={mission.segments} completedTasks={mission.completedTasks} totalTasks={mission.totalTasks} inFlightTasks={mission.inFlightTasks} /></div>}

        <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
          {mission.role && (
            <>
              <span>{mission.role.name}</span>
              <span className="mx-0.5">&middot;</span>
            </>
          )}
          {mission.totalTasks > 0 && (
            <span>{mission.completedTasks} of {mission.totalTasks} done</span>
          )}
          {mission.activeAgents > 0 && (
            <>
              <span className="mx-0.5">&middot;</span>
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
          {mission.startAt && new Date(mission.startAt).getTime() > Date.now()
            ? <span className="font-mono text-[10px] uppercase tracking-wide border border-status-info text-status-info px-1.5 py-0.5">Starts in {nextRun.text}</span>
            : <MissionBadges mission={mission} health={mission.healthState} nextRun={nextRun} />}
          {mission.workspaceId && mission.effectivePolicyLabel && (
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
        </div>
        {mission.totalTasks > 0 && <div className="mt-2"><MissionProgress missionId={mission.id} segments={mission.segments} completedTasks={mission.completedTasks} totalTasks={mission.totalTasks} inFlightTasks={mission.inFlightTasks} /></div>}
        <div className="text-[11px] text-text-muted mt-1 flex items-center gap-1.5 flex-wrap">
          {mission.totalTasks > 0 && (
            <span>{mission.completedTasks} of {mission.totalTasks} done</span>
          )}
          {mission.lastRunAt && (
            <>
              <span>&middot;</span>
              <span>{timeAgo(mission.lastRunAt)}</span>
            </>
          )}
          {mission.latestFinding && !mission.lastRunAt && (
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
