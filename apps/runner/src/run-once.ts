/**
 * `buildd --once --task <id>`: claim exactly one task, run it to a terminal
 * state, deliver the final report, and exit with a code a supervisor can act
 * on. See docs/design/cloudflare-sandbox-runner.md, Components 1.
 *
 * No local UI server, no background claim loop, no self-updater, no update
 * canary / drain, no terminal-worktree sweep: index.ts dispatches here before
 * any of those start, and the WorkerManager runs with `singleTask` so nothing
 * inside it pulls other work either.
 *
 * Waiting for input: when the agent asks a question the worker parks in
 * `waiting` and the user may still answer from the dashboard (answers arrive
 * over Pusher or the 10s sync). The process keeps waiting for up to
 * BUILDD_ONCE_MAX_WAIT_MS of *continuous* waiting (default 6h; the clock resets
 * when the worker resumes). Past that the worker is aborted and the process
 * exits EXIT_FAILED, so the task goes through buildd's normal retry path
 * instead of holding a container open indefinitely.
 *
 * The decision logic below takes its collaborators as arguments; the real
 * wiring is `runOnceFromCli` at the bottom.
 */
import type { LocalUIConfig, WorkerStatus } from './types';
import type { WorkspaceResolver } from './workspace';

// ── Exit codes ────────────────────────────────────────────────────────────────
// 75 is the launcher's restart code (install.sh re-runs on 75); none of these
// may use it.

/** The task ran and the worker finished `done`. */
export const EXIT_COMPLETED = 0;
/** Claimed (or tried to) and it did not finish: session error, input wait timed out, transient server error. Retryable via buildd's retry path. */
export const EXIT_FAILED = 1;
/** The server would not give us this task (already taken, held, not eligible, nothing claimed). Do NOT retry. */
export const EXIT_CLAIM_REFUSED = 3;
/** Bad invocation or missing configuration (no --task, no API key). */
export const EXIT_USAGE = 64;

/**
 * Printed on its own stdout line as soon as the worker exists, e.g.
 * `BUILDD_WORKER_ID=<uuid>`. A supervisor that only knows the task ID (the
 * Cloudflare WorkerAgent, apps/cloud-runner) reads it so it can mark the
 * worker failed if the container dies before the runner reports.
 */
export const WORKER_ID_LINE_PREFIX = 'BUILDD_WORKER_ID=';

export const DEFAULT_ONCE_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1_000;

export const ONCE_USAGE = 'Usage: buildd --once --task <task-id>\n' +
  '  Claims the given task, runs it to completion, and exits.\n' +
  `  Exit codes: ${EXIT_COMPLETED} completed, ${EXIT_FAILED} failed (retryable), ` +
  `${EXIT_CLAIM_REFUSED} claim refused (do not retry), ${EXIT_USAGE} usage error.\n` +
  '  BUILDD_ONCE_MAX_WAIT_MS caps how long a worker may wait for user input (default 6h).';

// ── Args / config ─────────────────────────────────────────────────────────────

export type OnceArgs =
  | { once: false }
  | { once: true; taskId: string }
  | { once: true; error: string };

export function parseOnceArgs(argv: string[]): OnceArgs {
  if (!argv.includes('--once')) return { once: false };
  let taskId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) taskId = next;
    } else if (a.startsWith('--task=')) {
      taskId = a.slice('--task='.length) || undefined;
    }
  }
  if (!taskId) return { once: true, error: '--once requires --task <task-id>' };
  return { once: true, taskId };
}

