/**
 * Container reuse: hand a warm container to the next task of the same
 * workspace and size class (a reviewer right after its builder), instead of
 * paying a fresh container, snapshot restore and dependency cache again.
 *
 * A Cloudflare container belongs to one Durable Object, so reuse means
 * dispatching the next task INTO the agent that holds the warm container.
 * Those agents are named by a lease, not by a task:
 *
 *     lease:<size>:<workspaceId>:<slot>      slot 0..CONTAINER_REUSE_SLOTS-1
 *
 * in the same agent class as the size (WorkerAgent / WorkerAgentLarge), so a
 * lease never crosses a workspace or a size class. Each task keeps its own
 * agent (named by the task ID) as before; when reuse is on, that agent is the
 * router for its own task: it asks the workspace's leases, a warm one first,
 * then any idle one, and records which lease runs the task (`leasedTo`), so
 * GET, kill and resume still reach the task by its ID. When every slot is busy
 * the task runs in its own agent exactly as without reuse (fresh container,
 * destroyed at the end). Either way one container runs at most one task at a
 * time, and the leases are a subset of the class's max_instances.
 *
 * A lease agent keeps its container after a run that ended `done` or
 * `failed`, for CONTAINER_REUSE_WINDOW_MS (default 5 minutes), then destroys
 * it. Never after a park (the parked state waits for its own resume), a crash,
 * or anything else. The next task starts with a reset in the container
 * (apps/runner/src/container-reset.ts); a reset that does not verify clean
 * destroys the container and starts a fresh one. It never runs dirty.
 *
 * The workspace a lease is keyed by comes from buildd's runner-size answer
 * (authenticated with the runner key and the dispatch token), never from the
 * webhook body or the container.
 *
 * Off unless CONTAINER_REUSE=1. Runtime-free; Bun tests cover it.
 */
import type { DispatchRequest, RunState } from './lifecycle';
import { isRunnerSize, type RunnerSize } from './runner-class';

export const DEFAULT_REUSE_WINDOW_MS = 5 * 60 * 1000;
const MIN_REUSE_WINDOW_MS = 30 * 1000;
const MAX_REUSE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_REUSE_SLOTS = 2;
/**
 * Mirrors max_instances in wrangler.jsonc. Slots never exceed it: a lease
 * holding a warm container counts against the class's ceiling like any other
 * container, and a start the platform refuses goes through the capacity-retry
 * path (supervisor.ts start_deferred) as before.
 */
export const MAX_INSTANCES: Record<RunnerSize, number> = { standard: 10, large: 4 };

export interface ReuseEnv {
  CONTAINER_REUSE?: string;
  CONTAINER_REUSE_WINDOW_MS?: string;
  CONTAINER_REUSE_SLOTS?: string;
}

export function containerReuseEnabled(env: ReuseEnv): boolean {
  return env.CONTAINER_REUSE === '1';
}

