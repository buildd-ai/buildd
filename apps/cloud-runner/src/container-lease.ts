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
 * destroys the container and starts a fresh one. It never runs dirty. After
 * the reset the next task grows its clone from the packs the reset kept and
 * keeps the dependency cache on disk: no snapshot or cache restore.
 *
 * The container is free the moment its run ends: a lease run defers its warm
 * snapshot upload (the kept container IS the warm state) to when the lease
 * lets the container go at the end of the window, and skips it when the next
 * task takes the container over (its reset wipes the record).
 *
 * The next task is often dispatched the moment buildd sees the previous one
 * complete, while that run is still in its tail (the runner's last reports
 * and exit; BUILDD_PHASE=run_end marks it). Such a lease answers `tail`, and
 * the router waits for it to go warm, at most LEASE_TAIL_WAIT_MS, before it
 * takes an idle slot or runs the task in its own agent: a fresh container
 * costs this workspace far more than the wait. The wait is not made on
 * buildd's webhook (it must be answered fast; worker-agent.ts accepts the
 * dispatch first and routes it in the background).
 *
 * What reuse saved is measured, not estimated: a reused run's own prep time
 * (prepMsOf) against the prep time of the fresh run that started the
 * container (the workspace's fresh-container baseline). Negative when the
 * reuse cost time.
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
/** How long a dispatch waits for a lease in its tail to go warm. */
export const LEASE_TAIL_WAIT_MS = 30 * 1000;
export const LEASE_TAIL_POLL_MS = 2 * 1000;
/** How long the deferred warm upload may run before the container is destroyed anyway. */
export const WARM_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface ReuseEnv {
  CONTAINER_REUSE?: string;
  CONTAINER_REUSE_WINDOW_MS?: string;
  CONTAINER_REUSE_SLOTS?: string;
}

export function containerReuseEnabled(env: ReuseEnv, mode: unknown = 'off'): boolean {
  return env.CONTAINER_REUSE === '1' && (mode === 'repo' || mode === 'deps');
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
   * prepMsOf the fresh run that started this container (carried unchanged
   * through every reuse): what a fresh container costs this workspace. Null
   * when that run did not measure it.
   */
  baselinePrepMs: number | null;
  /** That run deferred its warm snapshot upload: made at expiry, skipped on a handover. */
  uploadPending?: boolean;
  depsDigest?: string;
}

/**
 * On the run report: this attempt ran in a container another run left warm.
 * `resetMs`: the reset, as the agent timed it. `prepMs`: this run's own
 * prepMsOf. `savedMs` = baselinePrepMs - prepMs, negative when reuse was
 * slower than a fresh container; null when either side is unmeasured.
 * `prepMs` and `savedMs` are filled in when the report is assembled.
 */
export type ReusedContainer =
  | { fromTaskId: string; idleMs: number; baselinePrepMs: number | null; resetMs?: number | null; prepMs?: number | null; savedMs?: number | null; uploadSkipped?: boolean; depsDigest?: string }
  | { fromTaskId: string; idleMs: number; fallback: 'reset_failed'; resetMs?: number | null };

export type LeaseClaimDecision =
  | { claim: 'warm'; warm: WarmContainer }
  | { claim: 'cold' }
  | { claim: 'busy'; reason: 'live' | 'tail' | 'uploading' | 'parked' | 'scheduled' | 'wrong_lease' };

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
  // Outcome known, only the runner's tail left: warm (or not) in moments.
  if (state.status === 'running' && typeof state.timings?.runnerPhases?.run_end === 'number') return { claim: 'busy', reason: 'tail' };
  if (state.status === 'starting' || state.status === 'running') return { claim: 'busy', reason: 'live' };
  // The deferred upload before the container goes; one stuck past its
  // timeout (the agent restarted under it) no longer holds the lease.
  if (state.warmUploadSince !== undefined && a.now - state.warmUploadSince < WARM_UPLOAD_TIMEOUT_MS) return { claim: 'busy', reason: 'uploading' };
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

/**
 * What a run spent before its repo was ready: any wait for a lease in its
 * tail, then dispatch to claim (container start, or the reset of a reused
 * one, then the runner's start and claim). The repo steps (clone; warm
 * restore, its cache restore and fetch; or the seed from kept packs) are
 * inside the claim: the runner resolves the workspace, and so gets its repo
 * onto the disk, before it prints the claim line. They are not added again.
 * Null when dispatch to claim was not measured: without it two runs are not
 * comparable.
 */
export function prepMsOf(durationsMs: Partial<Record<string, number | null>> | undefined): number | null {
  const d = durationsMs;
  if (!d || typeof d.containerStart !== 'number' || typeof d.toClaim !== 'number') return null;
  return (typeof d.leaseWait === 'number' && d.leaseWait > 0 ? d.leaseWait : 0) + d.containerStart + d.toClaim;
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
  | { accepted: false; reason: 'already_live' | 'not_parked' | 'busy' | 'tail' | 'not_warm'; attempt: number; status: RunState['status'] };

export interface LeaseHandle {
  dispatchLeased(request: LeasedDispatchRequest): Promise<LeasedDispatchResult>;
}

export type Routed = { lease: string; result: LeasedDispatchResult & { accepted: true } };

interface RouteDeps { getLease(name: string): Promise<LeaseHandle>; log(message: string): void }
interface RouteArgs { taskId: string; workspaceId: string; size: RunnerSize; slots: number; request: DispatchRequest }

async function offer(d: RouteDeps, a: RouteArgs, name: string, warmOnly: boolean): Promise<LeasedDispatchResult | null> {
  try {
    const lease = await d.getLease(name);
    return await lease.dispatchLeased({ ...a.request, taskId: a.taskId, workspaceId: a.workspaceId, ...(warmOnly ? { warmOnly } : {}) });
  } catch (err) {
    d.log(`[cloud-runner] task ${a.taskId}: lease ${name} unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Find a lease for the task: every slot's warm container first, then (unless
 * `warmOnly`) any idle slot. Else `lease` null, with the slots that answered
 * `tail` (worth waiting for: waitForTailLease); the caller then runs the task
 * in its own agent. Never throws: a lease that cannot be reached is skipped.
 */
export async function routeToLease(d: RouteDeps, a: RouteArgs & { warmOnly?: boolean }): Promise<Routed | { lease: null; tails: string[] }> {
  const tails: string[] = [];
  for (const warmOnly of a.warmOnly ? [true] : [true, false]) {
    for (let slot = 0; slot < a.slots; slot++) {
      const name = leaseName(a.workspaceId, a.size, slot);
      const result = await offer(d, a, name, warmOnly);
      if (result?.accepted) return { lease: name, result };
      if (warmOnly && result?.reason === 'tail') tails.push(name);
    }
  }
  return { lease: null, tails };
}

/**
 * Wait, at most `maxWaitMs` from `since`, for one of the leases in their tail to go warm,
 * and take it. A lease that leaves its tail without going warm (a park, a
 * crash, another task took it) is dropped at once; null when none is left
 * or the time is up.
 */
export async function waitForTailLease(
  d: RouteDeps & { sleep(ms: number): Promise<void>; now(): number },
  a: RouteArgs & { tails: string[]; maxWaitMs?: number; pollMs?: number; since?: number },
): Promise<Routed | null> {
  const since = a.since ?? d.now();
  const deadline = since + (a.maxWaitMs ?? LEASE_TAIL_WAIT_MS);
  let tails = [...a.tails];
  while (tails.length && d.now() < deadline) {
    await d.sleep(Math.min(a.pollMs ?? LEASE_TAIL_POLL_MS, Math.max(0, deadline - d.now())));
    const still: string[] = [];
    for (const name of tails) {
      // The run report's durationsMs.leaseWait: the wait until this offer.
      const result = await offer(d, { ...a, request: { ...a.request, leaseWaitMs: d.now() - since } }, name, true);
      if (result?.accepted) return { lease: name, result };
      if (result?.reason === 'tail') still.push(name);
    }
    tails = still;
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
