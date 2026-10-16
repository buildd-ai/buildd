/**
 * The worker list `buildd top` loads at start (`GET /api/workers?view=top`).
 *
 * The plain `GET /api/workers` returns every stored worker with its full
 * public projection: output, transcript, task description and every tool
 * call's input (a Write's whole file). With a day of history that is several
 * megabytes, which top parsed only to draw a handful of rows. This view is
 * what top renders: every live worker plus the most recent finished ones, with
 * the TopWorker fields (top/state.ts) and tool-call inputs cut to the fields
 * describeToolCall and planOf read. Live workers then stream on /api/events.
 *
 * An allowlist like public-worker.ts: nothing is emitted unless named here,
 * so no credential field can reach a client through it.
 */
import type { LocalWorker } from './types';

/** Finished (done/error) workers included, newest first. */
export const TOP_RECENT_TERMINAL_WORKERS = 50;

const TOP_FIELDS = [
  'id', 'taskId', 'taskTitle', 'workspaceId', 'workspaceName', 'status', 'startedAt', 'completedAt',
  'lastActivity', 'currentAction', 'milestones', 'prUrl', 'error', 'waitingFor', 'tokenTally',
] as const;

/** The tool-call input fields top reads (describeToolCall, planOf). */
const TOOL_INPUT_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'description'] as const;
const MAX_INPUT_CHARS = 300;

function slimInput(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of TOOL_INPUT_FIELDS) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v.length > MAX_INPUT_CHARS ? v.slice(0, MAX_INPUT_CHARS) : v;
  }
  if (Array.isArray(src.todos)) {
    out.todos = src.todos
      .filter((t: any) => t && typeof t.content === 'string')
      .map((t: any) => ({ content: String(t.content).slice(0, MAX_INPUT_CHARS), status: t.status }));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type TopWorkerSummary = Record<string, unknown> & { id: string; status: string };

export function toTopWorkerSummary(worker: LocalWorker): TopWorkerSummary {
  const out: Record<string, unknown> = {};
  for (const field of TOP_FIELDS) {
    const value = (worker as any)[field];
    if (value !== undefined) out[field] = value;
  }
  if (Array.isArray(worker.toolCalls)) {
    out.toolCalls = worker.toolCalls.map((t: any) => {
      const input = slimInput(t?.input);
      return { name: t?.name, timestamp: t?.timestamp, ...(input ? { input } : {}) };
    });
  }
  return out as TopWorkerSummary;
}

const isTerminal = (w: LocalWorker) => w.status === 'done' || w.status === 'error';

export function toTopWorkerSummaries(
  workers: Iterable<LocalWorker>,
  recentTerminal = TOP_RECENT_TERMINAL_WORKERS,
): TopWorkerSummary[] {
  const all = Array.from(workers);
  const live = all.filter(w => !isTerminal(w));
  const recent = all
    .filter(isTerminal)
    .sort((a, b) => (b.completedAt ?? b.lastActivity ?? 0) - (a.completedAt ?? a.lastActivity ?? 0))
    .slice(0, Math.max(0, recentTerminal));
  return [...live, ...recent].map(toTopWorkerSummary);
}
