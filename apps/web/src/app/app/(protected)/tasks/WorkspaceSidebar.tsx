'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import QuickCreateModal from './QuickCreateModal';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';

const COLLAPSED_STATE_KEY = 'buildd:workspaceCollapsed';
const SHOW_ALL_KEY = 'buildd:workspaceShowAll';
const COMPLETED_COLLAPSED_KEY = 'buildd:completedCollapsed';
const HIDDEN_WORKSPACES_KEY = 'buildd:hiddenWorkspaces';
const TASKS_PER_WORKSPACE = 5;

interface Task {
  id: string;
  title: string;
  status: string;
  updatedAt: Date;
  waitingFor?: { type: string; prompt: string; options?: string[] } | null;
}

interface Workspace {
  id: string;
  name: string;
  tasks: Task[];
}

interface Props {
  workspaces: Workspace[];
}

function getStatusIndicator(status: string): React.ReactNode {
  switch (status) {
    case 'running':
      // Actively running - spinning indicator
      return (
        <span className="h-2 w-2 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      );
    case 'assigned':
      // Claimed but not actively running - pulsing amber
      return (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        </span>
      );
    case 'pending':
      // Awaiting claim - solid gray
      return <span className="h-2 w-2 rounded-full bg-gray-400 dark:bg-gray-500" />;
    case 'completed':
      // Done/pushed - checkmark icon
      return (
        <svg
          className="h-3.5 w-3.5 text-green-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={3}
            d="M5 13l4 4L19 7"
          />
        </svg>
      );
    case 'waiting_input':
      // Waiting for user input - pulsing purple
      return (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
        </span>
      );
    case 'failed':
      // Failed - red circle
      return <span className="h-2 w-2 rounded-full bg-red-500" />;
    default:
      return null;
  }
}

// Worker type from Pusher events
interface WorkerUpdate {
  id: string;
  taskId: string | null;
  status: string;
  workspaceId: string;
  waitingFor?: { type: string; prompt: string; options?: string[] } | null;
}

// Task type from Pusher events
interface TaskCreated {
  task: {
    id: string;
    title: string;
    status: string;
    workspaceId: string;
    updatedAt: Date | string;
  };
}

export default function WorkspaceSidebar({ workspaces: initialWorkspaces }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [completedCollapsed, setCompletedCollapsed] = useState<Record<string, boolean>>({});
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<Record<string, boolean>>({});
  const [showHiddenSection, setShowHiddenSection] = useState(false);
  const [quickCreateWorkspaceId, setQuickCreateWorkspaceId] = useState<string | null>(null);

  // Update workspaces when props change (e.g., after navigation)
  useEffect(() => {
    setWorkspaces(initialWorkspaces);
  }, [initialWorkspaces]);

  // Handler for worker updates from Pusher
  const handleWorkerUpdate = useCallback((data: { worker: WorkerUpdate }) => {
    const { worker } = data;
    if (!worker.taskId) return;

    // Map worker status to task status
    const taskStatus = worker.status === 'completed' ? 'completed'
      : worker.status === 'failed' ? 'failed'
      : worker.status === 'waiting_input' ? 'waiting_input'
      : worker.status === 'running' ? 'running'
      : 'assigned';

    const waitingFor = worker.status === 'waiting_input' ? worker.waitingFor : null;

    setWorkspaces(prev => prev.map(ws => ({
      ...ws,
      tasks: ws.tasks.map(task =>
        task.id === worker.taskId
          ? { ...task, status: taskStatus, updatedAt: new Date(), waitingFor }
          : task
      )
    })));
  }, []);

  // Handler for new task creation from Pusher
  const handleTaskCreated = useCallback((data: TaskCreated) => {
    const { task } = data;
    if (!task) return;

    setWorkspaces(prev => prev.map(ws => {
      if (ws.id !== task.workspaceId) return ws;
      // Check if task already exists (avoid duplicates)
      if (ws.tasks.some(t => t.id === task.id)) return ws;
      return {
        ...ws,
        tasks: [
          {
            id: task.id,
            title: task.title,
            status: task.status,
            updatedAt: new Date(task.updatedAt),
          },
          ...ws.tasks,
        ],
      };
    }));
  }, []);

  // Stable workspace IDs for dependency tracking
  const workspaceIds = workspaces.map(ws => ws.id);
  const workspaceIdsKey = workspaceIds.join(',');

  // Subscribe to Pusher channels for real-time updates
  useEffect(() => {
    const channelNames = workspaceIds.map(id => `workspace-${id}`);

    for (const channelName of channelNames) {
      const channel = subscribeToChannel(channelName);
      if (channel) {
        channel.bind('worker:progress', handleWorkerUpdate);
        channel.bind('worker:completed', handleWorkerUpdate);
        channel.bind('worker:failed', handleWorkerUpdate);
        channel.bind('task:created', handleTaskCreated);
      }
    }

    return () => {
      for (const channelName of channelNames) {
        unsubscribeFromChannel(channelName);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, handleWorkerUpdate, handleTaskCreated]);

  // Load collapsed state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_STATE_KEY);
      if (saved) setCollapsed(JSON.parse(saved));
      const savedShowAll = localStorage.getItem(SHOW_ALL_KEY);
      if (savedShowAll) setShowAll(JSON.parse(savedShowAll));
      const savedCompletedCollapsed = localStorage.getItem(COMPLETED_COLLAPSED_KEY);
      if (savedCompletedCollapsed) setCompletedCollapsed(JSON.parse(savedCompletedCollapsed));
      const savedHidden = localStorage.getItem(HIDDEN_WORKSPACES_KEY);
      if (savedHidden) setHiddenWorkspaces(JSON.parse(savedHidden));
    } catch {
      // ignore
    }
  }, []);

  const toggleCollapse = (wsId: string) => {
    const newState = { ...collapsed, [wsId]: !collapsed[wsId] };
    setCollapsed(newState);
    localStorage.setItem(COLLAPSED_STATE_KEY, JSON.stringify(newState));
  };

  const toggleShowAll = (wsId: string) => {
    const newState = { ...showAll, [wsId]: !showAll[wsId] };
    setShowAll(newState);
    localStorage.setItem(SHOW_ALL_KEY, JSON.stringify(newState));
  };

  const toggleCompletedCollapsed = (wsId: string) => {
    const newState = { ...completedCollapsed, [wsId]: !completedCollapsed[wsId] };
    setCompletedCollapsed(newState);
    localStorage.setItem(COMPLETED_COLLAPSED_KEY, JSON.stringify(newState));
  };

  const toggleHideWorkspace = (wsId: string) => {
    const newState = { ...hiddenWorkspaces, [wsId]: !hiddenWorkspaces[wsId] };
    setHiddenWorkspaces(newState);
    localStorage.setItem(HIDDEN_WORKSPACES_KEY, JSON.stringify(newState));
  };

  // Get selected task ID from pathname
  const selectedTaskId = pathname.startsWith('/app/tasks/')
    ? pathname.split('/app/tasks/')[1]?.split('/')[0]
    : null;

  const handleQuickCreateComplete = (taskId: string) => {
    setQuickCreateWorkspaceId(null);
    router.push(`/app/tasks/${taskId}`);
    router.refresh();
  };

  // Helper to get status priority for sorting
  const getStatusPriority = (status: string): number => {
    switch (status) {
      case 'running':
      case 'assigned':
      case 'waiting_input':
        return 0; // Highest priority
      case 'pending':
        return 1;
      case 'failed':
        return 2;
      case 'completed':
        return 3; // Lowest priority
      default:
        return 4;
    }
  };

  // Sort workspaces: those with active tasks first, then sort tasks within each workspace
  const allSortedWorkspaces = [...workspaces].map(ws => ({
    ...ws,
    tasks: [...ws.tasks].sort((a, b) => {
      // First sort by status priority
      const priorityDiff = getStatusPriority(a.status) - getStatusPriority(b.status);
      if (priorityDiff !== 0) return priorityDiff;

      // Then by most recent update
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
  })).sort((a, b) => {
    const aHasActive = a.tasks.some(t => ['running', 'assigned', 'waiting_input'].includes(t.status));
    const bHasActive = b.tasks.some(t => ['running', 'assigned', 'waiting_input'].includes(t.status));
    if (aHasActive && !bHasActive) return -1;
    if (!aHasActive && bHasActive) return 1;
    return 0;
  });

  // Split into visible and hidden workspaces
  const sortedWorkspaces = allSortedWorkspaces.filter(ws => !hiddenWorkspaces[ws.id]);
  const hiddenWorkspacesList = allSortedWorkspaces.filter(ws => hiddenWorkspaces[ws.id]);
  const hiddenCount = hiddenWorkspacesList.length;

  return (
    <>
      <aside className="w-64 border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <Link href="/app/dashboard" className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
              &larr; Dashboard
            </Link>
            <Link
              href="/app/tasks/new"
              className="text-xs px-2 py-1 bg-black dark:bg-white text-white dark:text-black rounded hover:opacity-80"
            >
              + New
            </Link>
          </div>
          <h1 className="text-lg font-semibold mt-2">Tasks</h1>
        </div>

        {/* Workspace list */}
        <nav className="flex-1 overflow-y-auto p-2">
          {sortedWorkspaces.length === 0 && hiddenCount === 0 ? (
            <div className="text-sm text-gray-500 p-4 text-center">
              No workspaces yet
            </div>
          ) : sortedWorkspaces.length === 0 ? (
            <div className="text-sm text-gray-500 p-4 text-center">
              All workspaces hidden
            </div>
          ) : (
            <div className="space-y-1">
              {sortedWorkspaces.map((ws) => {
                const isCollapsed = collapsed[ws.id];
                const isShowingAll = showAll[ws.id];
                const visibleTasks = isShowingAll
                  ? ws.tasks
                  : ws.tasks.slice(0, TASKS_PER_WORKSPACE);
                const hasMore = ws.tasks.length > TASKS_PER_WORKSPACE;
                const activeCount = ws.tasks.filter(
                  t => ['running', 'assigned', 'waiting_input'].includes(t.status)
                ).length;

                return (
                  <div key={ws.id}>
                    {/* Workspace header */}
                    <div className="flex items-center gap-1 group">
                      <button
                        onClick={() => toggleCollapse(ws.id)}
                        className="flex items-center gap-1 flex-1 px-2 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                      >
                        <span className="text-gray-400 w-4">
                          {isCollapsed ? '›' : '▼'}
                        </span>
                        <span className="truncate">{ws.name}</span>
                        {activeCount > 0 && (
                          <span className="ml-auto flex items-center gap-1">
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                            </span>
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => setQuickCreateWorkspaceId(ws.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                        title="Quick create task"
                      >
                        +
                      </button>
                      <button
                        onClick={() => toggleHideWorkspace(ws.id)}
                        className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                        title="Hide workspace"
                      >
                        hide
                      </button>
                    </div>

                    {/* Tasks */}
                    {!isCollapsed && (() => {
                      // Split tasks into active/pending vs completed/failed
                      const activeTasks = visibleTasks.filter(t =>
                        ['running', 'assigned', 'pending', 'waiting_input'].includes(t.status)
                      );
                      const completedTasks = visibleTasks.filter(t =>
                        ['completed', 'failed'].includes(t.status)
                      );
                      // Total completed count from ALL tasks (not just visible)
                      const totalCompletedCount = ws.tasks.filter(t =>
                        ['completed', 'failed'].includes(t.status)
                      ).length;
                      const isCompletedHidden = completedCollapsed[ws.id] ?? true; // Default collapsed

                      return (
                        <div className="ml-4 mt-0.5 space-y-0.5">
                          {activeTasks.length === 0 && completedTasks.length === 0 ? (
                            <div className="px-2 py-1 text-xs text-gray-400">
                              No tasks
                            </div>
                          ) : (
                            <>
                              {/* Active/Pending tasks */}
                              {activeTasks.map((task) => (
                                <Link
                                  key={task.id}
                                  href={`/app/tasks/${task.id}`}
                                  className={`flex items-start gap-2 px-2 py-1.5 text-sm rounded ${
                                    selectedTaskId === task.id
                                      ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100'
                                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                                  }`}
                                >
                                  <span className="mt-1 shrink-0">{getStatusIndicator(task.status)}</span>
                                  <span className="flex-1 min-w-0">
                                    <span className="truncate block">{task.title}</span>
                                    {task.waitingFor?.prompt && (
                                      <span className="text-xs text-purple-600 dark:text-purple-400 truncate block">
                                        {task.waitingFor.prompt.length > 60
                                          ? task.waitingFor.prompt.slice(0, 60) + '...'
                                          : task.waitingFor.prompt}
                                      </span>
                                    )}
                                  </span>
                                </Link>
                              ))}

                              {/* Completed section - collapsible */}
                              {completedTasks.length > 0 && (
                                <>
                                  <button
                                    onClick={() => toggleCompletedCollapsed(ws.id)}
                                    className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 w-full"
                                  >
                                    <span className="w-3 text-[10px]">{isCompletedHidden ? '›' : '▼'}</span>
                                    <span>Completed ({totalCompletedCount})</span>
                                  </button>
                                  {!isCompletedHidden && completedTasks.map((task) => (
                                    <Link
                                      key={task.id}
                                      href={`/app/tasks/${task.id}`}
                                      className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded ${
                                        selectedTaskId === task.id
                                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100'
                                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                                      }`}
                                    >
                                      {getStatusIndicator(task.status)}
                                      <span className="truncate flex-1">{task.title}</span>
                                    </Link>
                                  ))}
                                </>
                              )}

                              {/* Show toggle only when it would change visible content */}
                              {hasMore && (() => {
                                // Count active tasks in ALL tasks (not just visible)
                                const totalActiveTasks = ws.tasks.filter(t =>
                                  ['running', 'assigned', 'pending', 'waiting_input'].includes(t.status)
                                ).length;
                                // Show "See all" if not showing all and there's more content
                                // Show "Show less" only if:
                                // - there are more than 5 active tasks, OR
                                // - completed section is expanded
                                const shouldShowLess = isShowingAll && (
                                  totalActiveTasks > TASKS_PER_WORKSPACE || !isCompletedHidden
                                );
                                const shouldShowMore = !isShowingAll;

                                if (!shouldShowLess && !shouldShowMore) return null;

                                return (
                                  <button
                                    onClick={() => toggleShowAll(ws.id)}
                                    className="px-2 py-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                  >
                                    {shouldShowLess
                                      ? 'Show less'
                                      : `See all (${ws.tasks.length})`}
                                  </button>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}

          {/* Hidden workspaces section */}
          {hiddenCount > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowHiddenSection(!showHiddenSection)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 w-full"
              >
                <span className="w-3 text-[10px]">{showHiddenSection ? '▼' : '›'}</span>
                <span>Hidden ({hiddenCount})</span>
              </button>
              {showHiddenSection && (
                <div className="mt-1 space-y-1">
                  {hiddenWorkspacesList.map((ws) => (
                    <div key={ws.id} className="flex items-center gap-1 group">
                      <span className="px-2 py-1.5 text-sm text-gray-400 truncate flex-1">
                        {ws.name}
                      </span>
                      <button
                        onClick={() => toggleHideWorkspace(ws.id)}
                        className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                        title="Show workspace"
                      >
                        show
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>
      </aside>

      {/* Quick Create Modal */}
      {quickCreateWorkspaceId && (
        <QuickCreateModal
          workspaceId={quickCreateWorkspaceId}
          workspaceName={workspaces.find(w => w.id === quickCreateWorkspaceId)?.name || ''}
          onClose={() => setQuickCreateWorkspaceId(null)}
          onCreated={handleQuickCreateComplete}
        />
      )}
    </>
  );
}
