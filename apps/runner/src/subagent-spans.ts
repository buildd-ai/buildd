import type { SubagentTask } from './types';

/** Persisted record for a single subagent span (stored as JSONB on workers table). */
export interface SubagentSpanRecord {
  taskId: string;
  toolUseId: string;
  agentId?: string;
  parentAgentId?: string;
  description: string;
  taskType: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed';
  isBackground: boolean;
  durationMs?: number;
  toolCount?: number;
  cumulativeUsage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

/**
 * Map in-memory SubagentTask[] to persisted SubagentSpanRecord[].
 * Called once at worker terminal state — not on the hot path.
 * Spans still running at termination persist with status='running' and no completedAt.
 * Accepts undefined defensively (disk-restored workers or test fixtures may omit the field).
 */
export function buildSubagentSpans(tasks: SubagentTask[] | undefined | null): SubagentSpanRecord[] {
  if (!tasks) return [];
  return tasks.map(t => {
    const span: SubagentSpanRecord = {
      taskId: t.taskId,
      toolUseId: t.toolUseId,
      description: t.description.slice(0, 200),
      taskType: t.taskType,
      startedAt: t.startedAt,
      status: t.status,
      isBackground: t.isBackground ?? false,
    };
    if (t.agentId) span.agentId = t.agentId;
    if (t.parentAgentId) span.parentAgentId = t.parentAgentId;
    if (t.completedAt !== undefined) span.completedAt = t.completedAt;
    if (t.progress?.durationMs !== undefined) span.durationMs = t.progress.durationMs;
    if (t.progress?.toolCount !== undefined) span.toolCount = t.progress.toolCount;
    if (t.progress?.cumulativeUsage) span.cumulativeUsage = t.progress.cumulativeUsage;
    return span;
  });
}

/**
 * Sum durationMs for background-only spans.
 * Foreground spans are excluded — their time is already inside the parent worker's wall clock.
 * Background spans run concurrently so their labor is otherwise invisible in the wall clock sum.
 */
export function computeBackgroundAgentMs(spans: SubagentSpanRecord[] | undefined | null): number {
  if (!spans) return 0;
  return spans
    .filter(s => s.isBackground && s.durationMs !== undefined)
    .reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
}
