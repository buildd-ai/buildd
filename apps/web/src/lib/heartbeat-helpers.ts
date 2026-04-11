/**
 * Pure helper functions for heartbeat mission UI.
 */

// ── Defaults for heartbeat mission creation ──

export const DEFAULT_HEARTBEAT_CHECKLIST = `# Heartbeat Checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- Check pending tasks for blockers`;

export const DEFAULT_HEARTBEAT_CRON = '*/30 * * * *';
export const DEFAULT_ACTIVE_HOURS_START = 8;
export const DEFAULT_ACTIVE_HOURS_END = 22;
export const DEFAULT_ACTIVE_HOURS_TIMEZONE = 'America/New_York';

export const DEFAULT_MISSION_HEARTBEAT_CHECKLIST = `- [ ] Assess mission phase: are we planning, building, reviewing, or stalled?
- [ ] If plan exists but no coding tasks: create them (outputRequirement=pr_required, roleSlug=builder)
- [ ] If no workspace/repo exists: create one with manage_workspaces, then create coding tasks
- [ ] Retry any failed tasks with failureContext
- [ ] Check PR merge status — create integration task if conflicts exist
- [ ] Do NOT report OK if the mission has not made forward progress since last heartbeat
- [ ] If ALL planned work is done (tasks completed, PRs merged or delivered), set missionComplete: true in structuredOutput`;

// ── Hour formatting ──

/**
 * Format an hour (0-23) as a 12-hour time string.
 * e.g. 0 → "12:00 AM", 8 → "8:00 AM", 13 → "1:00 PM"
 */
