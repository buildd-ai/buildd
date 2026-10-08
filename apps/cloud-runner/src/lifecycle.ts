/**
 * Pure decisions for one task's run. No Workers runtime imports, so Bun tests
 * load this file directly. The WorkerAgent (worker-agent.ts) and the
 * supervisor (supervisor.ts) act on what these functions return.
 *
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 3.
 */

import { SEAT_CAP_REASON, SEAT_RETRY_BACKOFF_S, SEAT_WALL_REASON } from './owner-seat';

// ── Exit codes ────────────────────────────────────────────────────────────────
// Mirrors apps/runner/src/run-once.ts. Not imported from there: that module
// lazily imports the whole runner, which must not end up in the Worker bundle.
// lifecycle.test.ts asserts the two stay equal.

export const EXIT_COMPLETED = 0;
export const EXIT_FAILED = 1;
export const EXIT_CLAIM_REFUSED = 3;
/** The runner parked its waiting worker (Phase 2, resumable runs); not a crash. */
export const EXIT_PARKED = 4;
/** `--attach-orphan` found no runner to wait on (apps/runner run-attach.ts EXIT_NOT_ATTACHABLE). */
export const EXIT_NOT_ATTACHABLE = 6;
/** The server named a temporary, self-resolving refusal reason; retry later (see run-once.ts). */
export const EXIT_CLAIM_DEFERRED = 5;
export const EXIT_USAGE = 64;

/** Same prefix run-once prints once the worker exists (`WORKER_ID_LINE_PREFIX`). */
export const WORKER_ID_LINE_PREFIX = 'BUILDD_WORKER_ID=';
/** Printed by run-once just before EXIT_PARKED (`PARKED_LINE_PREFIX`). */
export const PARKED_LINE_PREFIX = 'BUILDD_PARKED=';
/** Printed by run-once just before EXIT_CLAIM_DEFERRED, with the deferral reason. */
export const CLAIM_DEFERRED_LINE_PREFIX = 'BUILDD_CLAIM_DEFERRED=';

// ── State ─────────────────────────────────────────────────────────────────────

import type { RunTimings, StoredRunReport } from './run-report';
import { SNAPSHOT_HOST } from './snapshots';
import type { RunnerSizeDecision } from './runner-class';
import type { ReusedContainer, WarmContainer } from './container-lease';

/** Exec'd in a warm container before the next task's run (apps/runner/src/container-reset.ts). */
export const RESET_COMMAND = ['buildd-once', '--reset-container'] as const;
/** The reset's last line on success, next to exit 0. */
export const RESET_OK_LINE = 'BUILDD_RESET=ok';
/** A lease container's deferred warm snapshot upload, before it is destroyed (apps/runner/src/warm-upload-cli.ts). */
export const WARM_UPLOAD_COMMAND = ['buildd-once', '--upload-warm'] as const;
/** That command's last line. */
export const WARM_UPLOAD_DONE_PREFIX = 'BUILDD_WARM_UPLOAD_DONE=';
/** Set on a lease container's run: the runner defers its warm upload (apps/runner/src/warm-repo.ts). */
export const WARM_UPLOAD_DEFER_ENV = 'BUILDD_WARM_UPLOAD_DEFER';

export type RunStatus = 'idle' | 'starting' | 'running' | 'exited';

/**
 * - done / failed / refused / usage: the runner exited with a code it chose,
 *   so it already reported whatever there was to report.
 * - parked: the runner uploaded a park bundle and marked the worker parked;
 *   a `task.resume` dispatch continues it in a new container.
 * - deferred: the runner ran, but the claim itself was refused for a
 *   temporary reason (EXIT_CLAIM_DEFERRED) — capacity, pacing, a provider
 *   wall. No worker exists. The supervisor self-schedules a retry.
 * - start_deferred: the container itself could not start — the platform is at
 *   its own container-instance ceiling (isContainerStartCapacityError). Never
 *   got as far as exec'ing the runner, so there is no exit code either. The
 *   supervisor self-schedules a retry, same as `deferred`.
 * - crashed: anything else (killed, OOM, container gone, agent restarted
 *   mid-run). The runner probably could not report.
 */
