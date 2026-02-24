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
const SEARCH_KEY = 'buildd:taskSearch';

interface Task {
  id: string;
  title: string;
  status: string;
  category?: string | null;
  project?: string | null;
  updatedAt: Date;
  waitingFor?: { type: string; prompt: string; options?: string[] } | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  bug: 'bg-cat-bug/15 text-cat-bug',
  feature: 'bg-cat-feature/15 text-cat-feature',
  refactor: 'bg-cat-refactor/15 text-cat-refactor',
  chore: 'bg-cat-chore/15 text-cat-chore',
  docs: 'bg-cat-docs/15 text-cat-docs',
  test: 'bg-cat-test/15 text-cat-test',
  infra: 'bg-cat-infra/15 text-cat-infra',
  design: 'bg-cat-design/15 text-cat-design',
};

function CategoryBadge({ category }: { category: string }) {
  const colors = CATEGORY_COLORS[category] || 'bg-cat-chore/15 text-cat-chore';
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${colors} shrink-0`}>
      {category}
    </span>
  );
}

interface Workspace {
  id: string;
  name: string;
  gitConfig?: { targetBranch?: string; defaultBranch?: string } | null;
  tasks: Task[];
}

interface Props {
  workspaces: Workspace[];
}

function getStatusIndicator(status: string): React.ReactNode {
  switch (status) {
    case 'running':
      return <span className="glow-dot glow-dot-running" />;
    case 'assigned':
      return <span className="glow-dot glow-dot-info" />;
    case 'pending':
      return <span className="h-2 w-2 rounded-full bg-text-muted" />;
    case 'completed':
      return (
        <svg
          className="h-3.5 w-3.5 text-status-success"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
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
      return <span className="glow-dot glow-dot-warning" />;
    case 'failed':
      return <span className="glow-dot glow-dot-error" />;
    case 'blocked':
      return <span className="glow-dot glow-dot-info" />;
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
    project?: string | null;
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
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [projectRegistry, setProjectRegistry] = useState<Record<string, { name: string; color?: string }[]>>({});

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
      tasks: ws.tasks.map(task => {
        if (task.id !== worker.taskId) return task;
        // Don't override terminal task states with active worker states
        const isTerminal = task.status === 'completed' || task.status === 'failed';
        if (isTerminal && taskStatus !== 'completed' && taskStatus !== 'failed') return task;
        return { ...task, status: taskStatus, updatedAt: new Date(), waitingFor };
      })
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
            project: task.project,
            updatedAt: new Date(task.updatedAt),
          },
          ...ws.tasks,
        ],
      };
    }));
  }, []);

  // Handler for task claimed (worker picked up the task)
  const handleTaskClaimed = useCallback((data: { task: { id: string; status: string; workspaceId: string } }) => {
    const { task } = data;
    if (!task) return;

    setWorkspaces(prev => prev.map(ws => ({
      ...ws,
      tasks: ws.tasks.map(t =>
        t.id === task.id ? { ...t, status: 'assigned', updatedAt: new Date() } : t
      ),
    })));
  }, []);

  // Handler for task assigned (task start broadcast - update status)
  const handleTaskAssigned = useCallback((data: { task: { id: string; workspaceId: string } }) => {
    const { task } = data;
    if (!task) return;

    // Mark as assigned when start is triggered (will be updated again on claim)
    setWorkspaces(prev => prev.map(ws => ({
      ...ws,
      tasks: ws.tasks.map(t =>
        t.id === task.id && t.status === 'pending' ? { ...t, status: 'assigned', updatedAt: new Date() } : t
      ),
    })));
  }, []);

  // Handler for task unblocked (dependency resolved)
  const handleTaskUnblocked = useCallback((data: { task: { id: string; status: string; workspaceId: string } }) => {
    const { task } = data;
    if (!task) return;

    setWorkspaces(prev => prev.map(ws => ({
      ...ws,
      tasks: ws.tasks.map(t =>
        t.id === task.id ? { ...t, status: task.status || 'pending', updatedAt: new Date() } : t
      ),
    })));
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
        channel.bind('task:claimed', handleTaskClaimed);
        channel.bind('task:assigned', handleTaskAssigned);
        channel.bind('task:unblocked', handleTaskUnblocked);
      }
    }

    return () => {
      for (const channelName of channelNames) {
        unsubscribeFromChannel(channelName);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, handleWorkerUpdate, handleTaskCreated, handleTaskClaimed, handleTaskAssigned, handleTaskUnblocked]);

  // Fetch project registries for all workspaces
  useEffect(() => {
    for (const ws of workspaces) {
      fetch(`/api/workspaces/${ws.id}/projects`)
        .then(res => res.json())
        .then(data => {
          setProjectRegistry(prev => ({ ...prev, [ws.id]: data.projects || [] }));
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey]);

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

  const handleRetryTask = async (e: React.MouseEvent, taskId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setRetryingTaskId(taskId);
    try {
      const res = await fetch(`/api/tasks/${taskId}/reassign?force=true`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
      }
    } catch {
      // ignore
    } finally {
      setRetryingTaskId(null);
    }
  };

  // Helper to get status priority for sorting
  const getStatusPriority = (status: string): number => {
    switch (status) {
      case 'running':
      case 'assigned':
      case 'waiting_input':
        return 0; // Highest priority
      case 'pending':
      case 'blocked':
        return 1;
      case 'failed':
        return 2;
      case 'completed':
        return 3; // Lowest priority
      default:
        return 4;
    }
  };

  // Collect all distinct projects across all tasks for the filter
  const allProjects = new Map<string, string | undefined>();
  for (const ws of workspaces) {
    const registry = projectRegistry[ws.id] || [];
    for (const t of ws.tasks) {
      if (t.project) {
        const reg = registry.find(p => p.name === t.project);
        allProjects.set(t.project, reg?.color);
      }
    }
  }

  // Filter tasks by search query and project
  const searchLower = searchQuery.toLowerCase();
  const filteredWorkspaces = workspaces.map(ws => ({
    ...ws,
    tasks: ws.tasks.filter(t => {
      if (searchQuery && !t.title.toLowerCase().includes(searchLower)) return false;
      if (projectFilter && t.project !== projectFilter) return false;
      return true;
    }),
  })).filter(ws => ws.tasks.length > 0 || (!searchQuery && !projectFilter));

  // Sort workspaces: those with active tasks first, then sort tasks within each workspace
  const allSortedWorkspaces = [...filteredWorkspaces].map(ws => ({
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
      <aside className="w-64 border-r border-border-default bg-surface-2 flex flex-col h-full">
        {/* Header */}
        <div className="p-4 border-b border-border-default">
          <div className="flex items-center justify-between">
            <Link href="/app/dashboard" className="text-sm text-text-secondary hover:text-text-primary">
              &larr; Dashboard
            </Link>
            <Link
              href="/app/tasks/new"
              className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-hover"
            >
              + New
            </Link>
          </div>
          <h1 className="text-lg font-semibold mt-2">Tasks</h1>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            className="w-full px-2.5 py-1.5 text-sm border border-border-default rounded bg-surface-1 focus:ring-2 focus:ring-primary-ring focus:border-primary placeholder-text-muted"
          />
        </div>

        {/* Project filter */}
        {allProjects.size > 0 && (
          <div className="px-3 pb-2 flex flex-wrap gap-1">
            <button
              onClick={() => setProjectFilter(null)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors ${
                !projectFilter
                  ? 'bg-primary/15 text-primary'
                  : 'bg-surface-3 text-text-muted hover:text-text-secondary'
              }`}
            >
              All
            </button>
            {Array.from(allProjects.entries()).map(([name, color]) => (
              <button
                key={name}
                onClick={() => setProjectFilter(projectFilter === name ? null : name)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors flex items-center gap-1 ${
                  projectFilter === name
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-3 text-text-muted hover:text-text-secondary'
                }`}
              >
                {color && (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                )}
                {name}
              </button>
            ))}
          </div>
        )}

        {/* Workspace list */}
        <nav className="flex-1 overflow-y-auto p-2">
          {sortedWorkspaces.length === 0 && hiddenCount === 0 ? (
            <div className="text-sm text-text-secondary p-4 text-center">
              No workspaces yet
            </div>
          ) : sortedWorkspaces.length === 0 ? (
            <div className="text-sm text-text-secondary p-4 text-center">
              All workspaces hidden
            </div>
          ) : (
            <div className="space-y-1">
              {sortedWorkspaces.map((ws) => {
                const isCollapsed = collapsed[ws.id];
                const activeCount = ws.tasks.filter(
                  t => ['running', 'assigned', 'waiting_input'].includes(t.status)
                ).length;

                return (
                  <div key={ws.id}>
                    {/* Workspace header */}
                    <div className="flex items-center gap-1 group">
                      <button
                        onClick={() => toggleCollapse(ws.id)}
                        aria-expanded={!isCollapsed}
                        className="flex items-center gap-1 flex-1 px-2 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-3 rounded"
                      >
                        <span className="text-text-muted w-4">
                          {isCollapsed ? '›' : '▼'}
                        </span>
                        <span className="truncate">{ws.name}</span>
                        {activeCount > 0 && (
                          <span className="ml-auto flex items-center gap-1.5">
                            <span className="glow-dot glow-dot-running" />
                            <span className="text-[10px] font-mono text-status-running">{activeCount}</span>
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => setQuickCreateWorkspaceId(ws.id)}
                        className="opacity-100 md:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 text-text-muted hover:text-text-primary rounded hover:bg-surface-3"
                        title="Quick create task"
                        aria-label={`Quick create task in ${ws.name}`}
                      >
                        +
                      </button>
                      <button
                        onClick={() => toggleHideWorkspace(ws.id)}
                        className="opacity-100 md:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary rounded hover:bg-surface-3"
                        title="Hide workspace"
                        aria-label={`Hide ${ws.name}`}
                      >
                        hide
                      </button>
                    </div>

                    {/* Tasks */}
                    {!isCollapsed && (() => {
                      // Split ALL tasks into active vs completed BEFORE slicing
                      const allActiveTasks = ws.tasks.filter(t =>
                        ['running', 'assigned', 'pending', 'waiting_input', 'blocked'].includes(t.status)
                      );
                      const allCompletedTasks = ws.tasks.filter(t =>
                        ['completed', 'failed'].includes(t.status)
                      );
                      // Always show ALL active tasks, limit completed
                      const isShowingAllCompleted = showAll[ws.id];
                      const visibleCompletedTasks = isShowingAllCompleted
                        ? allCompletedTasks
                        : allCompletedTasks.slice(0, TASKS_PER_WORKSPACE);
                      const hiddenCompletedCount = allCompletedTasks.length - visibleCompletedTasks.length;
                      const isCompletedHidden = completedCollapsed[ws.id] ?? true; // Default collapsed

                      return (
                        <div className="ml-4 mt-0.5 space-y-0.5">
                          {allActiveTasks.length === 0 && allCompletedTasks.length === 0 ? (
                            <div className="px-2 py-1 text-xs text-text-muted">
                              No tasks
                            </div>
                          ) : (
                            <>
                              {/* Active/Pending tasks - always show all */}
                              {allActiveTasks.length > 0 && (
                                <div className="section-label px-2 py-1.5 mb-0.5">Active</div>
                              )}
                              {allActiveTasks.map((task) => (
                                <Link
                                  key={task.id}
                                  href={`/app/tasks/${task.id}`}
                                  data-testid="sidebar-task-item"
                                  data-task-id={task.id}
                                  data-status={task.status}
                                  className={`flex items-start gap-2 px-2 py-1.5 text-sm rounded ${selectedTaskId === task.id
                                      ? 'bg-primary-subtle text-text-primary'
                                      : 'text-text-secondary hover:bg-surface-3'
                                    }`}
                                >
                                  <span className="mt-1 shrink-0">{getStatusIndicator(task.status)}</span>
                                  <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-1.5">
                                      <span className="truncate">{task.title}</span>
                                      {task.category && <CategoryBadge category={task.category} />}
                                      {task.project && (
                                        <span className="px-1 py-0.5 text-[9px] font-medium rounded bg-primary/10 text-primary shrink-0 flex items-center gap-0.5">
                                          {(() => {
                                            const reg = (projectRegistry[ws.id] || []).find(p => p.name === task.project);
                                            return reg?.color ? <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: reg.color }} /> : null;
                                          })()}
                                          {task.project}
                                        </span>
                                      )}
                                    </span>
                                    {task.waitingFor?.prompt && (
                                      <span data-testid="sidebar-task-question" className="text-xs text-status-warning truncate block">
                                        {task.waitingFor.prompt.length > 60
                                          ? task.waitingFor.prompt.slice(0, 60) + '...'
                                          : task.waitingFor.prompt}
                                      </span>
                                    )}
                                  </span>
                                </Link>
                              ))}

                              {/* Completed section - collapsible */}
                              {allCompletedTasks.length > 0 && (
                                <>
                                  <button
                                    onClick={() => toggleCompletedCollapsed(ws.id)}
                                    aria-expanded={!isCompletedHidden}
                                    className="flex items-center gap-1.5 px-2 py-1.5 section-label hover:text-text-secondary w-full mt-1"
                                  >
                                    <span className="text-[10px]">{isCompletedHidden ? '›' : '▼'}</span>
                                    <span>Done ({allCompletedTasks.length})</span>
                                  </button>
                                  {!isCompletedHidden && (
                                    <>
                                      {visibleCompletedTasks.map((task) => (
                                        <Link
                                          key={task.id}
                                          href={`/app/tasks/${task.id}`}
                                          className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded group/task ${selectedTaskId === task.id
                                              ? 'bg-primary-subtle text-text-primary'
                                              : 'text-text-secondary hover:bg-surface-3'
                                            }`}
                                        >
                                          {getStatusIndicator(task.status)}
                                          <span className="truncate flex-1">{task.title}</span>
                                          {task.status === 'failed' && (
                                            <button
                                              onClick={(e) => handleRetryTask(e, task.id)}
                                              disabled={retryingTaskId === task.id}
                                              className="opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100 p-0.5 text-text-muted hover:text-status-warning rounded hover:bg-surface-3 shrink-0 disabled:opacity-50"
                                              title="Retry task"
                                              aria-label={`Retry ${task.title}`}
                                            >
                                              {retryingTaskId === task.id ? (
                                                <span className="w-3.5 h-3.5 block border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
                                              ) : (
                                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                  <polyline points="23 4 23 10 17 10" />
                                                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                                                </svg>
                                              )}
                                            </button>
                                          )}
                                          {task.category && <CategoryBadge category={task.category} />}
                                          {task.project && (
                                            <span className="px-1 py-0.5 text-[9px] font-medium rounded bg-primary/10 text-primary shrink-0">
                                              {task.project}
                                            </span>
                                          )}
                                        </Link>
                                      ))}
                                      {hiddenCompletedCount > 0 && (
                                        <button
                                          onClick={() => toggleShowAll(ws.id)}
                                          className="px-2 py-1 text-xs text-text-muted hover:text-text-secondary"
                                        >
                                          Show {hiddenCompletedCount} more completed
                                        </button>
                                      )}
                                      {isShowingAllCompleted && allCompletedTasks.length > TASKS_PER_WORKSPACE && (
                                        <button
                                          onClick={() => toggleShowAll(ws.id)}
                                          className="px-2 py-1 text-xs text-text-muted hover:text-text-secondary"
                                        >
                                          Show less
                                        </button>
                                      )}
                                    </>
                                  )}
                                </>
                              )}
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
            <div className="mt-4 pt-4 border-t border-border-default">
              <button
                onClick={() => setShowHiddenSection(!showHiddenSection)}
                aria-expanded={showHiddenSection}
                className="flex items-center gap-1.5 px-2 py-1.5 section-label hover:text-text-secondary w-full"
              >
                <span className="text-[10px]">{showHiddenSection ? '▼' : '›'}</span>
                <span>Hidden ({hiddenCount})</span>
              </button>
              {showHiddenSection && (
                <div className="mt-1 space-y-1">
                  {hiddenWorkspacesList.map((ws) => (
                    <div key={ws.id} className="flex items-center gap-1 group">
                      <span className="px-2 py-1.5 text-sm text-text-muted truncate flex-1">
                        {ws.name}
                      </span>
                      <button
                        onClick={() => toggleHideWorkspace(ws.id)}
                        className="opacity-100 md:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary rounded hover:bg-surface-3"
                        title="Show workspace"
                        aria-label={`Show ${ws.name}`}
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
          targetBranch={(() => {
            const ws = workspaces.find(w => w.id === quickCreateWorkspaceId);
            return ws?.gitConfig?.targetBranch || ws?.gitConfig?.defaultBranch || null;
          })()}
          onClose={() => setQuickCreateWorkspaceId(null)}
          onCreated={handleQuickCreateComplete}
        />
      )}
    </>
  );
}