export function resolveReuseWindowMs(env: ReuseEnv): number {
  const n = Number(env.CONTAINER_REUSE_WINDOW_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REUSE_WINDOW_MS;
  return Math.min(MAX_REUSE_WINDOW_MS, Math.max(MIN_REUSE_WINDOW_MS, Math.floor(n)));
}

export function resolveReuseSlots(env: ReuseEnv, size: RunnerSize): number {
  const n = Number(env.CONTAINER_REUSE_SLOTS);
  const slots = Number.isInteger(n) && n > 0 ? n : DEFAULT_REUSE_SLOTS;
  return Math.min(slots, MAX_INSTANCES[size]);
}

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LEASE_NAME_RE = /^lease:(standard|large):([A-Za-z0-9][A-Za-z0-9_-]{0,127}):(\d{1,2})$/;

export function isValidWorkspaceId(v: unknown): v is string {
  return typeof v === 'string' && WORKSPACE_ID_RE.test(v);
}

export function leaseName(workspaceId: string, size: RunnerSize, slot: number): string {
  if (!isValidWorkspaceId(workspaceId)) throw new Error('lease needs a workspace id');
  return `lease:${size}:${workspaceId}:${slot}`;
}

export interface LeaseKey {
  size: RunnerSize;
  workspaceId: string;
  slot: number;
}

/** A lease agent's name, or null for a task agent (named by its task ID). */
export function parseLeaseName(name: string): LeaseKey | null {
  const m = LEASE_NAME_RE.exec(name);
  if (!m || !isRunnerSize(m[1])) return null;
  return { size: m[1], workspaceId: m[2]!, slot: Number(m[3]) };
}

/** A container a lease kept after its last run, for the next task. */
export interface WarmContainer {
  workspaceId: string;
  size: RunnerSize;
  /** The task whose run it last held. */
  fromTaskId: string;
  /** When that run ended (agent clock). */
  since: number;
  /**
   * What that run spent getting its container ready (container start,
   * warm restore, cache restore, clone): what the next task does not pay.
   * An estimate from the previous run's report; null when it measured none.
   */
  savedRestoreMs: number | null;
}

/** On the run report: this attempt ran in a container another run left warm. */
export type ReusedContainer =
  | { fromTaskId: string; idleMs: number; savedRestoreMs: number | null }
  | { fromTaskId: string; idleMs: number; savedRestoreMs: null; fallback: 'reset_failed' };

export type LeaseClaimDecision =
  | { claim: 'warm'; warm: WarmContainer }
  | { claim: 'cold' }
  | { claim: 'busy'; reason: 'live' | 'parked' | 'scheduled' | 'wrong_lease' };

/**
 * Whether a lease agent can take `taskId` now, and how. Busy while a run is
 * live, while it holds a parked run (its resume must find it), while it has
 * a scheduled wake pending (a deferred retry of its task). Warm only for the same workspace and size, inside
 * the window, with the container still up.
 */
export function decideLeaseClaim(
  state: RunState,
  a: { key: LeaseKey; workspaceId: string; size: RunnerSize; now: number; windowMs: number; containerRunning: boolean },
): LeaseClaimDecision {
  if (a.key.workspaceId !== a.workspaceId || a.key.size !== a.size) return { claim: 'busy', reason: 'wrong_lease' };
  if (state.status === 'starting' || state.status === 'running') return { claim: 'busy', reason: 'live' };
  if (state.status === 'exited' && state.outcome === 'parked') return { claim: 'busy', reason: 'parked' };
  if (state.scheduleId) return { claim: 'busy', reason: 'scheduled' };
  const w = state.warm;
  if (w && a.containerRunning && w.workspaceId === a.workspaceId && w.size === a.size && a.now - w.since <= a.windowMs) {
    return { claim: 'warm', warm: w };
  }
  return { claim: 'cold' };
}

/** Whether a run that just ended leaves its container for the next task. */
export function keepsContainerWarm(outcome: RunState['outcome'] | undefined): boolean {
  return outcome === 'done' || outcome === 'failed';
}

/** See WarmContainer.savedRestoreMs. */
export function savedRestoreMsOf(report: { durationsMs?: Partial<Record<string, number | null>> } | undefined): number | null {
  const d = report?.durationsMs;
  if (!d) return null;
  const parts = [d.containerStart, d.restoreWarm, d.restoreCache, d.clone].filter((v): v is number => typeof v === 'number' && v >= 0);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Sent to a lease agent. `taskId` and `workspaceId` are the router's, from buildd. */
export interface LeasedDispatchRequest extends DispatchRequest {
  taskId: string;
  workspaceId: string;
  /** First pass: take the lease only if its container is warm. */
  warmOnly?: boolean;
}

export type LeasedDispatchResult =
  | { accepted: true; attempt: number; reused: boolean }
  | { accepted: false; reason: 'already_live' | 'not_parked' | 'busy' | 'not_warm'; attempt: number; status: RunState['status'] };

export interface LeaseHandle {
  dispatchLeased(request: LeasedDispatchRequest): Promise<LeasedDispatchResult>;
}

/**
 * Find a lease for the task: every slot's warm container first, then any idle
 * slot. Null when none takes it; the caller then runs the task in its own
 * agent. Never throws: a lease that cannot be reached is skipped.
 */
export async function routeToLease(
  d: { getLease(name: string): Promise<LeaseHandle>; log(message: string): void },
  a: { taskId: string; workspaceId: string; size: RunnerSize; slots: number; request: DispatchRequest },
): Promise<{ lease: string; result: LeasedDispatchResult & { accepted: true } } | null> {
  for (const warmOnly of [true, false]) {
    for (let slot = 0; slot < a.slots; slot++) {
      const name = leaseName(a.workspaceId, a.size, slot);
      try {
        const lease = await d.getLease(name);
        const result = await lease.dispatchLeased({ ...a.request, taskId: a.taskId, workspaceId: a.workspaceId, ...(warmOnly ? { warmOnly } : {}) });
        if (result.accepted) return { lease: name, result };
      } catch (err) {
        d.log(`[cloud-runner] task ${a.taskId}: lease ${name} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}

/**
 * What GET /tasks/:id shows for a task that ran on a lease: the lease's state
 * while the lease still has the task (without the lease's warm container or
 * other tasks' reports), else the task's last report from the lease's history.
 */
export function taskStateOnLease(taskId: string, leasedTo: string, lease: RunState, own: RunState): RunState {
  if (lease.taskId === taskId) {
    const { warm: _warm, reportHistory, ...rest } = lease;
    const mine = reportHistory?.filter(r => r.taskId === taskId);
    return { ...rest, ...(mine?.length ? { reportHistory: mine } : {}), leasedTo };
  }
  const report = [lease.report, ...[...(lease.reportHistory ?? [])].reverse()].find(r => r?.taskId === taskId);
  return {
    taskId,
    attempt: report?.attempt ?? own.attempt,
    status: report ? 'exited' : own.status,
    ...(report ? { report, ...(report.outcome ? { outcome: report.outcome } : {}), ...(report.workerId ? { workerId: report.workerId } : {}) } : {}),
    leasedTo,
  };
}