export type RunOutcome = 'done' | 'failed' | 'refused' | 'usage' | 'parked' | 'deferred' | 'start_deferred' | 'crashed';

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
  /** Set when this attempt continues a parked worker (`--resume-worker`); `workerId` is that worker. */
  resumed?: boolean;
  /** When the parked attempt this one resumes ended (agent clock), for the report's gap time. */
  parkedAt?: number;
  /**
   * A pending `task.scheduled` wake (epoch ms): the agent starts a run then.
   * Cleared when it fires or when any dispatch starts a run first.
   */
  scheduledFor?: number;
  /** The Agents SDK schedule id of that wake; a fire with any other id is stale. */
  scheduleId?: string;
  /** From a `BUILDD_CLAIM_DEFERRED=` line: why the claim was deferred (outcome `deferred` only). */
  claimDeferredReason?: string;
  /**
   * Consecutive `deferred`/`start_deferred` attempts this agent has
   * self-scheduled in a row, carried forward only across ITS OWN backoff
   * retries (`dispatch({ deferredRetry: true })`) — any other dispatch
   * (a real retry webhook, a resume, the very first attempt) resets it to 0.
   * Read by `deferredRetryBackoffMs` to decide the next delay, or to stop.
   */
  deferredRetryCount?: number;
  /**
   * The latest container-class decision that reached this agent (buildd's
   * answer at dispatch), kept across this agent's own retries and resumes.
   */
  runnerSize?: RunnerSizeDecision;
  /** The Worker version this attempt started under (version metadata), to tell a deploy from any other restart. */
  agentVersion?: string;
  /** Times this agent restarted under this attempt (newest last), for the run report. */
  agentRestarts?: AgentRestart[];
  // ── Container reuse (container-lease.ts) ──
  /** Task agent: the lease agent that runs (or ran) this task's latest attempt. */
  leasedTo?: string;
  /** Lease agent: the container its last run left for the next task. Cleared when taken or expired. */
  warm?: WarmContainer;
  /** Lease agent: this attempt starts in a container another run left warm. */
  reusedContainer?: ReusedContainer;
  /**
   * Lease agent: since when the warm container is uploading the snapshot its
   * last run deferred, just before it is destroyed. The lease is busy meanwhile.
   */
  warmUploadSince?: number;
  /**
   * Lease agent: the workspace's warm cap (gitConfig.warmSnapshot.maxBytes)
   * from the last run's authenticated grant, for that deferred upload.
   */
  snapshotMaxBytes?: number;
  /**
   * Task agent: a dispatch held for a lease in its tail (since when, and the
   * request). Routed at once when the agent restarts before it was.
   */
  routePending?: { since: number; request: DispatchRequest };
}

/** One agent restart found by `recoverOrphan` (the container outlives the agent). */
export interface AgentRestart {
  /** When this agent instance noticed (agent clock). */
  at: number;
  /** What it did about the run it found. */
  recovery: 'reattached' | 'parked' | 'crashed';
  /** Whether the container was still up when the agent came back. */
  containerRunning: boolean;
  /** How long the attempt had been going. */
  runningForMs: number | null;
  /** The Worker version differs from the one the attempt started under (a deploy); null when either is unknown. */
  versionChanged: boolean | null;
}

export const INITIAL_STATE: RunState = { taskId: null, attempt: 0, status: 'idle' };

// ── Decisions ─────────────────────────────────────────────────────────────────

export type DispatchDecision =
  | { action: 'start'; attempt: number; resumeWorkerId?: string }
  | { action: 'ignore'; reason: 'already_live' | 'not_parked' };

export interface DispatchRequest {
  /** `task.resume`: continue this parked worker instead of claiming. */
  resumeWorkerId?: string;
  /** A `task.scheduled` wake: the time it was scheduled for (epoch ms), for the run report. */
  scheduledFor?: number;
  /**
   * This dispatch is the agent's OWN backoff retry of a `deferred` /
   * `start_deferred` attempt (not a server-driven `task.scheduled`, resume, or
   * a fresh retry webhook) — the only case that carries `deferredRetryCount`
   * forward instead of resetting it to 0.
   */
  deferredRetry?: boolean;
  /**
   * buildd's container-class decision for this dispatch (runner-class.ts), for
   * the run report. The class itself is already fixed: it is the agent class
   * this request reached.
   */
  runnerSize?: RunnerSizeDecision;
  /**
   * The task's workspace, from buildd's runner-size answer (authenticated),
   * never from the webhook body. Keys container reuse (container-lease.ts).
   */
  workspaceId?: string;
  /**
   * How long the task agent held this dispatch for a lease of its workspace
   * to finish its tail and go warm (container-lease.ts waitForTailLease),
   * for the run report. Absent: no wait.
   */
  leaseWaitMs?: number;
}

