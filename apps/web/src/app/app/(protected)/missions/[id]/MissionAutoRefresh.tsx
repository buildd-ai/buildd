'use client';

/**
 * Keeps the mission page live without re-rendering it on every heartbeat
 * (docs/design/mission-feed-mobile-continuity.md, "Realtime" and "Freeze
 * rule", slice S7, AC-17).
 *
 * - Subscribes to the workspace and mission Pusher channels and hands every
 *   event to `createMissionRefresher` (MissionLiveStore.ts): steady-status
 *   `worker:progress` patches the live store its children read; structural
 *   events call `router.refresh()`, at most once per 3s per tab.
 * - Around each refresh it anchors the reader's row: `rect.top` before, a
 *   `scrollTop` correction after the new render commits (mission-scroll-anchor.ts).
 * - A task that arrives above the viewport shows a `N new ↑` pill
 *   (`mission-new-rows-pill`) instead of pushing content down.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import type { Clock } from '@/lib/realtime-throttle';
import { MISSION_MASTHEAD_FOLDED_PX } from '@/components/missions/MissionMasthead';
import { missionTaskAnchorId } from '@/lib/mission-task-href';
import {
  MISSION_STRUCTURAL_EVENTS,
  MissionLiveContext,
  WORKSPACE_EVENTS,
  createMissionLiveStore,
  createMissionRefresher,
  type MissionRefresher,
} from './MissionLiveStore';
import { addedIds, captureScrollAnchor, restoreScrollAnchor, rowsAbove, type ScrollAnchor } from './mission-scroll-anchor';

// useLayoutEffect warns under SSR; the measurement is client-only anyway.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const defaultScroller = () => (typeof document === 'undefined' ? null : document.querySelector('main'));

export interface MissionAutoRefreshProps {
  missionId: string;
  workspaceId: string;
  /** Known task ids on this mission (for filtering worker events). */
  taskIds: string[];
  /** workerId → status as rendered: the baseline a status change is measured against. */
  workerStatuses?: Record<string, string>;
  /** Server render time. A new value means a new render committed. */
  renderedAt?: number;
  children?: ReactNode;
  /** Test seams. */
  clock?: Clock;
  scroller?: () => HTMLElement | null;
}

export default function MissionAutoRefresh({
  missionId,
  workspaceId,
  taskIds,
  workerStatuses,
  renderedAt,
  children,
  clock,
  scroller = defaultScroller,
}: MissionAutoRefreshProps) {
  const router = useRouter();
  const store = useMemo(() => createMissionLiveStore(), []);
  const refresherRef = useRef<MissionRefresher | null>(null);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const [pendingNew, setPendingNew] = useState<string[]>([]);

  const taskKey = taskIds.join(',');
  // Latest props for callbacks bound once per subscription.
  const latest = useRef({ taskIds, workerStatuses, scroller, router });
  latest.current = { taskIds, workerStatuses, scroller, router };

  useEffect(() => {
    if (!workspaceId) return;
    const refresher = createMissionRefresher({
      missionId,
      taskIds: latest.current.taskIds,
      workerStatuses: latest.current.workerStatuses,
      store,
      refresh: () => {
        const s = latest.current.scroller();
        anchorRef.current = s ? captureScrollAnchor(s) : null;
        latest.current.router.refresh();
      },
      isHidden: () => document.visibilityState === 'hidden',
      clock,
    });
    refresherRef.current = refresher;

    const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    const missionChannelName = `${CHANNEL_PREFIX}mission-${missionId}`;
    const missionChannel = subscribeToChannel(missionChannelName);

    const bound: Array<[typeof channel, string, (data: unknown) => void]> = [];
    for (const event of WORKSPACE_EVENTS) {
      const fn = (data: unknown) => refresher.onEvent(event, data);
      channel?.bind(event, fn);
      bound.push([channel, event, fn]);
    }
    // `mission:completion_decision` is emitted for every real completion
    // decision (docs/specs/mission-task-lifecycle.md): a refusal updates the
    // criteria and the feed, an approval moves the mission to completed.
    for (const event of MISSION_STRUCTURAL_EVENTS) {
      const fn = (data: unknown) => refresher.onEvent(event, data);
      missionChannel?.bind(event, fn);
      bound.push([missionChannel, event, fn]);
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresher.onVisible();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      for (const [ch, event, fn] of bound) ch?.unbind(event, fn);
      unsubscribeFromChannel(channelName);
      unsubscribeFromChannel(missionChannelName);
      document.removeEventListener('visibilitychange', onVisible);
      refresher.dispose();
      if (refresherRef.current === refresher) refresherRef.current = null;
    };
  }, [missionId, workspaceId, store, clock]);

  // New tasks appear after a render: follow their events too.
  useEffect(() => {
    refresherRef.current?.setTaskIds(taskKey ? taskKey.split(',') : []);
  }, [taskKey]);

  // ── After a new render commits ──
  const seenRender = useRef(renderedAt);
  const seenIds = useRef<Set<string>>(new Set(taskIds));
  useIsoLayoutEffect(() => {
    if (seenRender.current === renderedAt) return;
    seenRender.current = renderedAt;
    // The render carries the state every patch described.
    store.reset();
    const s = scroller();
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (s && anchor) restoreScrollAnchor(s, anchor);

    const added = addedIds(seenIds.current, taskIds);
    seenIds.current = new Set(taskIds);
    if (s && added.length > 0) {
      const above = rowsAbove(s, new Set(added));
      if (above.length > 0) setPendingNew(prev => [...prev, ...above.filter(id => !prev.includes(id))]);
    }
  }, [renderedAt, taskKey]);

  // The pill clears as its rows scroll into view.
  useEffect(() => {
    if (pendingNew.length === 0) return;
    const s = scroller();
    if (!s) return;
    const onScroll = () => {
      const still = rowsAbove(s, new Set(pendingNew));
      if (still.length !== pendingNew.length) setPendingNew(still);
    };
    s.addEventListener('scroll', onScroll, { passive: true });
    return () => s.removeEventListener('scroll', onScroll);
  }, [pendingNew, scroller]);

  const showNew = () => {
    const first = pendingNew[0];
    setPendingNew([]);
    if (first) document.getElementById(missionTaskAnchorId(first))?.scrollIntoView({ block: 'center' });
  };

  return (
    <MissionLiveContext.Provider value={store}>
      {children}
      {pendingNew.length > 0 && (
        <button
          type="button"
          data-testid="mission-new-rows-pill"
          onClick={showNew}
          style={{ top: `calc(env(safe-area-inset-top, 0px) + ${MISSION_MASTHEAD_FOLDED_PX + 8}px)` }}
          className="fixed left-1/2 z-30 flex min-h-11 -translate-x-1/2 items-center border-2 border-border-strong bg-card px-4 font-mono text-[12px] font-semibold text-text-primary shadow-[var(--card-shadow)]"
        >
          {`${pendingNew.length} new ↑`}
        </button>
      )}
    </MissionLiveContext.Provider>
  );
}
