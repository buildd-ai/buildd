'use client';

/**
 * Owns the mission page's task sheet (docs/design/mission-feed-mobile-continuity.md,
 * "Crux", W4/W5, "Interaction, URL and scroll model").
 *
 * - `?task=Y` is the sheet's state. It is written ONLY with native history
 *   calls (task-sheet-history.ts) — never `router.push`/`replace`/`refresh` —
 *   which the App Router syncs into `useSearchParams` without re-running the
 *   `force-dynamic` mission render (TaskSheet.next-history.test.ts). The list
 *   behind the sheet never unmounts, so there is no scroll to restore on close.
 * - A capture-phase delegated handler opens any `data-task-id` row
 *   (`resolveTaskOpen`); the pulse's second tap arrives through the focus
 *   store's `setOpenTask`.
 * - Closing focuses the task's row (outline, `nearest` scroll), and the focus
 *   store is told the sheet is open so realtime reorders stay frozen meanwhile.
 *
 * It also mounts the page's `MissionFocusProvider` (when none encloses it), so
 * the list, the pulse and the sheet share one selection.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { isValidTaskId } from '@/lib/task-id';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import { buildPulseSegments, type MissionFeedTaskInput } from '@/lib/mission-pulse';
import type { MissionOrigin } from '@/lib/mission-task-href';
import type { MastheadChip } from '@/components/missions/MissionMasthead';
import { useMissionFocusStore } from '@/components/missions/mission-focus-context';
import MissionFocusProvider from './MissionFocusProvider';
import TaskSheet, { type TaskSheetMission } from './TaskSheet';
import { buildTaskSheetNav } from './task-sheet-nav';
import { createTaskSheetHistory, resolveTaskOpen, type TaskSheetHistory } from './task-sheet-history';

export interface TaskPanelWrapperProps {
  children: React.ReactNode;
  missionId?: string;
  workspaceId?: string | null;
  missionTitle?: string;
  chip?: MastheadChip | null;
  /** The mission's tasks as feed-model input (`toMissionFeedTaskInput`), for the sheet header. */
  feedTasks?: readonly MissionFeedTaskInput[];
  from?: MissionOrigin | null;
  initiativeId?: string | null;
}

function browserHistory(): TaskSheetHistory {
  return createTaskSheetHistory({
    history: {
      get state() { return window.history.state; },
      pushState: (d, u, url) => window.history.pushState(d, u, url),
      replaceState: (d, u, url) => window.history.replaceState(d, u, url),
      back: () => window.history.back(),
    },
    location: () => ({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }),
  });
}

function TaskPanelInner({
  children, missionId, workspaceId, missionTitle, chip, feedTasks, from, initiativeId,
}: TaskPanelWrapperProps) {
  const searchParams = useSearchParams();
  const rawParam = searchParams.get('task');
  const urlTaskId = isValidTaskId(rawParam) ? rawParam : null;
  // Local state renders the sheet synchronously on tap; the URL (synced by the
  // App Router inside a transition) follows a frame later and agrees.
  const [taskId, setTaskId] = useState<string | null>(urlTaskId);
  const store = useMissionFocusStore();

  // Created on the client at mount, so it records whether we ENTERED with ?task=.
  const historyRef = useRef<TaskSheetHistory | null>(null);
  const sheetHistory = useCallback(() => (historyRef.current ??= browserHistory()), []);
  useEffect(() => {
    sheetHistory();
    const onPop = () => sheetHistory().onPopState();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [sheetHistory]);

  // Back / Forward and any other URL change: follow the URL.
  useEffect(() => {
    setTaskId(urlTaskId);
  }, [urlTaskId]);

  const openTask = useCallback((id: string) => {
    setTaskId(id);
    sheetHistory().open(id);
  }, [sheetHistory]);

  const stepTask = useCallback((id: string) => {
    setTaskId(id);
    sheetHistory().step(id);
  }, [sheetHistory]);

  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const closeTask = useCallback(() => {
    const prev = taskIdRef.current;
    if (!prev) return;
    taskIdRef.current = null;
    setTaskId(null);
    sheetHistory().close(prev);
  }, [sheetHistory]);

  // The pulse's second tap (and any other store-driven open) routes here.
  useEffect(() => {
    if (!store) return;
    store.setOpenTask(openTask);
    return () => store.setOpenTask(null);
  }, [store, openTask]);

  // Freeze list order while the sheet is open; on close, land focus on the row.
  const lastOpenRef = useRef<string | null>(taskId);
  useEffect(() => {
    store?.setSheetOpen(taskId !== null);
    const prev = lastOpenRef.current;
    lastOpenRef.current = taskId;
    if (prev && !taskId) store?.focus(prev, { writeHash: false, block: 'nearest' });
  }, [store, taskId]);
  useEffect(() => () => store?.setSheetOpen(false), [store]);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    const id = resolveTaskOpen({
      target: e.target,
      button: e.button,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      defaultPrevented: e.defaultPrevented,
    });
    if (!id) return;
    // Capture phase: stop a row's own <Link> from navigating before it runs.
    e.preventDefault();
    e.stopPropagation();
    openTask(id);
  }, [openTask]);

  const model = useMemo(() => (feedTasks && feedTasks.length > 0 ? buildMissionFeedGroups(feedTasks) : null), [feedTasks]);
  const segments = useMemo(() => (feedTasks ? buildPulseSegments(feedTasks) : []), [feedTasks]);
  const mission: TaskSheetMission | null = missionId && missionTitle && chip
    ? { id: missionId, title: missionTitle, chip, segments, from, initiativeId }
    : null;
  const nav = useMemo(
    () => buildTaskSheetNav(model, taskId ?? '', { missionId: missionId ?? '', from, initiativeId }),
    [model, taskId, missionId, from, initiativeId],
  );

  return (
    <>
      <div onClickCapture={handleClickCapture}>{children}</div>
      {taskId && (
        <TaskSheet
          taskId={taskId}
          mission={mission}
          nav={nav}
          workspaceId={workspaceId}
          onClose={closeTask}
          onStep={stepTask}
        />
      )}
    </>
  );
}

function WithFocus({ missionId, children }: { missionId?: string; children: React.ReactNode }) {
  const outer = useMissionFocusStore();
  if (outer || !missionId) return <>{children}</>;
  return <MissionFocusProvider missionId={missionId}>{children}</MissionFocusProvider>;
}

export default function TaskPanelWrapper(props: TaskPanelWrapperProps) {
  return (
    <WithFocus missionId={props.missionId}>
      <Suspense>
        <TaskPanelInner {...props} />
      </Suspense>
    </WithFocus>
  );
}
