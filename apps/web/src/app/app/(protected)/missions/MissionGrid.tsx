'use client';

import { useState, useMemo, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import MissionCard from '@/components/missions/MissionCard';
import { MissionReleaseFooter, type ReleaseFooterData } from '@/components/MissionReleaseFooter';
import type { MissionCardView } from '@/lib/mission-card-view';
import {
  type MissionGroup,
  type FilterTab,
  SECTION_DISPLAY,
  GROUP_ORDER,
  FILTER_TO_GROUPS,
} from '@/lib/mission-helpers';

// Completed missions older than this are collapsed by default
const COMPLETED_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One row of the list: the card model (lib/mission-card-view.ts — the same
 * builder Home uses) plus the list's own bucketing and sort facts.
 */
export interface MissionItem {
  view: MissionCardView;
  workspaceId: string | null;
  workspaceName: string | null;
  isHeld: boolean;
  nextScanMins: number | null;
  /** ISO string of most recent task/worker activity; null if mission has no tasks. */
  lastActivityAt: string | null;
  lastRunAt: string | null;
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

const emptyGroups = (): Record<MissionGroup, MissionItem[]> => ({
  running: [], attention: [], review: [], scheduled: [], paused: [], completed: [],
});

export function MissionGrid({
  missions,
  releaseFooters = {},
}: {
  missions: MissionItem[];
  /** Workspace id → its release footer. Rendered once per workspace, never per card (D6). */
  releaseFooters?: Record<string, ReleaseFooterData>;
}) {
  const [filter, setFilter] = useState<FilterTab>('all');
  // workspaceId (or '__unassigned__') → expanded old completions
  const [expandedOldCompletions, setExpandedOldCompletions] = useState<Set<string>>(new Set());

  // Grouping is the card model's `group` (healthToGroup) — the same value the
  // page header's "N active" counts, so the tab counts and the header agree (D8).
  const grouped = useMemo(() => {
    const groups = emptyGroups();
    for (const m of missions) groups[m.view.group].push(m);
    return groups;
  }, [missions]);

  const counts: Record<FilterTab, number> = useMemo(() => ({
    all: missions.length,
    active: grouped.running.length + grouped.attention.length + grouped.review.length,
    scheduled: grouped.scheduled.length,
    completed: grouped.completed.length,
  }), [missions.length, grouped]);

  const allowedGroups = FILTER_TO_GROUPS[filter];

  const filteredMissions = useMemo(() => {
    if (!allowedGroups) return missions;
    return missions.filter(m => allowedGroups.includes(m.view.group));
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
    const named = [...map.entries()].filter(([k]) => k !== null) as [string, MissionItem[]][];
    named.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, ms] of named) {
      buckets.push({ workspaceName: name, workspaceId: ms[0].workspaceId, missions: ms });
    }
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

      {stackCompact(workspaceBuckets.map((bucket): RenderedBucket | null => {
        const wsKey = bucket.workspaceName ?? '__unassigned__';
        const isExpanded = expandedOldCompletions.has(wsKey);

        const subGroups = emptyGroups();
        for (const m of bucket.missions) subGroups[m.view.group].push(m);
        subGroups.scheduled.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));

        // Split completed into recent vs old for progressive disclosure
        const now = Date.now();
        const completedAgeMs = (m: MissionItem) => {
          const ref = m.view.completedAt ?? m.lastActivityAt ?? m.lastRunAt;
          return ref ? now - new Date(ref).getTime() : Infinity;
        };
        const recentCompleted = subGroups.completed.filter(m => completedAgeMs(m) < COMPLETED_AGE_THRESHOLD_MS);
        const oldCompleted = subGroups.completed.filter(m => completedAgeMs(m) >= COMPLETED_AGE_THRESHOLD_MS);

        const hasContent = GROUP_ORDER.some(g => subGroups[g].length > 0);
        if (!hasContent) return null;

        // Compact bucket: nothing active/scheduled/paused and no recent completions.
        const isAllOldCompleted = multiWorkspace
          && subGroups.running.length === 0
          && subGroups.attention.length === 0
          && subGroups.review.length === 0
          && subGroups.scheduled.length === 0
          && subGroups.paused.length === 0
          && recentCompleted.length === 0
          && oldCompleted.length > 0;

        if (isAllOldCompleted && !isExpanded) {
          // One line, and the whole line is the 44px target. Consecutive rows
          // stack with no gap between them (`stackCompact`).
          return {
            compact: true,
            key: wsKey,
            node: (
              <button
                key={wsKey}
                type="button"
                data-testid="mission-workspace-compact"
                aria-expanded={false}
                onClick={() => toggleOldCompletions(wsKey)}
                className="flex min-h-11 w-full items-center gap-2 text-left opacity-40 transition-opacity hover:opacity-60"
              >
                <span className="text-[11px] font-mono uppercase tracking-wide text-text-muted">
                  {bucket.workspaceName ?? 'Unassigned'}
                </span>
                <span className="text-[10px] text-text-muted font-mono">{bucket.missions.length} completed</span>
                <span className="ml-auto text-[11px] text-text-muted font-mono">Show {oldCompleted.length} older ↓</span>
              </button>
            ),
          };
        }

        const release = bucket.workspaceId ? releaseFooters[bucket.workspaceId] ?? null : null;

        return { compact: false, key: wsKey, node: (
          <div key={wsKey} className="space-y-3" data-testid="mission-workspace-bucket">
            {multiWorkspace && (
              <div className="flex items-center gap-2 pt-2">
                <span className={`section-label ${isAllOldCompleted ? 'text-text-muted/70' : ''}`}>
                  {bucket.workspaceName ?? 'Unassigned'}
                </span>
                <span className="text-[10px] text-text-muted font-mono">{bucket.missions.length}</span>
                {isAllOldCompleted && (
                  <button
                    onClick={() => toggleOldCompletions(wsKey)}
                    className="text-[11px] text-text-muted hover:text-text-secondary font-mono ml-auto"
                  >
                    Hide ↑
                  </button>
                )}
              </div>
            )}
            {/* D6: the workspace's release state, once — not on every card. */}
            {release && (
              <div data-testid="workspace-release-footer" className="border border-border-default bg-card">
                <MissionReleaseFooter data={release} />
              </div>
            )}

            {GROUP_ORDER.map((groupKey) => {
              const items = subGroups[groupKey];
              if (items.length === 0) return null;
              const section = SECTION_DISPLAY[groupKey];

              const visibleItems = groupKey !== 'completed'
                ? items
                : isAllOldCompleted ? items : (isExpanded ? items : recentCompleted);
              const hiddenCount = groupKey === 'completed' && !isAllOldCompleted ? oldCompleted.length : 0;

              return (
                <div key={groupKey} className="space-y-2" data-testid="mission-group" data-group={groupKey}>
                  {(groupKey !== 'completed' || !multiWorkspace || visibleItems.length > 0 || hiddenCount > 0) && (
                    <div className="flex items-center gap-2 pt-1">
                      <span className="section-label-missions" style={{ color: section.color }}>
                        {section.label}
                      </span>
                      <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
                    </div>
                  )}
                  <div className={groupKey === 'completed' ? 'space-y-1.5' : 'space-y-2'}>
                    {visibleItems.map(m => (
                      <MissionCard
                        key={m.view.id}
                        view={m.view}
                        actions={m.isHeld && groupKey !== 'completed' ? <ArmButton missionId={m.view.id} /> : null}
                      />
                    ))}
                  </div>
                  {hiddenCount > 0 && (
                    <button
                      onClick={() => toggleOldCompletions(wsKey)}
                      className="text-[11px] text-text-muted hover:text-text-secondary font-mono pl-1 mt-1 min-h-[44px]"
                    >
                      {isExpanded ? `Hide older ↑` : `Show ${hiddenCount} older ↓`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) };
      }))}
    </div>
  );
}

interface RenderedBucket {
  compact: boolean;
  key: string;
  node: ReactNode;
}

/**
 * Consecutive completed-only workspace rows go in one list with no spacing of
 * their own: each row is already a 44px target, and the parent's `space-y`
 * between them read as large empty gaps between one-line headers.
 */
function stackCompact(buckets: ReadonlyArray<RenderedBucket | null>): ReactNode[] {
  const out: ReactNode[] = [];
  let run: RenderedBucket[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(
      <div key={`compact:${run[0].key}`} data-testid="mission-compact-workspaces">
        {run.map(b => b.node)}
      </div>,
    );
    run = [];
  };
  for (const b of buckets) {
    if (!b) continue;
    if (b.compact) { run.push(b); continue; }
    flush();
    out.push(b.node);
  }
  flush();
  return out;
}

function FilterTabBar({
  filter, counts, onSelect,
}: {
  filter: FilterTab;
  counts: Record<FilterTab, number>;
  onSelect: (f: FilterTab) => void;
}) {
  return (
    // Below md the pills can outrun a phone's width: fade the trailing edge so
    // it reads as "scrolls", and pad the end so the last pill clears the fade
    // once scrolled fully.
    <div
      data-testid="mission-filter-bar"
      className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 pr-6 md:pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] md:[mask-image:none]"
    >
      {FILTER_TABS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className={`filter-pill shrink-0 ${filter === key ? 'filter-pill-active' : ''}`}
        >
          {label}{counts[key] > 0 && <span className="ml-1 opacity-60">{counts[key]}</span>}
        </button>
      ))}
    </div>
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
      className="inline-flex min-h-[44px] items-center gap-1 px-2 text-[10px] font-mono font-medium bg-primary text-white border border-primary hover:bg-primary-hover transition-colors disabled:opacity-50"
      title="Arm this mission — release all tasks for workers to claim"
    >
      {isPending ? 'Arming…' : 'Arm →'}
    </button>
  );
}
