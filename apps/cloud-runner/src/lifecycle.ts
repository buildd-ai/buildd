/**
 * Pure decisions for one task's run. No Workers runtime imports, so Bun tests
 * load this file directly. The WorkerAgent (worker-agent.ts) and the
 * supervisor (supervisor.ts) act on what these functions return.
 *
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 3.
 */

// ── Exit codes ────────────────────────────────────────────────────────────────
// Mirrors apps/runner/src/run-once.ts. Not imported from there: that module
// lazily imports the whole runner, which must not end up in the Worker bundle.
// lifecycle.test.ts asserts the two stay equal.

export const EXIT_COMPLETED = 0;
export const EXIT_FAILED = 1;
export const EXIT_CLAIM_REFUSED = 3;
export const EXIT_USAGE = 64;

/** Same prefix run-once prints once the worker exists (`WORKER_ID_LINE_PREFIX`). */
export const WORKER_ID_LINE_PREFIX = 'BUILDD_WORKER_ID=';

// ── State ─────────────────────────────────────────────────────────────────────

import type { RunTimings, StoredRunReport } from './run-report';

export type RunStatus = 'idle' | 'starting' | 'running' | 'exited';

/**
 * - done / failed / refused / usage: the runner exited with a code it chose,
 *   so it already reported whatever there was to report.
 * - crashed: anything else (killed, OOM, container gone, agent restarted
 *   mid-run). The runner probably could not report.
 */
export type RunOutcome = 'done' | 'failed' | 'refused' | 'usage' | 'crashed';

/** What happened to the best-effort "mark the worker failed" call after a crash. */
export type CrashReport = 'sent' | 'rejected' | 'error' | 'no_worker_id';

export interface RunState {
  taskId: string | null;
  /** 1 for the first run of this task, +1 for each later dispatch after an exit. */
  attempt: number;
  status: RunStatus;
  exitCode?: number | null;
  outcome?: RunOutcome;
  startedAt?: number;
  endedAt?: number;
  /** From the runner's `BUILDD_WORKER_ID=` line; only known once the claim succeeded. */
  workerId?: string;
  /** Why a run ended as `crashed`, when there is more to say than the code. */
  error?: string;
  crashReport?: CrashReport;
  /** Last few lines of runner output, for `GET /tasks/:id`. */
  outputTail?: string[];
  /** Phase timestamps gathered while the run is live (run-report.ts). */
  timings?: RunTimings;
  /** This attempt's run report, once it exited, with what happened to its delivery. */
  report?: StoredRunReport;
  /** Earlier attempts' reports, oldest first, at most REPORT_HISTORY_MAX. */
  reportHistory?: StoredRunReport[];
}

export const INITIAL_STATE: RunState = { taskId: null, attempt: 0, status: 'idle' };

// ── Decisions ─────────────────────────────────────────────────────────────────

export type DispatchDecision =
  | { action: 'start'; attempt: number }
  | { action: 'ignore'; reason: 'already_live' };

/**
 * A dispatch while a run is starting or running is a duplicate webhook and
 * does nothing. Otherwise it starts the next attempt. This is the only place a
 * run is started: the agent never re-dispatches by itself, retries come from
 * buildd firing a new webhook.
 */
export function decideDispatch(state: RunState): DispatchDecision {
  if (state.status === 'starting' || state.status === 'running') {
    return { action: 'ignore', reason: 'already_live' };
  }
  return { action: 'start', attempt: state.attempt + 1 };
}

/** `null` means there was no exit code at all (exec failed, container died). */
export function outcomeForExitCode(code: number | null | undefined): RunOutcome {
  switch (code) {
    case EXIT_COMPLETED: return 'done';
    case EXIT_FAILED: return 'failed';
    case EXIT_CLAIM_REFUSED: return 'refused';
    case EXIT_USAGE: return 'usage';
    default: return 'crashed';
  }
}

/**
 * Only a crash needs the agent to tell buildd anything, and only when there is
 * a worker to mark. Without a worker ID the claim never finished (nothing to
 * mark) or finished just before the crash, which server-side stale detection
 * covers.
 */
export function crashReportAction(outcome: RunOutcome, workerId: string | undefined): 'report' | 'skip_no_worker' | 'none' {
  if (outcome !== 'crashed') return 'none';
  return workerId ? 'report' : 'skip_no_worker';
}

/**
 * A fresh agent instance that finds a run marked live in storage lost it: the
 * Durable Object was evicted or restarted (deploy, resource limit) and the
 * exec'd process cannot be re-attached. The run is treated as crashed.
 */
export function isOrphanedRun(state: RunState, hasLiveRunInMemory: boolean): boolean {
  return !hasLiveRunInMemory && (state.status === 'starting' || state.status === 'running');
}

// ── Parsing / validation ──────────────────────────────────────────────────────

const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The worker ID from a `BUILDD_WORKER_ID=<id>` line, or null. */
export function parseWorkerIdLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(WORKER_ID_LINE_PREFIX)) return null;
  const id = trimmed.slice(WORKER_ID_LINE_PREFIX.length);
  return WORKER_ID_RE.test(id) ? id : null;
}

// Task IDs are UUIDs in practice. Allow any short token of safe characters so
// local smoke IDs work, but nothing that could become a flag (`--task -x`) or
// escape a path segment.
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_RE.test(value);
}

// ── Config ────────────────────────────────────────────────────────────────────

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_START_TIMEOUT_MS = 5 * 60 * 1000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * How long the platform may leave the container running with the agent idle.
 * The agent holds keepAlive for the whole run, so this is a backstop, set
 * above the longest silent tool call we expect.
 */
