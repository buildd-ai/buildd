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
 * Resumable runs (BUILDD_ONCE_PARK=1, set only by the cloud Worker; design
 * Phase 2): instead of holding the container, a worker waiting for input with
 * no live session is parked: its branch, uncommitted work, transcript and
 * record are uploaded (park.ts), the worker is marked parked on the server,
 * and the process exits EXIT_PARKED. `--resume-worker <id>` puts that back in
 * a new container, re-attaches to the SAME worker (never a new claim) and
 * lets the 10s sync drain the queued answer into a resumed session.
 * `--park-orphan <id>` is exec'd by the agent into a container it lost track
 * of after its own restart: it stops that runner and parks its worker.
 *
 * The decision logic below takes its collaborators as arguments; the real
 * wiring is `runOnceFromCli` at the bottom.
 */
import { onceFleetIdentity } from '@buildd/shared';
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
/** The worker was parked (resumable runs): a resume continues it in a new container. Not a failure. */
export const EXIT_PARKED = 4;
/** Bad invocation or missing configuration (no --task, no API key). */
export const EXIT_USAGE = 64;

/**
 * Printed on its own stdout line as soon as the worker exists, e.g.
 * `BUILDD_WORKER_ID=<uuid>`. A supervisor that only knows the task ID (the
 * Cloudflare WorkerAgent, apps/cloud-runner) reads it so it can mark the
 * worker failed if the container dies before the runner reports.
 */
export const WORKER_ID_LINE_PREFIX = 'BUILDD_WORKER_ID=';
/** Printed just before EXIT_PARKED. */
export const PARKED_LINE_PREFIX = 'BUILDD_PARKED=';
/** Printed once a resumed run has re-attached to its parked worker. */
export const RESUMED_LINE_PREFIX = 'BUILDD_RESUMED=';

/** Sent to a run the agent parked mid-session after its own restart (no question was pending). */
export const ORPHAN_RESUME_MESSAGE =
  'The platform restarted the container this session was running in. Your transcript, branch and uncommitted changes were restored exactly as they were. Continue the task from where you left off.';

export const DEFAULT_ONCE_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1_000;

export const ONCE_USAGE = 'Usage: buildd --once --task <task-id>\n' +
  '       buildd --once --resume-worker <worker-id> [--task <task-id>]\n' +
  '       buildd --once --park-orphan <worker-id> --task <task-id>\n' +
  '  Claims the given task (or continues a parked worker), runs it to completion, and exits.\n' +
  `  Exit codes: ${EXIT_COMPLETED} completed, ${EXIT_FAILED} failed (retryable), ` +
  `${EXIT_CLAIM_REFUSED} claim refused (do not retry), ${EXIT_PARKED} parked, ${EXIT_USAGE} usage error.\n` +
  '  BUILDD_ONCE_MAX_WAIT_MS caps how long a worker may wait for user input (default 6h).';

// ── Args / config ─────────────────────────────────────────────────────────────

export type OnceArgs =
  | { once: false }
  | { once: true; taskId: string; resumeWorkerId?: string; parkOrphanWorkerId?: string }
  | { once: true; error: string };

const ONCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function flagValue(argv: string[], flag: string): string | undefined | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const next = argv[i + 1];
      return next && !next.startsWith('-') ? next : null;
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1) || null;
  }
  return undefined;
}

