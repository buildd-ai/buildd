'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import QuickCreateModal from './QuickCreateModal';

const COLLAPSED_STATE_KEY = 'buildd:workspaceCollapsed';
const SHOW_ALL_KEY = 'buildd:workspaceShowAll';
const TASKS_PER_WORKSPACE = 5;

interface Task {
  id: string;
  title: string;
  status: string;
  updatedAt: Date;
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
    case 'assigned':
      // Active work - pulsing amber indicator
      return (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        </span>
      );
    case 'pending':
      // Requires action - solid circle
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
    case 'failed':
      // Failed - red circle
      return <span className="h-2 w-2 rounded-full bg-red-500" />;
    default:
      return null;
  }
}

export default function WorkspaceSidebar({ workspaces }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [quickCreateWorkspaceId, setQuickCreateWorkspaceId] = useState<string | null>(null);

  // Load collapsed state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_STATE_KEY);
      if (saved) setCollapsed(JSON.parse(saved));
      const savedShowAll = localStorage.getItem(SHOW_ALL_KEY);
      if (savedShowAll) setShowAll(JSON.parse(savedShowAll));
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

  // Get selected task ID from pathname
  const selectedTaskId = pathname.startsWith('/app/tasks/')
    ? pathname.split('/app/tasks/')[1]?.split('/')[0]
    : null;

  const handleTaskCreated = (taskId: string) => {
    setQuickCreateWorkspaceId(null);
    router.push(`/app/tasks/${taskId}`);
    router.refresh();
  };

  // Helper to get status priority for sorting
  const getStatusPriority = (status: string): number => {
    switch (status) {
      case 'running':
      case 'assigned':
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
  const sortedWorkspaces = [...workspaces].map(ws => ({
    ...ws,
    tasks: [...ws.tasks].sort((a, b) => {
      // First sort by status priority
      const priorityDiff = getStatusPriority(a.status) - getStatusPriority(b.status);
      if (priorityDiff !== 0) return priorityDiff;

      // Then by most recent update
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
  })).sort((a, b) => {
    const aHasActive = a.tasks.some(t => t.status === 'running' || t.status === 'assigned');
    const bHasActive = b.tasks.some(t => t.status === 'running' || t.status === 'assigned');
    if (aHasActive && !bHasActive) return -1;
    if (!aHasActive && bHasActive) return 1;
    return 0;
  });

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
          {sortedWorkspaces.length === 0 ? (
            <div className="text-sm text-gray-500 p-4 text-center">
              No workspaces yet
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
                  t => t.status === 'running' || t.status === 'assigned'
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
                    </div>

                    {/* Tasks */}
                    {!isCollapsed && (
                      <div className="ml-4 mt-0.5 space-y-0.5">
                        {visibleTasks.length === 0 ? (
                          <div className="px-2 py-1 text-xs text-gray-400">
                            No tasks
                          </div>
                        ) : (
                          <>
                            {visibleTasks.map((task) => (
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
                            {hasMore && (
                              <button
                                onClick={() => toggleShowAll(ws.id)}
                                className="px-2 py-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                              >
                                {isShowingAll
                                  ? 'Show less'
                                  : `See all (${ws.tasks.length})`}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
          onCreated={handleTaskCreated}
        />
      )}
    </>
  );
}