/**
 * A dispatch while a run is starting or running is a duplicate webhook and
 * does nothing. Otherwise it starts the next attempt. This is the only place a
 * run is started: the agent never re-dispatches by itself, retries come from
 * buildd firing a new webhook. (The one exception is the orphan park in
 * supervisor.ts, which resumes the run a restart interrupted.)
 *
 * A resume starts only when the last attempt of this agent parked exactly that
 * worker. The check-and-set that follows (status `starting`) makes a duplicate
 * `task.resume` a no-op, and a resume that has already run leaves the outcome
 * no longer `parked`, so a late duplicate is ignored too.
 */
export function decideDispatch(state: RunState, request: DispatchRequest = {}): DispatchDecision {
  if (state.status === 'starting' || state.status === 'running') {
    return { action: 'ignore', reason: 'already_live' };
  }
  if (request.resumeWorkerId !== undefined) {
    const parked = state.status === 'exited' && state.outcome === 'parked' && state.workerId === request.resumeWorkerId;
    if (!parked) return { action: 'ignore', reason: 'not_parked' };
    return { action: 'start', attempt: state.attempt + 1, resumeWorkerId: request.resumeWorkerId };
  }
  return { action: 'start', attempt: state.attempt + 1 };
}

/** `null` means there was no exit code at all (exec failed, container died). */
export function outcomeForExitCode(code: number | null | undefined): RunOutcome {
  switch (code) {
    case EXIT_COMPLETED: return 'done';
    case EXIT_FAILED: return 'failed';
    case EXIT_CLAIM_REFUSED: return 'refused';
    case EXIT_CLAIM_DEFERRED: return 'deferred';
    case EXIT_PARKED: return 'parked';
    case EXIT_USAGE: return 'usage';
    default: return 'crashed';
  }
}

/**
 * Cloudflare's container-capacity refusal (Worker `max_instances` or account
 * container ceiling — often containers from a previous burst still draining):
 * thrown by `container.start()` before the runner process ever execs, so
 * there is no worker and no exit code; the run never got that far. Matched on
 * the distinctive fragments of Cloudflare's own message, not the whole
 * string, so minor wording drift does not silently stop matching.
 */
export function isContainerStartCapacityError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /no container instance/i.test(message) && /try again later/i.test(message);
}

/**
 * Backoff (ms) before the supervisor's own retry of a `deferred` /
 * `start_deferred` attempt, for the Nth such attempt in a row (1-indexed:
 * the retry about to be scheduled) — null past the cap, meaning give up and
 * leave the task to buildd's own sweep or a freed-capacity wake instead of
 * retrying forever on a container that may simply be wrong for this task.
 */
export const DEFERRED_RETRY_BACKOFF_S = [30, 60, 120, 300, 600, 900] as const;
export const MAX_DEFERRED_RETRIES = DEFERRED_RETRY_BACKOFF_S.length;

/**
 * A `runner_capability` refusal means the container's Claude Code is older
 * than the task's model needs — most likely a gradual container rollout still
 * serving the previous image. That clears on the order of minutes to an hour,
 * not seconds, so it backs off on a longer, still bounded, schedule.
 */
export const RUNNER_CAPABILITY_RETRY_BACKOFF_S = [60, 180, 300, 600, 900, 1800] as const;

export function deferredRetryBackoffMs(retryNumber: number, reason?: string | null): number | null {
  const schedule = reason === 'runner_capability' ? RUNNER_CAPABILITY_RETRY_BACKOFF_S
    : reason === SEAT_CAP_REASON || reason === SEAT_WALL_REASON ? SEAT_RETRY_BACKOFF_S
    : DEFERRED_RETRY_BACKOFF_S;
  if (!Number.isInteger(retryNumber) || retryNumber < 1 || retryNumber > schedule.length) return null;
  return schedule[retryNumber - 1]! * 1000;
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

/** The worker ID from a `BUILDD_PARKED=<id>` line, or null. */
export function parseParkedLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PARKED_LINE_PREFIX)) return null;
  const id = trimmed.slice(PARKED_LINE_PREFIX.length);
  return WORKER_ID_RE.test(id) ? id : null;
}

/** The worker ID from a `BUILDD_WORKER_ID=<id>` line, or null. */
export function parseWorkerIdLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(WORKER_ID_LINE_PREFIX)) return null;
  const id = trimmed.slice(WORKER_ID_LINE_PREFIX.length);
  return WORKER_ID_RE.test(id) ? id : null;
}

