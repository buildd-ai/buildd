'use client';

import { useMemo, useState } from 'react';
import { MissionReleaseFooter, type ReleaseFooterData } from '@/components/MissionReleaseFooter';
import { ActiveMissionCard, DoneMissionRows, MiniMissionCard } from '@/components/missions/MissionListCards';
import { PhaseBarLegend } from '@/components/missions/PhaseBar';
import type { MissionCardView } from '@/lib/mission-card-view';
import type { ListCardKind, MissionListCardModel } from '@/lib/mission-list-card';
import { timeAgo } from '@/lib/mission-helpers';
import { classifyReleaseState, isReleaseVisible } from '@/lib/release-state';

// Completed missions older than this are collapsed by default
const COMPLETED_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One row of the list: the shared card model (lib/mission-card-view.ts — the
 * same builder Home uses), the list card model on top of it
 * (lib/mission-list-card.ts), and the list's own sort facts.
 */
export interface MissionItem {
  view: MissionCardView;
  list: MissionListCardModel;
  workspaceId: string | null;
  workspaceName: string | null;
  isHeld: boolean;
  nextScanMins: number | null;
  /** ISO string of most recent task/worker activity; null if mission has no tasks. */
  lastActivityAt: string | null;
  lastRunAt: string | null;
}

type Tab = 'all' | ListCardKind;

const TAB_ORDER: Array<{ key: Tab; label: string; square?: string; always?: boolean }> = [
  { key: 'all', label: 'All', always: true },
  { key: 'active', label: 'Running', square: 'bg-accent', always: true },
  { key: 'recurring', label: 'Recurring', always: true },
  { key: 'held', label: 'Held', square: 'bg-status-warning', always: true },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done', square: 'bg-status-success', always: true },
];

const MINI_KINDS: readonly ListCardKind[] = ['recurring', 'held', 'scheduled', 'paused'];

