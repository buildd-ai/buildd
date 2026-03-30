/**
 * Pure data transformation functions for the objective detail page.
 * Extracted from the server component for testability.
 */

export interface TaskResult {
  summary?: string;
  branch?: string;
  commits?: number;
  sha?: string;
  files?: number;
  added?: number;
  removed?: number;
  prUrl?: string;
  prNumber?: number;
  structuredOutput?: Record<string, unknown>;
}

export interface TaskData {
  id: string;
  title: string;
  status: string;
  priority: number;
  createdAt: Date | string;
  result: TaskResult | null;
  mode: string | null;
  workers?: WorkerData[];
}

export interface WorkerData {
  id: string;
  status: string;
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  costUsd: string | null;
  turns: number;
  completedAt: Date | string | null;
  startedAt: Date | string | null;
  currentAction: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  artifacts?: ArtifactData[];
}

export interface ArtifactData {
  id: string;
  type: string;
  title: string | null;
  key: string | null;
  shareToken: string | null;
  content?: string | null;
}

export interface RunHistoryItem {
  taskId: string;
  createdAt: Date | string;
  summary: string | undefined;
  tasksCreated: number | undefined;
  missionComplete: boolean;
  triageOutcome: 'single_task' | 'multi_task' | 'conflict' | undefined;
}

export interface ActivityItem {
  taskId: string;
  taskTitle: string;
  workerId: string;
  status: string;
  currentAction: string | null;
  prUrl: string | null;
  prNumber: number | null;
  branch: string | null;
  turns: number;
  costUsd: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

export interface MissionArtifact extends ArtifactData {
  taskTitle: string;
  workerStatus: string;
}

/**
 * Extract completed planning/recurring tasks as "Run History" items.
 * These are tasks with mode='planning' that completed — they represent
 * each execution of a recurring mission.
 */
export function extractRunHistory(tasks: TaskData[]): RunHistoryItem[] {
  return tasks
    .filter(t => t.mode === 'planning' && t.status === 'completed')
    .map(t => {
      const result = t.result;
      const structured = result?.structuredOutput;
      return {
        taskId: t.id,
        createdAt: t.createdAt,
        summary: result?.summary,
        tasksCreated: structured?.tasksCreated as number | undefined,
        missionComplete: !!structured?.missionComplete,
        triageOutcome: structured?.triageOutcome as 'single_task' | 'multi_task' | 'conflict' | undefined,
      };
    });
}

/**
 * Find the latest report from run history.
 * Returns the most recent run with a non-empty summary, or null.
 */
export function getLatestReport(runHistory: RunHistoryItem[]): RunHistoryItem | null {
  return runHistory.find(r => r.summary && r.summary.trim().length > 0) ?? null;
}

/**
 * Collect all artifacts from all workers across all tasks.
 * Annotates each with task title and worker status.
 */
export function collectArtifacts(tasks: TaskData[]): MissionArtifact[] {
  return tasks.flatMap(t =>
    (t.workers || []).flatMap(w =>
      (w.artifacts || []).map(a => ({
        ...a,
        taskTitle: t.title,
        workerStatus: w.status,
      }))
    )
  );
}

/**
 * Separate artifacts into "keyed" (state/pinned) and "regular" groups.
 * Keyed artifacts are workspace-level deduplicated artifacts that agents
 * update across runs. They represent persistent state.
 */
export function categorizeArtifacts(artifacts: MissionArtifact[]): {
  keyed: MissionArtifact[];
  regular: MissionArtifact[];
} {
  const keyed: MissionArtifact[] = [];
  const regular: MissionArtifact[] = [];

  for (const a of artifacts) {
    if (a.key) {
      keyed.push(a);
    } else {
      regular.push(a);
    }
  }

  return { keyed, regular };
}

/**
 * Collect and sort recent worker activity across all tasks.
 * Returns the most recent N activities sorted by completion/start time.
 */
export function collectRecentActivity(tasks: TaskData[], limit = 8): ActivityItem[] {
  return tasks
    .flatMap(t =>
      (t.workers || []).map(w => ({
        taskId: t.id,
        taskTitle: t.title,
        workerId: w.id,
        status: w.status,
        currentAction: w.currentAction,
        prUrl: w.prUrl,
        prNumber: w.prNumber,
        branch: w.branch,
        turns: w.turns,
        costUsd: w.costUsd,
        commitCount: w.commitCount,
        filesChanged: w.filesChanged,
        startedAt: w.startedAt,
        completedAt: w.completedAt,
      }))
    )
    .sort((a, b) => {
      const aTime = a.completedAt || a.startedAt;
      const bTime = b.completedAt || b.startedAt;
      if (!bTime) return -1;
      if (!aTime) return 1;
      return new Date(bTime as string).getTime() - new Date(aTime as string).getTime();
    })
    .slice(0, limit);
}

/**
 * Format a date as a relative time string (e.g. "5m ago", "2h ago").
 */
export function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Extract insights from completed execution tasks that have structured output.
 */
export function extractInsights(tasks: TaskData[]) {
  return tasks
    .filter(t => t.mode !== 'planning' && t.status === 'completed' && t.result?.structuredOutput)
    .map(t => ({
      taskId: t.id,
      title: t.title,
      structuredOutput: t.result!.structuredOutput!,
      createdAt: t.createdAt,
    }));
}