export function formatHour(hour: number): string {
  if (hour < 0 || hour > 23 || !Number.isInteger(hour)) {
    return 'Invalid';
  }
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h}:00 ${period}`;
}

/**
 * Generate hour options for dropdowns (0-23).
 */
export function getHourOptions(): { value: string; label: string }[] {
  return Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: formatHour(i),
  }));
}

// ── Validation ──

/**
 * Validate active hours configuration.
 */
export function validateActiveHours(
  start: number,
  end: number,
): string | null {
  if (start < 0 || start > 23 || end < 0 || end > 23) {
    return 'Hours must be between 0 and 23';
  }
  if (start === end) {
    return 'Start and end hours cannot be the same';
  }
  return null;
}

// ── Cron presets ──

export const HEARTBEAT_CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 30 min', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 4 hours', value: '0 */4 * * *' },
];

export const MISSION_CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily 9am', value: '0 9 * * *' },
  { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
  { label: 'Weekly Mon 9am', value: '0 9 * * 1' },
];

// ── Overdue detection ──

/**
 * Check if a heartbeat is overdue based on nextRunAt and cron expression.
 * A heartbeat is overdue if nextRunAt is in the past by more than 2x the interval.
 */
export function isOverdue(nextRunAt: Date | string, cronExpression: string): boolean {
  const next = new Date(nextRunAt);
  const now = new Date();

  if (next.getTime() > now.getTime()) return false;

  const intervalMs = estimateCronIntervalMs(cronExpression);
  const overdueThreshold = intervalMs * 2;

  return now.getTime() - next.getTime() > overdueThreshold;
}

/**
 * Estimate cron interval in milliseconds from a cron expression.
 * Handles simple common patterns; defaults to 1 hour.
 */
export function estimateCronIntervalMs(cronExpression: string): number {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) return 60 * 60 * 1000;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every N minutes: */N * * * *
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (minute.startsWith('*/')) {
      const n = parseInt(minute.slice(2), 10);
      if (!isNaN(n) && n > 0) return n * 60 * 1000;
    }
    if (minute === '*') return 60 * 1000;
  }

  // Every N hours: 0 */N * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (hour.startsWith('*/')) {
      const n = parseInt(hour.slice(2), 10);
      if (!isNaN(n) && n > 0) return n * 60 * 60 * 1000;
    }
    if (hour === '*') return 60 * 60 * 1000;
  }

  // Daily
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' &&
      !hour.includes('*') && !hour.includes('/')) {
    return 24 * 60 * 60 * 1000;
  }

  // Weekly
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
}

// ── Heartbeat status extraction ──

export interface HeartbeatStatusResult {
  lastStatus: 'ok' | 'action_taken' | 'error' | null;
  lastAt: string | null;
}

/**
 * Extract heartbeat status from a list of tasks.
 * Looks at the most recent completed task's structuredOutput.status.
 */
export function getHeartbeatStatus(tasks: Array<{
  id: string;
  createdAt: Date | string;
  status: string;
  result: any;
}>): HeartbeatStatusResult {
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    const status = task.result?.structuredOutput?.status;
    if (status === 'ok' || status === 'action_taken' || status === 'error') {
      return {
        lastStatus: status,
        lastAt: typeof task.createdAt === 'string'
          ? task.createdAt
          : task.createdAt.toISOString(),
      };
    }
  }

  return { lastStatus: null, lastAt: null };
}

// ── Mission phase detection ──

export interface MissionPhaseData {
  completedTasks: Array<{ roleSlug?: string | null; result?: Record<string, unknown> | null }>;
  activeTasks: Array<{ status: string; roleSlug?: string | null }>;
  failedTasks: Array<{ title: string }>;
  artifacts: Array<{ type: string; key?: string | null }>;
  hasWorkspace: boolean;
  prCount: number;
  priorHeartbeatStatuses: string[];
}

export type MissionPhase = 'planning' | 'needs_workspace' | 'building' | 'reviewing' | 'stalled' | 'idle';

export interface PhaseAssessment {
  phase: MissionPhase;
  reason: string;
  actions: string[];
}

/**
 * Detect the current phase of a mission based on task, artifact, and heartbeat data.
 * Pure function — no DB access. Used by the heartbeat context builder to generate
 * phase-aware guidance instead of passive status reporting.
 */
export function detectMissionPhase(data: MissionPhaseData): PhaseAssessment {
  const { completedTasks, activeTasks, failedTasks, artifacts, hasWorkspace, prCount, priorHeartbeatStatuses } = data;

  const builderCompleted = completedTasks.filter(t => t.roleSlug === 'builder');
  const activeBuilders = activeTasks.filter(t => t.roleSlug === 'builder');
  const hasBuilderWork = builderCompleted.length > 0 || activeBuilders.length > 0;

  // Plan artifacts: reports or content with plan/feature/spec/design in the key
  const hasPlanArtifacts = artifacts.some(a =>
    a.type === 'report' ||
    (a.key != null && /plan|feature|spec|design/i.test(a.key))
  );

  // 3+ consecutive "ok" heartbeats = potential stall
  const isStalled = priorHeartbeatStatuses.length >= 3 &&
    priorHeartbeatStatuses.every(s => s === 'ok');

  // Active builders → building
  if (activeBuilders.length > 0) {
    return {
      phase: 'building',
      reason: `${activeBuilders.length} builder task(s) in progress`,
      actions: [
        'Monitor builder progress',
        ...(failedTasks.length > 0 ? [`Retry ${failedTasks.length} failed task(s) with failureContext`] : []),
      ],
    };
  }

  // PRs exist → reviewing
  if (prCount > 0) {
    return {
      phase: 'reviewing',
      reason: `${prCount} PR(s) created by tasks`,
      actions: [
        'Check PR merge status',
        'Create integration task if merge conflicts exist',
        'If all PRs merged, create next batch of tasks from the plan or summarize completion',
      ],
    };
  }

  // Plan exists, no builder work → transition to building (or needs workspace first)
  if (hasPlanArtifacts && !hasBuilderWork) {
    if (!hasWorkspace) {
      return {
        phase: 'needs_workspace',
        reason: 'Plan artifact(s) delivered but mission has no workspace/repo — cannot create coding tasks.',
        actions: [
          'Create a workspace: buildd action=manage_workspaces, action=create (name + optional repoUrl)',
          'Create a GitHub repo: buildd action=manage_workspaces, action=create_repo',
          'Then create coding tasks from the plan with outputRequirement=pr_required, roleSlug=builder',
        ],
      };
    }

    return {
      phase: 'planning',
      reason: 'Plan artifact(s) delivered but no coding tasks created yet.',
      actions: [
        'Read the plan artifact(s) using buildd action=get_artifact',
        'Create concrete coding tasks: each needs outputRequirement=pr_required, roleSlug=builder, correct workspaceId',
        'Break large phases into individual tasks with clear descriptions',
        'Set task dependencies where phases must be sequential',
      ],
    };
  }

  // Builder work completed, no active builders → check next steps
  if (builderCompleted.length > 0 && activeBuilders.length === 0) {
    return {
      phase: 'reviewing',
      reason: `${builderCompleted.length} builder task(s) completed. Assess if more phases remain.`,
      actions: [
        'Review completed task results and PR statuses',
        'If more phases remain in the plan, create next batch of coding tasks',
        'If all planned work is done, create a summary artifact for human review',
      ],
    };
  }

  // Stalled: heartbeat keeps saying OK but nothing moves
  if (isStalled && completedTasks.length > 0) {
    return {
      phase: 'stalled',
      reason: 'Last 3+ heartbeats reported OK with no forward progress.',
      actions: [
        'Identify the specific blocker preventing progress',
        'If tasks only produced plans, create coding tasks (see planning phase)',
        'If waiting on a human decision, escalate clearly',
        'Do NOT report OK again without taking concrete action',
      ],
    };
  }

  // Nothing happened yet
  if (completedTasks.length === 0 && activeTasks.length === 0) {
    return {
      phase: 'idle',
      reason: 'No tasks completed or in progress yet.',
      actions: [
        'The initial planning task should be in flight or pending',
        'If no tasks exist at all, the mission may need manual intervention',
      ],
    };
  }

  // Default: work is happening
  return {
    phase: 'building',
    reason: 'Active work in progress.',
    actions: [
      'Monitor task progress',
      ...(failedTasks.length > 0 ? [`Retry ${failedTasks.length} failed task(s)`] : []),
    ],
  };
}