export function parseOnceArgs(argv: string[]): OnceArgs {
  if (!argv.includes('--once')) return { once: false };
  const taskId = flagValue(argv, '--task');
  const resume = flagValue(argv, '--resume-worker');
  const orphan = flagValue(argv, '--park-orphan');
  if (resume !== undefined && orphan !== undefined) return { once: true, error: '--resume-worker and --park-orphan do not go together' };
  for (const [flag, v] of [['--resume-worker', resume], ['--park-orphan', orphan]] as const) {
    if (v === null || (typeof v === 'string' && !ONCE_ID_RE.test(v))) return { once: true, error: `${flag} needs a worker id` };
  }
  if (resume) return { once: true, taskId: taskId || '', resumeWorkerId: resume };
  if (!taskId) return { once: true, error: orphan ? '--park-orphan needs --task <task-id>' : '--once requires --task <task-id>' };
  if (orphan) return { once: true, taskId, parkOrphanWorkerId: orphan };
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
 *
 * `fleetIdentity` tells the dashboard what this is: one ephemeral run with one
 * slot and, in a cloud container, the dispatcher group it belongs to — so the
 * fleet shows the dispatcher once instead of one runner per container.
 */
export function buildOnceConfig(
  base: LocalUIConfig,
  opts: { taskId: string; host: string; env?: Record<string, string | undefined> },
): LocalUIConfig {
  return {
    ...base,
    singleTask: true,
    acceptRemoteTasks: false,
    maxConcurrent: 1,
    localUiUrl: `headless://${opts.host}/once/${opts.taskId}`,
    fleetIdentity: onceFleetIdentity(opts.env ?? {}),
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
  /**
   * preferIsolated: try the isolated clone first (it is where the warm-repo
   * restore lives, warm-repo.ts) and use the base resolver only if it fails.
   * Set only when warm repos are on, so every other --once run resolves as
   * before.
   */
  opts: { preferIsolated?: boolean } = {},
): WorkspaceResolver {
  // Set when the isolated clone ended throttled by GitHub: the base resolver's
  // fallback would only auto-clone the same repo again, a second identical
  // request into the same rate limit. (The other order is covered by the
  // clone itself: git-clone.ts refuses a repo it was just throttled on.)
  let throttled = false;
  const isolated = (workspace: { id: string; repo?: string | null }): string | null => {
    if (!workspace.id || !workspace.repo) return null;
    try {
      return clone({ id: workspace.id, repo: workspace.repo }, isolationRoot);
    } catch (err) {
      throttled = (err as { throttled?: unknown } | null)?.throttled === true;
      console.error(`[once] could not clone ${workspace.repo}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
  return {
    ...base,
    resolve(workspace, taskContext) {
      if (opts.preferIsolated) {
        throttled = false;
        return isolated(workspace) ?? (throttled ? null : base.resolve(workspace, taskContext));
      }
      return base.resolve(workspace, taskContext) ?? isolated(workspace);
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
  /**
   * One heartbeat now. Teardown sends a last one once the worker is done, so
   * the run's record says "nothing running" instead of the last periodic
   * beat's count while it ages out (the fleet hides a finished run either way).
   */
  sendHeartbeatNow?(): Promise<void>;
  destroy(): void;
}

export interface RunOnceDeps {
  getTask(id: string): Promise<OnceTask | null>;
  workerManager: OnceWorkerManager;
  /** Replay queued mutations; returns how many are still undelivered. */
  flushOutbox(): Promise<{ remaining: number }>;
  /** Stop auxiliary daemons (credential broker). */
  shutdown?(): Promise<void>;
  /**
   * After the outcome is known and before the final flush: the warm-repo
   * refresh (warm-repo.ts). Best effort; a throw is logged and ignored.
   */
  afterRun?(outcome: Outcome): Promise<void>;
  /**
   * Resumable runs: park this waiting worker (flush, upload the park bundle,
   * mark it parked). True means parked and the process should exit. Absent
   * when parking is off.
   */
  park?(workerId: string): Promise<boolean>;
  maxWaitMs: number;
  pollMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

export type Outcome = 'completed' | 'failed' | 'wait_timeout' | 'parked';

/**
 * `parkArmed: false` (a resumed run): the adopted worker is still `waiting`
 * until its queued answer is drained, and that wait must not be parked again.
 * Parking arms once the worker has been anything but `waiting`.
 */
async function waitForOutcome(workerId: string, d: RunOnceDeps, opts: { parkArmed: boolean } = { parkArmed: true }): Promise<Outcome> {
  let waitingSince: number | null = null;
  let parkArmed = opts.parkArmed;
  let parkTried = false;
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
      // A question that ended the SDK loop: park instead of holding the
      // container. A permission prompt keeps its session live (blocked in a
      // hook) and is never parked. One try per wait: a failed park falls back
      // to holding the container, as before.
      if (d.park && parkArmed && !parkTried && !d.workerManager.hasLiveSession(workerId)) {
        parkTried = true;
        const parked = await d.park(workerId).catch((err) => {
          d.log(`[once] park failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        });
        if (parked) return 'parked';
        d.log(`[once] worker ${workerId} could not be parked; holding the container as before`);
      }
      if (d.now() - waitingSince >= d.maxWaitMs) return 'wait_timeout';
    } else {
      waitingSince = null;
      parkArmed = true;
      parkTried = false;
    }
    await d.sleep(d.pollMs);
  }
}