export function resolveOnceMaxWaitMs(env: Record<string, string | undefined>): number {
  const n = Number(env.BUILDD_ONCE_MAX_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ONCE_MAX_WAIT_MS;
}

/**
 * The runner config for one task. `singleTask` + `acceptRemoteTasks: false`
 * shut every claim path in the WorkerManager and keep Pusher off the workspace
 * channels. The heartbeat key is per-task so a --once process on a host that
 * also runs a long-lived runner does not overwrite that runner's record.
 */
export function buildOnceConfig(base: LocalUIConfig, opts: { taskId: string; host: string }): LocalUIConfig {
  return {
    ...base,
    singleTask: true,
    acceptRemoteTasks: false,
    maxConcurrent: 1,
    localUiUrl: `headless://${opts.host}/once/${opts.taskId}`,
  };
}

/**
 * Resolver that falls back to a fresh clone in `isolationRoot` when no local
 * checkout matches — a container starts with no pre-cloned repos.
 */
export function createOnceResolver(
  base: WorkspaceResolver,
  isolationRoot: string,
  clone: (workspace: { id: string; repo: string }, isolationRoot: string) => string,
): WorkspaceResolver {
  return {
    ...base,
    resolve(workspace, taskContext) {
      const found = base.resolve(workspace, taskContext);
      if (found) return found;
      if (!workspace.id || !workspace.repo) return null;
      try {
        return clone({ id: workspace.id, repo: workspace.repo }, isolationRoot);
      } catch (err) {
        console.error(`[once] could not clone ${workspace.repo}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    },
  };
}

// ── Decisions ─────────────────────────────────────────────────────────────────

/** Why claimAndStart threw: the server said no (refused) or something broke (failed). */
export function classifyClaimFailure(err: unknown): 'refused' | 'failed' {
  const e = err as { claimError?: string; status?: unknown; message?: string } | null;
  if (e?.claimError === 'server_rejected') return 'refused';
  if (e?.claimError) return 'failed'; // workspace_not_found and friends: ours to fix
  let status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === undefined && typeof e?.message === 'string') {
    const m = e.message.match(/^API error: (\d+)/);
    if (m) status = parseInt(m[1], 10);
  }
  // 4xx is the server deciding; 408 / 429 are "try again later".
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'refused';
  return 'failed';
}

export async function flushOutboxWithRetry(
  outbox: { count(): number; flush(): Promise<{ remaining: number }> },
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let remaining = outbox.count();
  for (let i = 0; i < attempts && remaining > 0; i++) {
    if (i > 0) await sleep(delayMs);
    remaining = (await outbox.flush()).remaining;
  }
  return remaining;
}

// ── Run ───────────────────────────────────────────────────────────────────────

export interface OnceTask {
  id: string;
  title: string;
  workspaceId: string;
  [key: string]: unknown;
}

/** The slice of WorkerManager that --once uses. */
export interface OnceWorkerManager {
  claimAndStart(task: any): Promise<{ id: string } | null>;
  getWorker(id: string): { status: WorkerStatus } | undefined;
  hasLiveSession(id: string): boolean;
  abort(id: string, reason?: string): Promise<unknown>;
  flushToServer(): Promise<void>;
  destroy(): void;
}

export interface RunOnceDeps {
  getTask(id: string): Promise<OnceTask | null>;
  workerManager: OnceWorkerManager;
  /** Replay queued mutations; returns how many are still undelivered. */
  flushOutbox(): Promise<{ remaining: number }>;
  /** Stop auxiliary daemons (credential broker). */
  shutdown?(): Promise<void>;
  maxWaitMs: number;
  pollMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

type Outcome = 'completed' | 'failed' | 'wait_timeout';

async function waitForOutcome(workerId: string, d: RunOnceDeps): Promise<Outcome> {
  let waitingSince: number | null = null;
  for (;;) {
    const status = d.workerManager.getWorker(workerId)?.status;
    if (status === undefined) return 'failed';
    // `done`/`error` is set before the session's teardown finishes (worktree,
    // credential and CBM cleanup); wait for that too.
    if ((status === 'done' || status === 'error') && !d.workerManager.hasLiveSession(workerId)) {
      return status === 'done' ? 'completed' : 'failed';
    }
    if (status === 'waiting') {
      waitingSince ??= d.now();
      if (d.now() - waitingSince >= d.maxWaitMs) return 'wait_timeout';
    } else {
      waitingSince = null;
    }
    await d.sleep(d.pollMs);
  }
}

export async function runOnce(opts: { taskId: string }, d: RunOnceDeps): Promise<number> {
  const { taskId } = opts;
  const wm = d.workerManager;
  let code: number = EXIT_FAILED;
  try {
    const task = await d.getTask(taskId);
    if (!task) {
      d.log(`[once] task ${taskId} could not be fetched`);
      return (code = EXIT_FAILED);
    }

    let worker: { id: string } | null;
    try {
      worker = await wm.claimAndStart(task);
    } catch (err) {
      const kind = classifyClaimFailure(err);
      d.log(`[once] claim ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      return (code = kind === 'refused' ? EXIT_CLAIM_REFUSED : EXIT_FAILED);
    }
    if (!worker) {
      d.log(`[once] task ${taskId} was not started (claim declined locally or deferred)`);
      return (code = EXIT_CLAIM_REFUSED);
    }

    d.log(`${WORKER_ID_LINE_PREFIX}${worker.id}`);
    d.log(`[once] worker ${worker.id} started for task ${taskId}`);
    const outcome = await waitForOutcome(worker.id, d);
    if (outcome === 'wait_timeout') {
      const mins = Math.round(d.maxWaitMs / 60_000);
      d.log(`[once] worker ${worker.id} waited ${mins}m for input — aborting`);
      await wm.abort(worker.id, `No input received within ${mins} minutes (--once max wait)`).catch(() => {});
    }
    d.log(`[once] worker ${worker.id} finished: ${outcome}`);
    return (code = outcome === 'completed' ? EXIT_COMPLETED : EXIT_FAILED);
  } finally {
    await wm.flushToServer().catch(err => d.log(`[once] final sync failed: ${err instanceof Error ? err.message : err}`));
    const { remaining } = await d.flushOutbox().catch(() => ({ remaining: -1 }));
    if (remaining !== 0) {
      d.log(`[once] WARNING: ${remaining < 0 ? 'outbox flush failed' : `${remaining} report(s) still undelivered`} — exiting with code ${code} anyway`);
    }
    try { wm.destroy(); } catch { /* best effort */ }
    await d.shutdown?.().catch(() => {});
  }
}

// ── CLI wiring ────────────────────────────────────────────────────────────────

/**
 * Build the real collaborators and run. Called by index.ts before any
 * long-running subsystem starts. Heavy modules are imported here, not at the
 * top of the file, so unit tests of the logic above stay light.
 */
export async function runOnceFromCli(opts: {
  taskId: string;
  config: LocalUIConfig;
  resolver: WorkspaceResolver;
  builddHome: string;
  host: string;
  env: Record<string, string | undefined>;
}): Promise<number> {
  if (!opts.config.apiKey) {
    console.error('--once needs an API key (BUILDD_API_KEY or config.json apiKey).');
    return EXIT_USAGE;
  }
  const { join } = await import('path');
  const { BuilddClient } = await import('./buildd');
  const { WorkerManager } = await import('./workers');
  const { Outbox, createReplayHandler } = await import('./outbox');
  const { ensureIsolatedClone } = await import('./workspace');
  const { credentialBroker } = await import('./broker');

  const config = buildOnceConfig(opts.config, { taskId: opts.taskId, host: opts.host });
  const isolationRoot = config.workspaceIsolationRoot || join(opts.builddHome, 'once-workspaces');
  const resolver = createOnceResolver(opts.resolver, isolationRoot, ensureIsolatedClone);

  // Own file: a long-lived runner on the same host keeps its own outbox.
  const outbox = new Outbox(join(opts.builddHome, `outbox-once-${opts.taskId}.json`));
  outbox.setFlushHandler(createReplayHandler(() => config));

  const client = new BuilddClient(config);
  const wm = new WorkerManager(config, resolver);
  wm.attachOutbox(outbox);
  // Mid-session credential refresh for long tasks.
  credentialBroker.start({ apiKey: config.apiKey, baseUrl: config.builddServer });

  return runOnce({ taskId: opts.taskId }, {
    getTask: (id) => client.getTask(id) as Promise<OnceTask | null>,
    workerManager: wm,
    flushOutbox: async () => ({ remaining: await flushOutboxWithRetry(outbox) }),
    shutdown: () => credentialBroker.shutdown(),
    maxWaitMs: resolveOnceMaxWaitMs(opts.env),
    pollMs: DEFAULT_POLL_MS,
    now: Date.now,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: (m) => console.log(m),
  });
}
