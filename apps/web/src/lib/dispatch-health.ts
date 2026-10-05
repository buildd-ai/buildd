/**
 * Dispatch health for a set of workspaces: the one implementation behind the
 * `dispatch_health` MCP action (GET /api/health/dispatch) and the Dispatch
 * section of /app/health. Callers resolve the team scope; this only reads.
 *
 * Postgres first. Receipts project the Worker's outcome onto each outbox row,
 * so the counts are `task_dispatch_outbox` (core dispatchTeamHealth). The one
 * Worker call is its unsigned `/health`, with a short timeout, so a Worker
 * outage shows up as a verdict and never as a slow or failed page. The last
 * floor run's reconcile counts come from `cron_runs` (job `dispatch-drain`),
 * where withCronRun stores the route's result.
 */
import { db } from '@buildd/core/db';
import { cronRuns, workspaces } from '@buildd/core/db/schema';
import { desc, eq, inArray } from 'drizzle-orm';
import { dispatchTeamHealth } from '@buildd/core/dispatch-outbox';
import {
  dispatchVerdict,
  emptyTeamHealth,
  type DispatchHealthReport,
  type DispatchReconcileCounts,
  type DispatchRepairRun,
  type DispatchTeamHealth,
  type DispatchTransportMode,
  type DispatchWorkerStatus,
} from '@buildd/core/dispatch-health-report';
import { dispatchTransportConfig, type DispatchTransportConfig } from '@/lib/dispatch-transport';

/** The `/health` probe. Short: a page render waits on it. */
export const WORKER_PROBE_TIMEOUT_MS = 1_500;
/** The floor's cron job name (app/api/cron/dispatch-drain, the hourly tick). */
export const FLOOR_JOB = 'dispatch-drain';

export async function probeDispatchWorker(opts: {
  config?: DispatchTransportConfig | null;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
} = {}): Promise<DispatchWorkerStatus> {
  const config = opts.config === undefined ? dispatchTransportConfig() : opts.config;
  if (!config) return { status: 'unconfigured' };
  const fetchFn = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const started = Date.now();
  try {
    const res = await fetchFn(`${config.url}/health`, { method: 'GET', signal: AbortSignal.timeout(opts.timeoutMs ?? WORKER_PROBE_TIMEOUT_MS) });
    if (!res.ok) return { status: 'unreachable', error: `http_${res.status}` };
    const body = await res.json().catch(() => null) as { ok?: unknown; configured?: unknown } | null;
    if (!body || body.ok !== true) return { status: 'unreachable', error: 'bad_response' };
    return { status: 'reachable', workerConfigured: body.configured !== false, ms: Date.now() - started };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { status: 'unreachable', error: 'timeout' };
    return { status: 'unreachable', error: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
  }
}

const COUNT_KEYS = ['checked', 'republished', 'projected', 'fellBack', 'left', 'workerErrors'] as const;

/** A `cron_runs` row of the floor → its reconcile counts, or why there are none. */
export function parseRepairRun(row: { startedAt: Date | string; ok: boolean; result: unknown } | null | undefined): DispatchRepairRun | null {
  if (!row) return null;
  const at = row.startedAt instanceof Date ? row.startedAt.toISOString() : new Date(row.startedAt).toISOString();
  const reconciled = (row.result as { repair?: { reconciled?: unknown } } | null)?.repair?.reconciled;
  let reconcile: DispatchReconcileCounts | null = null;
  let reconcileError: string | null = null;
  if (reconciled && typeof reconciled === 'object') {
    const r = reconciled as Record<string, unknown>;
    if (typeof r.error === 'string') reconcileError = r.error.slice(0, 200);
    else if (COUNT_KEYS.every(k => typeof r[k] === 'number')) {
      reconcile = Object.fromEntries(COUNT_KEYS.map(k => [k, r[k] as number])) as unknown as DispatchReconcileCounts;
    }
  }
  return { at, ok: row.ok, reconcile, reconcileError };
}

async function loadLastRepair(): Promise<DispatchRepairRun | null> {
  const row = await db.query.cronRuns.findFirst({
    where: eq(cronRuns.job, FLOOR_JOB),
    columns: { startedAt: true, ok: true, result: true },
    orderBy: desc(cronRuns.startedAt),
  });
  return parseRepairRun(row ?? null);
}

async function loadWorkspaces(ids: readonly string[]): Promise<Array<{ id: string; name: string; transport: DispatchTransportMode }>> {
  const rows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, [...ids]),
    columns: { id: true, name: true, dispatchTransport: true },
  });
  return rows
    .map(r => ({ id: r.id, name: r.name, transport: r.dispatchTransport }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface DispatchHealthDeps {
  teamHealth: (ids: readonly string[]) => Promise<DispatchTeamHealth>;
  loadWorkspaces: typeof loadWorkspaces;
  loadLastRepair: () => Promise<DispatchRepairRun | null>;
  probeWorker: () => Promise<DispatchWorkerStatus>;
  now: () => number;
}

const DEFAULT_DEPS: DispatchHealthDeps = {
  teamHealth: dispatchTeamHealth,
  loadWorkspaces,
  loadLastRepair,
  probeWorker: () => probeDispatchWorker(),
  now: () => Date.now(),
};

/** `workspaceIds` must already be the caller's own (team-scoped) workspaces. */
export async function getDispatchHealth(workspaceIds: readonly string[], over: Partial<DispatchHealthDeps> = {}): Promise<DispatchHealthReport> {
  const d = { ...DEFAULT_DEPS, ...over };
  const now = d.now();
  const empty = workspaceIds.length === 0;
  const [outbox, wsRows, lastRepair, worker] = await Promise.all([
    empty ? Promise.resolve(null) : d.teamHealth(workspaceIds),
    empty ? Promise.resolve([]) : d.loadWorkspaces(workspaceIds),
    d.loadLastRepair().catch(() => null),
    empty ? Promise.resolve<DispatchWorkerStatus>({ status: 'unconfigured' }) : d.probeWorker(),
  ]);
  const input = {
    outbox: outbox ?? emptyTeamHealth(),
    workspaces: wsRows,
    worker,
    lastRepair,
  };
  return { generatedAt: new Date(now).toISOString(), ...input, ...dispatchVerdict(input, now) };
}