/** Shared tail of runOnce and runResume: wait, then map the outcome to an exit code. */
async function superviseWorker(workerId: string, d: RunOnceDeps, opts: { parkArmed: boolean }): Promise<{ code: number; outcome: Outcome }> {
  const wm = d.workerManager;
  const outcome = await waitForOutcome(workerId, d, opts);
  if (outcome === 'wait_timeout') {
    const mins = Math.round(d.maxWaitMs / 60_000);
    d.log(`[once] worker ${workerId} waited ${mins}m for input — aborting`);
    await wm.abort(workerId, `No input received within ${mins} minutes (--once max wait)`).catch(() => {});
  }
  d.log(`[once] worker ${workerId} finished: ${outcome}`);
  await d.afterRun?.(outcome).catch(err => d.log(`[once] after-run step failed: ${err instanceof Error ? err.message : err}`));
  if (outcome === 'parked') {
    d.log(`${PARKED_LINE_PREFIX}${workerId}`);
    return { code: EXIT_PARKED, outcome };
  }
  return { code: outcome === 'completed' ? EXIT_COMPLETED : EXIT_FAILED, outcome };
}

async function teardown(d: RunOnceDeps, code: number): Promise<void> {
  const wm = d.workerManager;
  await wm.flushToServer().catch(err => d.log(`[once] final sync failed: ${err instanceof Error ? err.message : err}`));
  const { remaining } = await d.flushOutbox().catch(() => ({ remaining: -1 }));
  if (remaining !== 0) {
    d.log(`[once] WARNING: ${remaining < 0 ? 'outbox flush failed' : `${remaining} report(s) still undelivered`} — exiting with code ${code} anyway`);
  }
  await wm.sendHeartbeatNow?.().catch(() => { /* best effort */ });
  try { wm.destroy(); } catch { /* best effort */ }
  await d.shutdown?.().catch(() => {});
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
    return (code = (await superviseWorker(worker.id, d, { parkArmed: true })).code);
  } finally {
    await teardown(d, code);
  }
}

// ── Resume ────────────────────────────────────────────────────────────────────

/** How a resumed run gets its parked worker back. The CLI wiring implements it. */
export interface ResumePort {
  /** Download and apply the park bundle (repo, worktree, transcript, record). `kind` on a failure once the manifest was read. */
  restore(workerId: string): Promise<{ ok: true; kind: 'waiting' | 'orphan' } | { ok: false; reason: string; kind?: 'waiting' | 'orphan' }>;
  /** POST /api/workers/<id>/reattach: one conditional UPDATE on the server. */
  reattach(workerId: string): Promise<'ok' | 'refused' | 'failed'>;
  /** Clear the park after a failed restore, so the answer degrades to a cold continuation. */
  unpark(workerId: string): Promise<void>;
  /**
   * After unpark: a worker no answer sweep will ever pick up (an orphan park,
   * still `running`) is reported failed, so the task does not sit `assigned`
   * until stale detection. See unrestoredResumeAction.
   */
  settleUnrestored(workerId: string, reason: string, kind?: 'waiting' | 'orphan'): Promise<void>;
  /** Load the restored record into the WorkerManager (and nudge an orphan). */
  adopt(workerId: string, kind: 'waiting' | 'orphan'): Promise<boolean>;
  /** Drop the park bundle once the resume took. */
  discardBundle(): Promise<void>;
}

/**
 * What a resume that could not restore does with its worker, after clearing
 * the park. `waiting_input` holds a queued answer that the server's
 * ack-deadline sweep (cleanupUnresumedAnswers) degrades into a cold
 * continuation, so it is left alone. A `running` worker is an orphan park:
 * nothing is queued, no process drives it, and nothing but stale detection
 * would ever end it, so it is failed (through the normal worker PATCH, which
 * moves the task too). With the status unknown, only a known orphan is failed.
 */
export function unrestoredResumeAction(remoteStatus: string | null | undefined, kind?: 'waiting' | 'orphan'): 'fail' | 'leave' {
  if (remoteStatus === 'running') return 'fail';
  if (remoteStatus) return 'leave';
  return kind === 'orphan' ? 'fail' : 'leave';
}

/**
 * `--resume-worker <id>`: continue a parked worker in this container. Never
 * claims: the only way in is the server's conditional re-attach, so there is
 * still at most one live run per task. A bundle that cannot be restored
 * clears the park and exits without re-attaching; the queued answer is then
 * degraded by the server's ack-deadline sweep (cleanupUnresumedAnswers) into
 * a cold continuation on the task's last pushed branch.
 */
