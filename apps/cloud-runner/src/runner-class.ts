/**
 * Two container classes on one Worker. Cloudflare fixes the instance type per
 * container class, and a container class is bound to one Durable Object class,
 * so each size is its own agent class (worker-agent.ts): `WorkerAgent` on
 * standard-1 and `WorkerAgentLarge` on standard-3, each with its own
 * max_instances in wrangler.jsonc.
 *
 * Which one a task gets is buildd's decision, never the container's: at
 * dispatch the Worker asks POST /api/runner/runner-size with the runner key
 * and the dispatch token (the container holds neither), the same two
 * credentials as the GitHub grant. Anything short of a clean answer falls back
 * to standard, the class every task ran in before there were two.
 *
 * Runtime-free; Bun tests cover it (runner-class.test.ts).
 */
import { DISPATCH_TOKEN_HEADER } from './outbound';

export const RUNNER_SIZES = ['standard', 'large'] as const;
export type RunnerSize = typeof RUNNER_SIZES[number];

/**
 * Where the size came from. buildd answers explicit / derived / default, or
 * pinned (a resume goes back to its parked attempt's class); `fallback` is the
 * Worker's own: buildd did not answer.
 */
export const RUNNER_SIZE_SOURCES = ['explicit', 'derived', 'default', 'pinned', 'fallback'] as const;
export type RunnerSizeSource = typeof RUNNER_SIZE_SOURCES[number];

/** Mirrors RUNNER_SIZE_REASONS in packages/shared/src/runner-size.ts (a test keeps them equal). */
export const RUNNER_SIZE_REASONS = ['memory_pressure', 'low_disk', 'container_restart', 'large_checkout'] as const;
export type RunnerSizeReason = typeof RUNNER_SIZE_REASONS[number];

export interface RunnerSizeDecision {
  size: RunnerSize;
  source: RunnerSizeSource;
  reason: RunnerSizeReason | null;
  /**
   * The task's workspace, as buildd answered it (authenticated with the runner
   * key and dispatch token). Only on a fresh answer: never stored, never in a
   * report (normalizeRunnerSizeDecision drops it). Keys container reuse.
   */
  workspaceId?: string;
}

/**
 * Per class: the Durable Object binding (and class) name, the default
 * instance type (must equal wrangler.jsonc; run-report.test.ts checks), and
 * the fair-use weight of one runner-second (packages/shared RUNNER_SIZE_WEIGHT).
 */
export const RUNNER_CLASSES = {
  standard: { binding: 'WorkerAgent', instanceType: 'standard-1', weight: 1 },
  large: { binding: 'WorkerAgentLarge', instanceType: 'standard-3', weight: 2 },
} as const satisfies Record<RunnerSize, { binding: string; instanceType: string; weight: number }>;

export const FALLBACK_DECISION: RunnerSizeDecision = { size: 'standard', source: 'fallback', reason: null };

export function isRunnerSize(v: unknown): v is RunnerSize {
  return typeof v === 'string' && (RUNNER_SIZES as readonly string[]).includes(v);
}

/** A decision from anywhere (buildd's body, stored state, an RPC argument), or null. */
export function normalizeRunnerSizeDecision(v: unknown): RunnerSizeDecision | null {
  const d = v as { size?: unknown; source?: unknown; reason?: unknown } | null | undefined;
  if (!d || !isRunnerSize(d.size)) return null;
  const source = (RUNNER_SIZE_SOURCES as readonly string[]).includes(d.source as string) ? d.source as RunnerSizeSource : 'fallback';
  const reason = (RUNNER_SIZE_REASONS as readonly string[]).includes(d.reason as string) ? d.reason as RunnerSizeReason : null;
  return { size: d.size, source, reason };
}

export const RUNNER_SIZE_PATH = '/api/runner/runner-size';