/** Deferral reasons are short identifiers: a ClaimDiagnosticReason, a taskExclusion code, or 'unknown'. */
const CLAIM_DEFERRED_REASON_RE = /^[A-Za-z0-9_]{1,64}$/;

/** The reason from a `BUILDD_CLAIM_DEFERRED=<reason>` line, or null. */
export function parseClaimDeferredLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CLAIM_DEFERRED_LINE_PREFIX)) return null;
  const reason = trimmed.slice(CLAIM_DEFERRED_LINE_PREFIX.length);
  return CLAIM_DEFERRED_REASON_RE.test(reason) ? reason : null;
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
  BROWSER_BRIDGE?: string;
  /** Ephemeral capability created by the owning agent for this attempt. */
  browserSessionToken?: string;
  BUILDD_SERVER?: string;
  BUILDD_API_KEY?: string;
  MODEL?: string;
  PUSHER_KEY?: string;
  PUSHER_CLUSTER?: string;
  BUILDD_ONCE_MAX_WAIT_MS?: string;
  /** `1` turns on warm repos in the container (see warmReposEnabled). */
  WARM_REPOS?: string;
  /** Largest warm snapshot part in bytes (see warmMaxBundleBytes). */
  WARM_MAX_BUNDLE_BYTES?: string;
  /** `1` turns on parking a waiting worker (see resumableRunsEnabled). */
  RESUMABLE_RUNS?: string;
  /** This deployment's runner group (its Worker name); see RUNNER_GROUP_CONTAINER_ENV. */
  RUNNER_GROUP?: string;
}

/** Mirrors WARM_DEFAULT_MAX_BUNDLE_BYTES in apps/runner/src/warm-repo.ts. */
export const DEFAULT_WARM_MAX_BUNDLE_BYTES = 1024 ** 3;

/**
 * The largest warm bundle (or cache tarball) a container uploads, and the
 * Worker accepts: WARM_MAX_BUNDLE_BYTES when it is a positive integer, else
 * 1 GiB. Past it the runner skips the upload (and says so in the run report)
 * and the workspace clones every time.
 */
export function warmMaxBundleBytes(env: { WARM_MAX_BUNDLE_BYTES?: string }): number {
  const raw = env.WARM_MAX_BUNDLE_BYTES?.trim() ?? '';
  const n = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_WARM_MAX_BUNDLE_BYTES;
}

/**
 * Resumable runs (Phase 2): the container parks a worker that waits for input
 * and a `task.resume` dispatch continues it. Needs the opt-in var and the R2
 * binding (the park bundle lives there). Off by default.
 */
export function resumableRunsEnabled(env: { RESUMABLE_RUNS?: string; SNAPSHOTS?: unknown }): boolean {
  return env.RESUMABLE_RUNS === '1' && !!env.SNAPSHOTS;
}

/**
 * Warm repos (docs/design/cloudflare-sandbox-runner.md, Phase 2) need both the
 * opt-in var and the R2 binding. Off by default: without either, the
 * container env and the egress routes are exactly as before.
 */