export async function runResume(opts: { workerId: string }, d: RunOnceDeps & { resume: ResumePort }): Promise<number> {
  const { workerId } = opts;
  let code: number = EXIT_FAILED;
  try {
    const restored = await d.resume.restore(workerId).catch((err): { ok: false; reason: string; kind?: undefined } => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
    if (!restored.ok) {
      d.log(`[once] could not restore parked worker ${workerId}: ${restored.reason}; clearing the park`);
      await d.resume.unpark(workerId).catch(() => {});
      await d.resume.settleUnrestored(workerId, restored.reason, restored.kind)
        .catch((err) => d.log(`[once] could not report worker ${workerId} failed: ${err instanceof Error ? err.message : String(err)}`));
      return (code = EXIT_FAILED);
    }
    const attached = await d.resume.reattach(workerId);
    if (attached !== 'ok') {
      d.log(`[once] re-attach to worker ${workerId} ${attached === 'refused' ? 'refused by the server' : 'failed'}`);
      return (code = attached === 'refused' ? EXIT_CLAIM_REFUSED : EXIT_FAILED);
    }
    d.log(`${WORKER_ID_LINE_PREFIX}${workerId}`);
    if (!(await d.resume.adopt(workerId, restored.kind))) {
      d.log(`[once] restored worker ${workerId} could not be loaded`);
      return (code = EXIT_FAILED);
    }
    d.log(`${RESUMED_LINE_PREFIX}${workerId}`);
    d.log(`[once] worker ${workerId} resumed (${restored.kind})`);
    const r = await superviseWorker(workerId, d, { parkArmed: false });
    // Parked again: the new bundle replaced the old one under the same key.
    if (r.outcome !== 'parked') await d.resume.discardBundle().catch(() => {});
    return (code = r.code);
  } finally {
    await teardown(d, code);
  }
}

/**
 * `--park-orphan <id>`: the agent restarted and lost its handle on the runner
 * in this container. Stop that runner (and everything it spawned), then park
 * its worker from what is on disk. Exit 4 on a clean park, 1 otherwise (the
 * agent then reports the run as crashed, as before).
 */
export async function runParkOrphan(
  opts: { workerId: string },
  d: { stopOthers(): void; parkFromDisk(workerId: string): Promise<boolean>; log(msg: string): void },
): Promise<number> {
  try {
    d.stopOthers();
    if (!(await d.parkFromDisk(opts.workerId))) {
      d.log(`[once] orphan park of worker ${opts.workerId} failed`);
      return EXIT_FAILED;
    }
    d.log(`${PARKED_LINE_PREFIX}${opts.workerId}`);
    return EXIT_PARKED;
  } catch (err) {
    d.log(`[once] orphan park of worker ${opts.workerId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_FAILED;
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
  /** `--resume-worker`: continue this parked worker instead of claiming. */
  resumeWorkerId?: string;
  /** `--park-orphan`: stop this container's runner and park its worker. */
  parkOrphanWorkerId?: string;
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
  const { homedir } = await import('os');
  const { rmSync } = await import('fs');
  const { BuilddClient } = await import('./buildd');
  const { ensureIsolatedClone } = await import('./workspace');
  const { createWarmRepoSession, warmRepoEnabled, curlTransport } = await import('./warm-repo');
  const park = await import('./park');
  const { emitMetric, emitPhase } = await import('./phase-lines');
  const { loadWorker } = await import('./worker-store');

  const config = buildOnceConfig(opts.config, { taskId: opts.taskId || opts.resumeWorkerId || 'resume', host: opts.host, env: opts.env });
  const client = new BuilddClient(config);
  const log = (m: string) => console.log(m);

  // ── Parking (resumable runs; BUILDD_ONCE_PARK=1 from the cloud Worker) ──
  const parking = park.parkingEnabled(opts.env);
  const snapshots = curlTransport(opts.env.BUILDD_SNAPSHOT_URL ?? '');
  const parkPaths = {
    builddHome: opts.builddHome,
    claudeConfigDirs: [...new Set([opts.env.CLAUDE_CONFIG_DIR, join(opts.env.HOME || homedir(), '.claude')].filter((p): p is string => !!p))],
    tmpDir: join(opts.builddHome, 'park-tmp'),
  };
  /** Build, upload and mark. False (never a throw) when any step fails; the caller holds the container. */
  const parkNow = (
    worker: { id: string; taskId: string; workspaceId: string; worktreePath?: string; sessionId?: string },
    kind: 'waiting' | 'orphan',
  ): Promise<boolean> => park.parkWorkerNow(worker, kind, { paths: parkPaths, uploader: snapshots, client, emitPhase, emitMetric, log });

  // ── --park-orphan: no WorkerManager, just stop the old runner and park from disk ──
  if (opts.parkOrphanWorkerId) {
    const workerId = opts.parkOrphanWorkerId;
    return runParkOrphan({ workerId }, {
      stopOthers: stopOtherProcesses,
      parkFromDisk: async (id) => {
        const rec = loadWorker(id);
        if (!rec) return false;
        return parkNow({ id, taskId: rec.taskId || opts.taskId, workspaceId: rec.workspaceId, worktreePath: rec.worktreePath, sessionId: rec.sessionId }, 'orphan');
      },
      log,
    });
  }

  const { WorkerManager } = await import('./workers');
  const { Outbox, createReplayHandler } = await import('./outbox');
  const { credentialBroker } = await import('./broker');

  const isolationRoot = config.workspaceIsolationRoot || join(opts.builddHome, 'once-workspaces');
  // Warm repos (BUILDD_WARM_REPO=1, set only by the cloud Worker): restore the
  // workspace snapshot before cloning, refresh it after the run.
  const warm = warmRepoEnabled(opts.env) ? createWarmRepoSession(opts.env, join(opts.builddHome, 'warm-tmp')) : null;
  const onceResolver = createOnceResolver(
    opts.resolver,
    isolationRoot,
    (ws, root) => ensureIsolatedClone(ws, root, warm?.cloneHooks()),
    { preferIsolated: !!warm },
  );
  // A resumed worker's clone is pinned once restored: later lookups (sendMessage
  // resolves by id and name only) must land on the clone its transcript and
  // worktree live in.
  let pinned: { id: string; path: string } | null = null;
  const resolver: WorkspaceResolver = {
    ...onceResolver,
    resolve: (ws, ctx) => (pinned && ws.id === pinned.id ? pinned.path : onceResolver.resolve(ws, ctx)),
  };

  // Own file: a long-lived runner on the same host keeps its own outbox.
  const outboxTask = opts.taskId || `resume-${opts.resumeWorkerId}`;
  const outbox = new Outbox(join(opts.builddHome, `outbox-once-${outboxTask}.json`));
  outbox.setFlushHandler(createReplayHandler(() => config));

  const wm = new WorkerManager(config, resolver);
  wm.attachOutbox(outbox);
  // Mid-session credential refresh for long tasks. Not in a cloud container:
  // it holds no credential to refresh (the claim carries none, see
  // packages/shared/src/executor.ts), and a broker there would only be a way
  // to lease and bootstrap one.
  const cloud = opts.env.BUILDD_EXECUTOR === 'cloud';
  if (!cloud) credentialBroker.start({ apiKey: config.apiKey, baseUrl: config.builddServer });

  const deps: RunOnceDeps = {
    getTask: (id) => client.getTask(id) as Promise<OnceTask | null>,
    workerManager: wm,
    flushOutbox: async () => ({ remaining: await flushOutboxWithRetry(outbox) }),
    shutdown: () => (cloud ? Promise.resolve() : credentialBroker.shutdown()),
    afterRun: async (outcome) => warm?.refresh(outcome),
    ...(parking ? {
      park: async (workerId: string) => {
        const w = wm.getWorker(workerId);
        if (!w) return false;
        // Everything the server should know before the container goes away.
        await wm.flushToServer();
        await flushOutboxWithRetry(outbox);
        wm.persistWorker(workerId);
        return parkNow({ id: w.id, taskId: w.taskId, workspaceId: w.workspaceId, worktreePath: w.worktreePath, sessionId: w.sessionId }, 'waiting');
      },
    } : {}),
    maxWaitMs: resolveOnceMaxWaitMs(opts.env),
    pollMs: DEFAULT_POLL_MS,
    now: Date.now,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log,
  };

  if (!opts.resumeWorkerId) return runOnce({ taskId: opts.taskId }, deps);

  // ── --resume-worker ──
  const resumeWorkerId = opts.resumeWorkerId;
  const resume: ResumePort = {
    restore: async (workerId) => {
      if (!parking) return { ok: false, reason: 'resumable runs are not enabled in this container' };
      emitPhase('restore_park_start');
      const tarPath = join(parkPaths.tmpDir, `resume-${workerId}.tar`);
      const stage = join(parkPaths.tmpDir, `resume-${workerId}`);
      let kind: 'waiting' | 'orphan' | undefined;
      try {
        const { mkdirSync } = await import('fs');
        mkdirSync(parkPaths.tmpDir, { recursive: true });
        const dl = snapshots.download('/park', tarPath);
        if (dl.status !== 200) return { ok: false, reason: `park bundle download answered ${dl.status || 'nothing'}` };
        const opened = park.readParkBundle(tarPath, stage);
        const m = opened.manifest;
        if (m.workerId !== workerId) return { ok: false, reason: 'the park bundle belongs to another worker' };
        kind = m.kind;
        const task = (await client.getTask(m.taskId)) as (OnceTask & { workspace?: { id: string; name: string; repo?: string | null }; context?: Record<string, unknown> | null }) | null;
        const workspace = task?.workspace ?? { id: m.workspaceId, name: '', repo: null };
        const clonePath = onceResolver.resolve({ ...workspace, id: workspace.id || m.workspaceId }, task?.context ?? null);
        if (!clonePath) return { ok: false, reason: 'the workspace repo could not be restored or cloned', kind };
        park.applyParkRepo(opened, clonePath);
        park.restoreParkFiles(opened, parkPaths);
        pinned = { id: m.workspaceId, path: clonePath };
        emitMetric('restore_bytes', dl.bytes);
        return { ok: true, kind: m.kind };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err), kind };
      } finally {
        rmSync(tarPath, { force: true });
        rmSync(stage, { recursive: true, force: true });
        emitPhase('restore_park_end');
      }
    },
    reattach: (workerId) => client.reattachWorker(workerId),
    unpark: async (workerId) => { await client.unparkWorker(workerId); },
    settleUnrestored: async (workerId, reason, kind) => {
      const remote = await client.getWorkerRemote(workerId).catch(() => null);
      if (unrestoredResumeAction(remote?.status, kind) !== 'fail') return;
      await client.updateWorker(workerId, {
        status: 'failed',
        error: `Cloud runner: resuming the parked run failed, the bundle could not be restored: ${reason}`.slice(0, 1000),
      });
      log(`[once] worker ${workerId} reported failed (its parked run could not be restored)`);
    },
    adopt: async (workerId, kind) => {
      const w = wm.adoptParkedWorker(workerId, kind);
      if (!w) return false;
      // A question's answer arrives through the sync; a run the agent parked
      // mid-session has no answer coming, so it is nudged to continue.
      if (kind === 'orphan') void wm.sendMessage(workerId, ORPHAN_RESUME_MESSAGE);
      return true;
    },
    discardBundle: async () => { snapshots.remove?.('/park'); },
  };
  return runResume({ workerId: resumeWorkerId }, { ...deps, resume });
}

export interface ProcInfo { pid: number; ppid: number; uid: number; startTime: number }

/**
 * Which processes --park-orphan stops: every process of this user (the
 * orphaned runner, Claude Code, anything they spawned, including strays
 * reparented to init) except init itself, init's first child (the image's
 * main process, `sleep infinity`: killing it stops the container), this
 * process and its ancestors. The image runs everything, init included, as the
 * same user, so the uid alone does not protect the container.
 */
export function pidsToStop(procs: ProcInfo[], selfPid: number, uid: number): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set<number>([1]);
  let pid: number | undefined = selfPid;
  for (let i = 0; i < 64 && pid !== undefined && pid > 1; i++) {
    keep.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  const initChildren = procs.filter((p) => p.ppid === 1).sort((a, b) => a.startTime - b.startTime);
  if (initChildren[0]) keep.add(initChildren[0].pid);
  return procs.filter((p) => p.pid > 1 && p.uid === uid && !keep.has(p.pid)).map((p) => p.pid);
}

/**
 * --park-orphan: SIGKILL the processes pidsToStop picks, so nothing writes to
 * the worktree or the transcript while they are bundled. Linux /proc only;
 * elsewhere it does nothing.
 */
export function stopOtherProcesses(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync, readdirSync, readFileSync } = require('fs') as typeof import('fs');
  if (!existsSync('/proc/self/stat')) return;
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const procs: ProcInfo[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // Fields after the ")" of comm: state(3) ppid(4) ... starttime(22).
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const m = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf-8'));
      if (!m) continue;
      procs.push({ pid, ppid: Number(rest[1]), uid: Number(m[1]), startTime: Number(rest[19]) });
    } catch { /* gone already */ }
  }
  for (const pid of pidsToStop(procs, process.pid, uid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
  }
}
