/**
 * The worker list `buildd top` loads at start (`GET /api/workers?view=top`).
 *
 * The plain `GET /api/workers` returns every stored worker with its full
 * public projection: output, transcript, task description and every tool
 * call's input (a Write's whole file). With a day of history that is several
 * megabytes, which top parsed only to draw a handful of rows. This view is
 * what top renders: every live worker plus the finished ones top can show
 * (everything that finished today, and at least the most recent few), with
 * the TopWorker fields (top/state.ts) and tool-call inputs cut to the fields
 * describeToolCall and planOf read. Live workers then stream on /api/events.
 *
 * An allowlist like public-worker.ts: nothing is emitted unless named here,
 * so no credential field can reach a client through it.
 */
import type { LocalWorker } from './types';
import { workerSpend } from './run-route';

/** Finished (done/error) workers always included, newest first, whatever day they ended. */
export const TOP_RECENT_TERMINAL_WORKERS = 50;
/**
 * Most finished workers included at all. Everything that ended today is
 * included up to this, so top's DONE TODAY is complete on a heavy day; the
 * ceiling only keeps the payload bounded.
 */
export const TOP_MAX_TERMINAL_WORKERS = 1000;

const TOP_FIELDS = [
  'id', 'taskId', 'taskTitle', 'workspaceId', 'workspaceName', 'status', 'startedAt', 'completedAt',
  'lastActivity', 'currentAction', 'milestones', 'prUrl', 'error', 'waitingFor', 'tokenTally',
  // Which route the run used (run-route.ts), and the model it asked for.
  'route', 'costBasis', 'taskBackend', 'sessionModel',
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
  // The run's dollars, worked out here so top need not carry the result's
  // per-model usage; and the model the route served, for the detail (R-40).
  const spend = workerSpend(worker);
  if (spend) out.spend = spend;
  if (worker.resultMeta?.actualModel) out.resultMeta = { actualModel: worker.resultMeta.actualModel };
  if (Array.isArray(worker.toolCalls)) {
    out.toolCalls = worker.toolCalls.map((t: any) => {
      const input = slimInput(t?.input);
      return { name: t?.name, timestamp: t?.timestamp, ...(input ? { input } : {}) };
    });
  }
  return out as TopWorkerSummary;
}

const isTerminal = (w: LocalWorker) => w.status === 'done' || w.status === 'error';

const endedAt = (w: LocalWorker) => w.completedAt ?? w.lastActivity ?? 0;

/** Local midnight at the start of `now`'s day: the boundary top's DONE TODAY uses. */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function toTopWorkerSummaries(
  workers: Iterable<LocalWorker>,
  opts: { now?: number; minRecent?: number; max?: number } = {},
): TopWorkerSummary[] {
  const minRecent = Math.max(0, opts.minRecent ?? TOP_RECENT_TERMINAL_WORKERS);
  const max = Math.max(minRecent, opts.max ?? TOP_MAX_TERMINAL_WORKERS);
  const today = startOfLocalDay(opts.now ?? Date.now());
  const all = Array.from(workers);
  const live = all.filter(w => !isTerminal(w));
  const finished = all.filter(isTerminal).sort((a, b) => endedAt(b) - endedAt(a));
  // Newest first: the first few whatever their day, then everything that ended today.
  let n = 0;
  while (n < finished.length && n < max && (n < minRecent || endedAt(finished[n]) >= today)) n++;
  return [...live, ...finished.slice(0, n)].map(toTopWorkerSummary);
}