export function runnerSizeRequest(cfg: {
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  DISPATCH_TOKEN?: string;
}, taskId: string, workerId?: string): { url: string; init: RequestInit } {
  if (!cfg.BUILDD_SERVER || !cfg.BUILDD_API_KEY || !cfg.DISPATCH_TOKEN) {
    throw new Error('BUILDD_SERVER, BUILDD_API_KEY and DISPATCH_TOKEN are needed to ask for a runner size');
  }
  return {
    url: `${cfg.BUILDD_SERVER.replace(/\/+$/, '')}${RUNNER_SIZE_PATH}`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.BUILDD_API_KEY}`,
        [DISPATCH_TOKEN_HEADER]: cfg.DISPATCH_TOKEN,
      },
      body: JSON.stringify(workerId ? { taskId, workerId } : { taskId }),
    },
  };
}

/** buildd's answer, or null when it is not one (wrong task, unknown size). */
export function parseRunnerSizeResponse(body: unknown, taskId: string): RunnerSizeDecision | null {
  const b = (body ?? {}) as { taskId?: unknown; workspaceId?: unknown; runnerSize?: unknown; source?: unknown; reason?: unknown };
  if (b.taskId !== taskId) return null;
  const decision = normalizeRunnerSizeDecision({ size: b.runnerSize, source: b.source, reason: b.reason });
  if (!decision) return null;
  return typeof b.workspaceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(b.workspaceId) ? { ...decision, workspaceId: b.workspaceId } : decision;
}

const RUNNER_SIZE_TIMEOUT_MS = 5_000;

/**
 * Ask buildd which class this task's container goes in. Never throws: an
 * older buildd (404), a refusal, a timeout or a malformed answer is standard,
 * with `source: 'fallback'` so the run report shows it was not buildd's call.
 */
export async function fetchRunnerSize(
  deps: { fetch: typeof fetch; log(message: string): void; timeoutMs?: number },
  cfg: { BUILDD_SERVER?: string; BUILDD_API_KEY?: string; DISPATCH_TOKEN?: string },
  taskId: string,
  workerId?: string,
): Promise<RunnerSizeDecision> {
  try {
    const { url, init } = runnerSizeRequest(cfg, taskId, workerId);
    const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? RUNNER_SIZE_TIMEOUT_MS) });
    if (!res.ok) {
      deps.log(`[cloud-runner] task ${taskId}: runner size lookup returned ${res.status}; using standard`);
      return FALLBACK_DECISION;
    }
    const decision = parseRunnerSizeResponse(await res.json(), taskId);
    if (!decision) {
      deps.log(`[cloud-runner] task ${taskId}: runner size answer was not usable; using standard`);
      return FALLBACK_DECISION;
    }
    return decision;
  } catch (err) {
    deps.log(`[cloud-runner] task ${taskId}: runner size lookup failed: ${err instanceof Error ? err.message : String(err)}; using standard`);
    return FALLBACK_DECISION;
  }
}

/**
 * The instance type a class runs on, for the run report: the class's var
 * (CONTAINER_INSTANCE_TYPE / CONTAINER_INSTANCE_TYPE_LARGE, mirroring
 * wrangler.jsonc, since it is not readable at runtime), else the default.
 */
export function instanceTypeFor(size: RunnerSize, env: { CONTAINER_INSTANCE_TYPE?: string; CONTAINER_INSTANCE_TYPE_LARGE?: string }): string {
  const fromEnv = size === 'large' ? env.CONTAINER_INSTANCE_TYPE_LARGE : env.CONTAINER_INSTANCE_TYPE;
  return fromEnv || RUNNER_CLASSES[size].instanceType;
}

/**
 * Billable runner-seconds of one attempt (container running to exit, rounded
 * up) and the same weighted by class, for hosted fair use later. Null when
 * either end is missing (the container never ran).
 */
export function runnerSeconds(size: RunnerSize, from: number | null, to: number | null): { seconds: number; weighted: number } | null {
  if (from === null || to === null || to < from) return null;
  const seconds = Math.ceil((to - from) / 1000);
  return { seconds, weighted: seconds * RUNNER_CLASSES[size].weight };
}
