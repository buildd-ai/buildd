'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  type MissionHealth,
  type MissionGroup,
  type FilterTab,
  HEALTH_DISPLAY,
  SECTION_DISPLAY,
  GROUP_ACCENT_CLASS,
  GROUP_ORDER,
  FILTER_TO_GROUPS,
  healthToGroup,
  formatNextRun,
} from '@/lib/mission-helpers';

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
  lastRunAt: string | null;
  teamName: string | null;
  role: { name: string; color: string } | null;
  latestFinding: { title: string; time: string } | null;
}

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'completed', label: 'Completed' },
];

export function MissionGrid({ missions }: { missions: MissionItem[] }) {
  const [filter, setFilter] = useState<FilterTab>('all');

  const grouped = useMemo(() => {
    const groups: Record<MissionGroup, MissionItem[]> = {
      running: [],
      attention: [],
      scheduled: [],
      completed: [],
    };

    for (const m of missions) {
      const group = healthToGroup(m.health, m.progress);
      groups[group].push(m);
    }

    // Sort scheduled by nextScanMins ascending (soonest first)
    groups.scheduled.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));

    return groups;
  }, [missions]);

  // Count per filter tab
  const counts: Record<FilterTab, number> = useMemo(() => ({
    all: missions.length,
    active: grouped.running.length + grouped.attention.length,
    scheduled: grouped.scheduled.length,
    completed: grouped.completed.length,
  }), [missions.length, grouped]);

  // Which groups to show based on filter
  const allowedGroups = FILTER_TO_GROUPS[filter];

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {FILTER_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`filter-pill ${filter === key ? 'filter-pill-active' : ''}`}
          >
            {label} {counts[key] > 0 && <span className="ml-1 opacity-60">{counts[key]}</span>}
          </button>
        ))}
      </div>

      {/* Grouped sections */}
      {GROUP_ORDER.map((groupKey) => {
        const items = grouped[groupKey];
        if (items.length === 0) return null;
        if (allowedGroups && !allowedGroups.includes(groupKey)) return null;

        const section = SECTION_DISPLAY[groupKey];
        const isCompact = groupKey === 'completed';

        return (
          <div key={groupKey} className="space-y-2">
            <div className="flex items-center gap-2 pt-2">
              <span
                className="section-label-missions"
                style={{ color: section.color }}
              >
                {section.label}
              </span>
              <span className="text-[10px] text-text-muted font-mono">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map((mission) =>
                isCompact ? (
                  <CompactMissionCard key={mission.id} mission={mission} group={groupKey} />
                ) : (
                  <FullMissionCard key={mission.id} mission={mission} group={groupKey} />
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Full Mission Card (running, scheduled, attention) ── */
function FullMissionCard({ mission, group }: { mission: MissionItem; group: MissionGroup }) {
  const healthDisplay = HEALTH_DISPLAY[mission.health];
  const nextRun = formatNextRun(mission.nextScanMins, mission.nextRunAt);
  const isHibernating = nextRun.urgency === 'far';

  return (
    <Link
      href={`/app/missions/${mission.id}`}
      className={`card card-interactive mission-card ${GROUP_ACCENT_CLASS[group]} block p-4 hover:bg-card-hover ${isHibernating ? 'mission-card-hibernating' : ''}`}
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {mission.role && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: mission.role.color }}
            />
          )}
          <span className="text-[17px] font-medium text-text-primary leading-tight truncate">
            {mission.title}
          </span>
          <span className={`health-pill ${healthDisplay.colorClass}`}>
            {healthDisplay.label}
          </span>
        </div>
        {mission.progress > 0 && (
          <span className="font-display text-2xl text-status-success shrink-0 tabular-nums">
            {mission.progress}%
          </span>
        )}
      </div>

      {mission.description && (
        <p className="text-[13px] text-text-secondary font-normal line-clamp-2 mb-3">
          {mission.description}
        </p>
      )}

      {/* Progress bar */}
      {mission.totalTasks > 0 && (
        <div className="h-[3px] rounded-full bg-[rgba(255,245,230,0.06)] mb-2.5 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${mission.progress}%`,
              background: 'linear-gradient(90deg, var(--status-success), #7ad4aa)',
            }}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-text-muted flex-wrap">
        {mission.role && (
          <>
            <span>{mission.role.name}</span>
            <span className="mx-0.5">&middot;</span>
          </>
        )}
        {mission.totalTasks > 0 && (
          <span>
            {mission.completedTasks} of {mission.totalTasks} done
          </span>
        )}
        {mission.activeAgents > 0 && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-status-success">
              {mission.activeAgents} agent{mission.activeAgents !== 1 ? 's' : ''} active
            </span>
          </>
        )}
        {nextRun.text && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className={nextRun.urgency === 'imminent' ? 'next-run-imminent' : isHibernating ? 'italic text-text-muted' : ''}>
              {nextRun.text}
            </span>
          </>
        )}
        {mission.latestFinding && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-accent-text truncate max-w-[180px]">
              {mission.latestFinding.title}
            </span>
          </>
        )}
        {mission.teamName && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/10 text-accent-text">
            {mission.teamName}
          </span>
        )}
      </div>
    </Link>
  );
}

/* ── Compact Mission Card (completed/paused) ── */
function CompactMissionCard({ mission, group }: { mission: MissionItem; group: MissionGroup }) {
  const healthDisplay = HEALTH_DISPLAY[mission.health];

  return (
    <Link
      href={`/app/missions/${mission.id}`}
      className={`card card-interactive mission-card mission-card-compact ${GROUP_ACCENT_CLASS[group]} block px-4 py-3 hover:bg-card-hover`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[15px] font-medium text-text-secondary leading-tight truncate">
            {mission.title}
          </span>
          <span className={`health-pill ${healthDisplay.colorClass}`}>
            {healthDisplay.label}
          </span>
        </div>
      </div>
      <div className="text-[11px] text-text-muted mt-1 flex items-center gap-1">
        {mission.totalTasks > 0 && (
          <span>
            {mission.completedTasks} of {mission.totalTasks} done
          </span>
        )}
        {mission.latestFinding && (
          <>
            <span className="mx-0.5">&middot;</span>
            <span className="text-accent-text truncate">
              {mission.latestFinding.title}
            </span>
          </>
        )}
        {mission.teamName && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/10 text-accent-text">
            {mission.teamName}
          </span>
        )}
      </div>
    </Link>
  );
}