export function MissionGrid({
  missions,
  releaseFooters = {},
  slots = null,
}: {
  missions: MissionItem[];
  /** Workspace id → its release footer. Rendered once per workspace, never per card (D6). */
  releaseFooters?: Record<string, ReleaseFooterData>;
  /** Seat use across the team, for the "nothing running" line. */
  slots?: { live: number; max: number } | null;
}) {
  const [tab, setTab] = useState<Tab>('all');
  const [showOlder, setShowOlder] = useState(false);

  const byKind = useMemo(() => {
    const out: Record<ListCardKind, MissionItem[]> = { active: [], recurring: [], held: [], scheduled: [], paused: [], done: [] };
    for (const m of missions) out[m.list.kind].push(m);
    out.recurring.sort((a, b) => (a.nextScanMins ?? Infinity) - (b.nextScanMins ?? Infinity));
    return out;
  }, [missions]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: missions.length, active: 0, recurring: 0, held: 0, scheduled: 0, paused: 0, done: 0 };
    for (const k of Object.keys(byKind) as ListCardKind[]) c[k] = byKind[k].length;
    return c;
  }, [missions.length, byKind]);

  const show = (k: ListCardKind) => tab === 'all' || tab === k;
  const multiWorkspace = new Set(missions.map(m => m.workspaceId ?? '')).size > 1;
  const ws = (m: MissionItem) => (multiWorkspace ? m.workspaceName : null);

  const now = Date.now();
  const doneAge = (m: MissionItem) => {
    const ref = m.view.completedAt ?? m.lastActivityAt ?? m.lastRunAt;
    return ref ? now - new Date(ref).getTime() : Infinity;
  };
  const recentDone = byKind.done.filter(m => doneAge(m) < COMPLETED_AGE_THRESHOLD_MS);
  const olderDone = byKind.done.filter(m => doneAge(m) >= COMPLETED_AGE_THRESHOLD_MS);
  // Nothing recent: show what there is rather than an empty section.
  const visibleDone = showOlder || recentDone.length === 0 ? byKind.done : recentDone;
  const hiddenDone = visibleDone.length === byKind.done.length ? 0 : olderDone.length;

  const active = show('active') ? byKind.active : [];
  const minis = MINI_KINDS.filter(show).flatMap(k => byKind[k]);
  // Only workspaces with something to say: an empty footer is a stray rule.
  const releases = Object.entries(releaseFooters).filter(([, data]) =>
    isReleaseVisible(classifyReleaseState({ archetype: data?.archetype ?? 'none', data })));
  const lastDone = byKind.done[0] ?? null;

  return (
    <div className="space-y-6">
      <FilterTabBar tab={tab} counts={counts} onSelect={setTab} />

      {(tab === 'all' || tab === 'active' || MINI_KINDS.includes(tab as ListCardKind)) && (
        <section data-testid="mission-group" data-group="active" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <span className="section-label text-text-muted">Active</span>
            {active.length > 0 && <PhaseBarLegend />}
          </div>
          {show('active') && active.length === 0 && (
            <div data-testid="missions-nothing-running" className="flex flex-wrap items-center justify-between gap-2 border border-dashed border-border-strong px-[18px] py-4 font-mono text-[12.5px] text-text-secondary">
              <span>
                Nothing running.
                {slots && slots.max > 0 && ` ${slots.max - slots.live === slots.max ? `All ${slots.max}` : slots.max - slots.live} slot${slots.max === 1 ? '' : 's'} free.`}
              </span>
              {lastDone && (
                <span className="text-text-muted">
                  Last: {lastDone.view.title}{lastDone.view.completedAt ? ` · ${timeAgo(lastDone.view.completedAt)}` : ''}
                </span>
              )}
            </div>
          )}
          {active.map(m => <ActiveMissionCard key={m.view.id} view={m.view} model={m.list} workspaceName={ws(m)} />)}
          {minis.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
              {minis.map(m => <MiniMissionCard key={m.view.id} view={m.view} model={m.list} workspaceName={ws(m)} />)}
            </div>
          )}
        </section>
      )}

      {/* D6: each workspace's release state, once — not on every card. */}
      {tab === 'all' && releases.length > 0 && (
        <section className="space-y-2">
          {releases.map(([wsId, data]) => (
            <div key={wsId} data-testid="workspace-release-footer" className="border border-border-default bg-card">
              <MissionReleaseFooter data={data} />
            </div>
          ))}
        </section>
      )}

      {show('done') && byKind.done.length > 0 && (
        <section data-testid="mission-group" data-group="completed" className="space-y-2.5">
          <div className="flex items-center justify-between gap-4">
            <span className="section-label text-text-muted">Done</span>
            {(hiddenDone > 0 || showOlder) && olderDone.length > 0 && recentDone.length > 0 && (
              <button
                type="button"
                onClick={() => setShowOlder(v => !v)}
                className="min-h-11 font-mono text-[11px] text-text-muted hover:text-text-secondary md:min-h-0"
              >
                {showOlder ? 'hide older ↑' : `show ${olderDone.length} older →`}
              </button>
            )}
          </div>
          <DoneMissionRows items={visibleDone.map(m => ({ view: m.view, model: m.list }))} />
        </section>
      )}

      {missions.length > 0 && tab !== 'all' && counts[tab] === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm text-text-secondary">No missions in this view.</p>
        </div>
      )}
    </div>
  );
}

function FilterTabBar({
  tab, counts, onSelect,
}: {
  tab: Tab;
  counts: Record<Tab, number>;
  onSelect: (t: Tab) => void;
}) {
  return (
    // Below md the tabs can outrun a phone's width: fade the trailing edge so
    // it reads as "scrolls", and pad the end so the last tab clears the fade.
    <div
      data-testid="mission-filter-bar"
      role="tablist"
      className="flex overflow-x-auto border-b border-border-default pr-6 md:pr-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] md:[mask-image:none]"
    >
      {TAB_ORDER.filter(t => t.always || counts[t.key] > 0).map(({ key, label, square }) => {
        const on = tab === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={on}
            data-testid="mission-filter-tab"
            data-tab={key}
            onClick={() => onSelect(key)}
            className={`-mb-px flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3.5 font-mono text-[12.5px] ${
              on ? 'border-accent text-text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            {square && <span aria-hidden="true" className={`inline-block h-[7px] w-[7px] ${square}`} />}
            {label}
            <b className={`font-semibold ${on ? 'text-text-primary' : 'text-text-secondary'}`}>{counts[key]}</b>
          </button>
        );
      })}
    </div>
  );
}