export function resolveInactivityTimeoutMs(env: { CONTAINER_INACTIVITY_TIMEOUT_MS?: string }): number {
  return positiveInt(env.CONTAINER_INACTIVITY_TIMEOUT_MS, DEFAULT_INACTIVITY_TIMEOUT_MS);
}

/** How long to wait for `container.running` after `start()` (cold start + image pull). */
export function resolveStartTimeoutMs(env: { CONTAINER_START_TIMEOUT_MS?: string }): number {
  return positiveInt(env.CONTAINER_START_TIMEOUT_MS, DEFAULT_START_TIMEOUT_MS);
}

export interface ContainerEnvSource {
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  MODEL?: string;
  PUSHER_KEY?: string;
  PUSHER_CLUSTER?: string;
  BUILDD_ONCE_MAX_WAIT_MS?: string;
}

/**
 * Claude Code needs some API key to start. The egress handler replaces it with
 * the real gateway credential, so the container never holds a model key.
 */
export const ANTHROPIC_API_KEY_PLACEHOLDER = 'sk-ant-placeholder-replaced-at-egress';

/**
 * Tells the runner's claim that it is running in a cloud container, so the
 * server leaves every credential out of the claim response
 * (apps/web/src/app/api/workers/claim/cloud-executor.ts).
 */
export const CLOUD_EXECUTOR = 'cloud';

/** Prefix of a per-task token (apps/web/src/lib/task-token.ts). */
export const TASK_TOKEN_PREFIX = 'bldt_';

/**
 * The container env, per docs/runner-container.md ("Set by the caller"). The
 * only real secret is the per-task token minted for this run, passed as
 * BUILDD_API_KEY: it is good for this task's claim and its own worker's calls
 * only. The Worker's runner key never enters the container, and anything that
 * is not a per-task token is refused here. No GH_TOKEN and no model key:
 * those are added at egress (outbound.ts). This is an allowlist; nothing else
 * from the Worker's env is copied.
 *
 * ANTHROPIC_BASE_URL is deliberately not passed: model traffic must go to
 * api.anthropic.com, where the egress handler rewrites it to the configured
 * model route (AI Gateway or an Anthropic-compatible proxy) and adds that
 * route's credential. A base URL pointing anywhere else would bypass the
 * handler and arrive with only the placeholder key. For the same reason the
 * proxy settings (MODEL_PROXY_*) stay in the Worker.
 */
export function buildContainerEnv(env: ContainerEnvSource, taskToken: string): Record<string, string> {
  if (!env.BUILDD_SERVER) throw new Error('BUILDD_SERVER is not set');
  if (typeof taskToken !== 'string' || !taskToken.startsWith(TASK_TOKEN_PREFIX)) {
    throw new Error('the container credential must be a per-task token');
  }
  const out: Record<string, string> = {
    BUILDD_SERVER: env.BUILDD_SERVER,
    BUILDD_API_KEY: taskToken,
    ANTHROPIC_API_KEY: ANTHROPIC_API_KEY_PLACEHOLDER,
    BUILDD_DISABLE_AUTO_UPDATE: '1',
    BUILDD_EXECUTOR: CLOUD_EXECUTOR,
  };
  const optional = ['MODEL', 'PUSHER_KEY', 'PUSHER_CLUSTER', 'BUILDD_ONCE_MAX_WAIT_MS'] as const;
  for (const key of optional) {
    const v = env[key];
    if (v) out[key] = v;
  }
  return out;
}

/** Checked before minting, so a misconfigured Worker is a usage outcome, not a crash. */
export function assertRunnerConfig(env: ContainerEnvSource): void {
  if (!env.BUILDD_SERVER) throw new Error('BUILDD_SERVER is not set');
  if (!env.BUILDD_API_KEY) throw new Error('BUILDD_API_KEY is not set');
}

export const TASK_TOKEN_PATH = '/api/runner/task-token';

/**
 * The request that mints this run's per-task token. Made by the agent with
 * the Worker's runner key, which stays in the agent.
 */
export function taskTokenRequest(env: ContainerEnvSource, taskId: string): { url: string; init: RequestInit } {
  assertRunnerConfig(env);
  return {
    url: `${env.BUILDD_SERVER!.replace(/\/+$/, '')}${TASK_TOKEN_PATH}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.BUILDD_API_KEY}` },
      body: JSON.stringify({ taskId }),
    },
  };
}

export function parseTaskTokenResponse(body: unknown, taskId: string): string {
  const b = (body ?? {}) as { token?: unknown; taskId?: unknown };
  if (typeof b.token !== 'string' || !b.token.startsWith(TASK_TOKEN_PREFIX)) {
    throw new Error('task-token response has no per-task token');
  }
  if (b.taskId !== taskId) throw new Error('task-token response is for a different task');
  return b.token;
}

/** The command exec'd in the container. `buildd-once` is baked into the image. */
export function runnerCommand(taskId: string): string[] {
  return ['buildd-once', '--task', taskId];
}

export const OUTPUT_TAIL_LINES = 20;
const OUTPUT_LINE_MAX = 400;

export function appendTail(tail: string[], line: string, max = OUTPUT_TAIL_LINES): string[] {
  const next = [...tail, line.length > OUTPUT_LINE_MAX ? `${line.slice(0, OUTPUT_LINE_MAX)}…` : line];
  return next.length > max ? next.slice(next.length - max) : next;
}