export function warmReposEnabled(env: { WARM_REPOS?: string; SNAPSHOTS?: unknown }): boolean {
  return env.WARM_REPOS === '1' && !!env.SNAPSHOTS;
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

/**
 * The runner group every container of this deployment reports on its
 * heartbeat (packages/shared/src/runner-fleet.ts), so the fleet shows one
 * elastic group per dispatcher instead of one "machine" per run. The value is
 * the Worker name: wrangler.jsonc sets the var, and deploy.ts --name rewrites
 * it with the name. The default covers a Worker deployed before the var.
 */
export const RUNNER_GROUP_CONTAINER_ENV = 'BUILDD_RUNNER_GROUP';
export const DEFAULT_RUNNER_GROUP = 'buildd-cloud-runner';

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
/**
 * apps/runner/Dockerfile.once's ENV, passed explicitly with every exec: a
 * process exec'd in a Cloudflare container starts with only the env it is
 * given, so the image ENV (sandbox off, non-essential Claude Code traffic off,
 * the buildd paths) never reached the runner. lifecycle.test.ts keeps this
 * equal to the Dockerfile.
 */
export const IMAGE_ENV: Readonly<Record<string, string>> = {
  HOME: '/home/bun',
  BUILDD_HOME: '/home/bun/.buildd',
  BUILDD_REPO_ROOT: '/opt/buildd',
  BUILDD_DISABLE_AUTO_UPDATE: '1',
  BUILDD_DISABLE_SANDBOX: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

export function buildContainerEnv(env: ContainerEnvSource, taskToken: string): Record<string, string> {
  if (!env.BUILDD_SERVER) throw new Error('BUILDD_SERVER is not set');
  if (typeof taskToken !== 'string' || !taskToken.startsWith(TASK_TOKEN_PREFIX)) {
    throw new Error('the container credential must be a per-task token');
  }
  const out: Record<string, string> = {
    ...IMAGE_ENV,
    BUILDD_SERVER: env.BUILDD_SERVER,
    BUILDD_API_KEY: taskToken,
    ANTHROPIC_API_KEY: ANTHROPIC_API_KEY_PLACEHOLDER,
    BUILDD_DISABLE_AUTO_UPDATE: '1',
    BUILDD_EXECUTOR: CLOUD_EXECUTOR,
    [RUNNER_GROUP_CONTAINER_ENV]: env.RUNNER_GROUP || DEFAULT_RUNNER_GROUP,
  };
  if (env.BROWSER_BRIDGE === '1' && env.browserSessionToken) {
    out.BUILDD_BROWSER_BRIDGE_URL = 'https://buildd-browser.invalid';
    out.BUILDD_BROWSER_SESSION_TOKEN = env.browserSessionToken;
  }
  const optional = ['MODEL', 'PUSHER_KEY', 'PUSHER_CLUSTER', 'BUILDD_ONCE_MAX_WAIT_MS'] as const;
  for (const key of optional) {
    const v = env[key];
    if (v) out[key] = v;
  }
  Object.assign(out, warmRepoEnv(env));
  if (env.RESUMABLE_RUNS === '1') {
    // Park a worker that waits for input instead of holding the container.
    out.BUILDD_ONCE_PARK = '1';
    out.BUILDD_SNAPSHOT_URL = `https://${SNAPSHOT_HOST}`;
  }
  return out;
}

/**
 * The env of the deferred warm upload: the image env and the snapshot
 * pseudo-host only. No token: the run is over, and the snapshot host is
 * authorised by the lease (worker-agent.ts getSnapshotScope), not the container.
 */
export function warmUploadEnv(env: ContainerEnvSource): Record<string, string> {
  return { ...IMAGE_ENV, BUILDD_EXECUTOR: CLOUD_EXECUTOR, ...warmRepoEnv(env) };
}

function warmRepoEnv(env: ContainerEnvSource): Record<string, string> {
  if (env.WARM_REPOS !== '1') return {};
  // The runner restores and uploads snapshots through this pseudo-host;
  // the egress handler serves it (snapshots.ts). No key, no credential.
  const out: Record<string, string> = { BUILDD_WARM_REPO: '1', BUILDD_SNAPSHOT_URL: `https://${SNAPSHOT_HOST}` };
  if (/^\d{1,16}$/.test(env.WARM_MAX_BUNDLE_BYTES?.trim() ?? '')) {
    out.BUILDD_WARM_MAX_BUNDLE_BYTES = String(warmMaxBundleBytes(env));
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
export function runnerCommand(taskId: string, resumeWorkerId?: string): string[] {
  return resumeWorkerId
    ? ['buildd-once', '--resume-worker', resumeWorkerId, '--task', taskId]
    : ['buildd-once', '--task', taskId];
}

/**
 * Exec'd in a container still running after the agent restarted: stops the
 * runner it can no longer supervise and parks its worker (exit 4), so a
 * resume can continue it instead of the run being lost.
 */
/**
 * Exec'd in a container still running after the agent restarted: waits on the
 * runner that is still going and exits with its code (apps/runner run-attach.ts).
 */
export function attachOrphanCommand(taskId: string, workerId: string): string[] {
  return ['buildd-once', '--attach-orphan', workerId, '--task', taskId];
}

export function orphanParkCommand(taskId: string, workerId: string): string[] {
  return ['buildd-once', '--park-orphan', workerId, '--task', taskId];
}

export const OUTPUT_TAIL_LINES = 20;
const OUTPUT_LINE_MAX = 400;

export function appendTail(tail: string[], line: string, max = OUTPUT_TAIL_LINES): string[] {
  const next = [...tail, line.length > OUTPUT_LINE_MAX ? `${line.slice(0, OUTPUT_LINE_MAX)}…` : line];
  return next.length > max ? next.slice(next.length - max) : next;
}
