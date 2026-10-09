import { TERMINAL_WORKER_STATUSES, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { observeGitProgress, type GitProgressObservation } from './git-observe';
import { appendMilestone } from './tool-milestones';
import { CHECKPOINT_LABELS, CheckpointEvent } from './types';
import { questionPayload } from './question-gate.js';
import type { LocalWorker, CheckpointEventType } from './types';
import type { BuilddClient } from './buildd';
import type { LocalUIConfig } from './types';
import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { saveWorker as storeSaveWorker, loadAllWorkers } from './worker-store';
import { removeWorktreeIfUnowned } from './git-operations';
import { WAITING_WORKTREE_TTL_MS, isWorktreePathOwnedByOtherLiveWorker } from './worktree-utils';
import { sessionLog } from './session-logger';
import { buildTerminalAttributionPayload } from './terminal-attribution';
import { reapSession, teardownSession } from './session-teardown';
import { WORKER_HARD_TIMEOUT_MS } from '@buildd/shared';
import { sweepWorktreeChanges, refreshBaseRef, type PathCollision } from './path-claim-enforcement';
import { firstCollision } from './path-collision-defer';
import { formatWorkerMessages, type WorkerMessage } from '@buildd/core/worker-message-format';
import {
  createWorkingSetState,
  normalizeWorkingSetState,
  observeWorkingSet,
  nextWorkingSetDelta,
  applyWorkingSetAck,
  readWorkingSetAck,
} from './working-set';
import { blockedToCollision } from './ship-checkpoint';
import { enqueueSiblingProbes } from './sibling-probe';

/**
 * Grace period after a worker's own completion/failure before checkStale()
 * reaps a still-live SDK session. Three paths set status `done`/`error`
 * while the session keeps running (worker:completed, the syncWorkerToServer
 * sync-race branch, markDone) — a hung tool/MCP call after complete_task
 * becomes an untracked `claude` CLI subprocess whose concurrency slot
 * already reads as free. checkStale only ever watched working/stale
 * workers, so this window was invisible to it.
 */
const POST_COMPLETION_SESSION_GRACE_MS = 5 * 60 * 1000;

/**
 * How long a done/error worker stays in memory before eviction — it may still
 * be resumed by a follow-up message. The on-disk terminal worktree sweep
 * (workers.ts) uses the same window.
 */
export const TERMINAL_WORKER_RETENTION_MS = 10 * 60 * 1000;

/**
 * Server-side worker statuses that genuinely end a lease. A 409 that names one
 * of these is a real termination; anything else is coordination noise and must
 * not kill a live SDK session. The server's own set (@buildd/shared), so a
 * `superseded` worker ends here too; `cancelled` stays as a defensive extra
 * (it is a task status, but a cancel must never be read as noise).
 */
export const SERVER_TERMINAL_STATUSES: ReadonlySet<string> = new Set([...TERMINAL_WORKER_STATUSES, 'cancelled']);

/** Server-side task statuses that end the task; a cancel counts. */
export const SERVER_TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);

/**
 * How long an injected human message suppresses re-injection of identical text.
 * Covers the Pusher-then-queue race (seconds) without swallowing a deliberate
 * re-send much later.
 */
const DUPLICATE_INJECTION_WINDOW_MS = 15 * 60 * 1000;

/** A working worker that has not synced for this long is synced anyway, dirty or not. */
export const QUIET_SYNC_INTERVAL_MS = 30_000;

/**
 * Resolve the main-repo path that owns a worktree by trimming at the
 * `.buildd-worktrees/` marker. Worktrees live at
 * `<repoPath>/.buildd-worktrees/<safeBranch>`.
 */
function repoPathFromWorktree(worktreePath: string): string {
  const marker = join('.buildd-worktrees', '');
  const idx = worktreePath.indexOf(marker);
  return idx > 0 ? worktreePath.substring(0, idx) : worktreePath;
}

/** How often the sync tick may fetch a base ref it could not resolve. */
const BASE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Files this task has changed, for observed-touch leasing: the checkpoint
 * sweep (path-claim-enforcement.ts) against the worker's RESOLVED base — the
 * ref its worktree was cut from, a mission integration branch on a mission
 * task — unioned with staged, unstaged and untracked files, so Bash and Codex
 * writes reach the manifest too.
 *
 * This replaced committed-only `origin/HEAD...HEAD || origin/dev...HEAD`
 * observation, which missed every uncommitted write and, on a mission branch,
 * reported the integration branch's own history as this task's edits.
 * With no resolvable base the committed half is left out rather than guessed.
 * Never throws — passive infrastructure.
 */
function computeTouchedPaths(worktreePath: string, baseRef: string | undefined): { paths: string[]; baseResolved: boolean; complete: boolean } {
  try {
    const sweep = sweepWorktreeChanges(worktreePath, baseRef);
    // `complete`: git saw the whole set. A configured base that did not
    // resolve, or a git error, means a path missing from this sweep is not
    // evidence it was reverted — the tracker then only adds, never removes.
    const complete = !sweep.error && (!baseRef || sweep.baseResolved);
    return { paths: sweep.paths, baseResolved: sweep.baseResolved, complete };
  } catch {
    return { paths: [], baseResolved: false, complete: false };
  }
}

/**
 * Does the worktree have uncommitted modifications to TRACKED files right now?
 * Untracked (`??`) entries are excluded — a scratch file the agent hasn't
 * decided about yet isn't the same signal as an edit sitting uncommitted.
 *
 * Sent on every sync tick so `workers.dirty_worktree` is current by the time
 * complete_task reaches the server — that call arrives directly from the
 * agent's MCP tool over HTTP, with no local git access of its own, so the
 * completion gate can only read whatever this loop most recently reported.
 * Fail-open (returns false on error): this is passive infrastructure, not a
 * source of truth on its own — the runner's own terminal collectGitStats call
 * (git-operations.ts) computes the same thing independently at session end.
 */
function computeDirtyWorktree(worktreePath: string): boolean {
  try {
    // Runs every sync tick against the worker's own live worktree, so it can
    // race an agent `git add`/`git commit` there for the same index.lock —
    // GIT_OPTIONAL_LOCKS=0 skips the opportunistic index write-back `status`
    // would otherwise do, without changing the porcelain output read below.
    const output = execSync('git status --porcelain', {
      cwd: worktreePath,
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).toString();
    return output.split('\n').some(line => line.length > 0 && !line.startsWith('??'));
  } catch {
    return false;
  }
}

// The ownership predicate this file used to own privately now lives in
// worktree-utils.ts as `isWorktreePathOwnedByOtherLiveWorker`, next to the rest
// of the pure worktree policy. It was private here, which is why only these two
// eviction sites consulted it while four other removal sites force-removed
// blind. See that docstring for the hazard.

/**
 * Check if a branch name indicates an ephemeral e2e test worktree.
 * These are created by e2e/integration tests and should be cleaned up
 * immediately (0 retention) to prevent worktree accumulation.
 *
 * E2E test tasks have titles like "[E2E-TEST] Echo ..." which get sanitized
 * to branch names containing "--e2e-test-".
 */
export function isEphemeralTestBranch(branch: string | undefined): boolean {
  if (!branch) return false;
  return branch.includes('--e2e-test-');
}

/**
 * Extract a short label from reasoning text: first sentence, up to period/newline/120 chars.
 * Shared between syncWorkerToServer (building milestones payload) and closePhase in workers.ts.
 */
export function extractPhaseLabel(text: string): string {
  // Take first line or sentence
  const firstLine = text.split('\n')[0].trim();
  // Find first sentence boundary
  const periodIdx = firstLine.indexOf('. ');
  const label = periodIdx > 0 && periodIdx < 120
    ? firstLine.slice(0, periodIdx)
    : firstLine.slice(0, 120);
  return label + (firstLine.length > 120 && periodIdx < 0 ? '...' : '');
}

/**
 * Dependencies that WorkerSync needs from WorkerManager.
 * Passed as a context object to avoid coupling to the full class.
 */
export interface WorkerSyncContext {
  config: LocalUIConfig;
  buildd: BuilddClient;
  workers: Map<string, LocalWorker>;
  sessions: Map<string, { inputStream: any; abortController: AbortController; reapedAt?: number }>;
  dirtyWorkers: Set<string>;
  dirtyForDisk: Set<string>;
  emit: (event: any) => void;
  abort: (workerId: string, reason?: string) => Promise<void>;
  /**
   * Injects text into the live agent session at its next turn boundary.
   * `ids` are the served message ids, tracked so the session's own echo can
   * acknowledge them. Resolves false when it could not.
   */
  sendMessage: (workerId: string, message: string, ids?: string[]) => Promise<boolean | void>;
  /** Adaptive stale timeout getter (may be updated externally) */
  getAdaptiveStaleTimeout: () => number;
  setAdaptiveStaleTimeout: (ms: number) => void;
  recentCycleTimes: number[];
  probedWorkers: Set<string>;
  addMilestone: (worker: LocalWorker, milestone: any) => void;
  buildUserMessage: (content: string, opts?: { sessionId?: string }) => any;
  /** Tears down the worker's Pusher channel subscription, if any. Idempotent. */
  unsubscribeFromWorker: (workerId: string) => void;
  /**
   * Enforce-mode path claims: a collision the server reported on this sync's
   * observed touches. WorkerManager checkpoints and defers the task. Optional.
   */
  onPathCollision?: (worker: LocalWorker, collision: PathCollision) => void;
}

/**
 * Handles worker sync/persistence operations extracted from WorkerManager.
 *
 * Manages:
 * - Server sync (dirty worker state → buildd API)
 * - Disk persistence (in-memory state → local disk)
 * - Stale detection and graduated recovery
 * - Completed worker eviction (memory management)
 * - Cycle time tracking for adaptive timeouts
 */
export class WorkerSync {
  /**
   * Newest human (`type: 'user'`) chat-message timestamp already accounted for,
   * per worker. Human text also arrives outside this loop — the Pusher
   * `worker:command` handler and the runner's own /message endpoints call
   * sendMessage directly — and the server cannot see those deliveries. Reporting
   * the messages we observe is what lets it mark them delivered instead of
   * guessing at send time.
   *
   * Seeded (not reported) the first time a worker is seen, so a runner restart
   * does not re-confirm history it did not deliver.
   */
  private gitObservations = new Map<string, { at: number; head: string; facts: GitProgressObservation | null }>();
  private reportedGit = new Map<string, { lastCommitSha: string; commitCount: number }>();

  private lastSeenUserMessageTs = new Map<string, number>();

  /** Last successful sync per worker, for the quiet-worker fallback (B-6). */
  private lastSyncedAt = new Map<string, number>();

  constructor(private ctx: WorkerSyncContext) {}

  /**
   * Newest human message currently in the worker's local transcript.
   */
  private latestUserMessageTs(worker: LocalWorker): number {
    let newest = 0;
    for (const msg of (worker.messages ?? []) as Array<{ type?: string; timestamp?: number }>) {
      if (msg?.type === 'user' && typeof msg.timestamp === 'number' && msg.timestamp > newest) {
        newest = msg.timestamp;
      }
    }
    return newest;
  }

  /**
   * Human text injected into this session in the last few minutes (used to skip
   * re-injecting an urgent instruction that arrived over Pusher and then again
   * from the queue that backs it up).
   *
   * Time-boxed on purpose: the Pusher/queue race resolves in seconds, whereas a
   * human deliberately re-sending the same words much later means "you did not
   * act on this" and must reach the agent again.
   */
  private alreadyInjected(worker: LocalWorker, text: string): boolean {
    const cutoff = Date.now() - DUPLICATE_INJECTION_WINDOW_MS;
    return ((worker.messages ?? []) as Array<{ type?: string; content?: string; timestamp?: number }>).some(
      (msg) => msg?.type === 'user'
        && typeof msg.content === 'string'
        && msg.content === text
        && (msg.timestamp ?? 0) >= cutoff,
    );
  }

  /**
   * Tell the server that `text` reached the agent session. This is the only
   * signal that marks an instruction delivered — the send-time optimism it
   * replaces recorded deliveries for messages that never arrived.
   */
  private async confirmInstructionDelivery(workerId: string, text: string | null, ids: string[] = []) {
    if (!text && ids.length === 0) return;
    try {
      await this.ctx.buildd.updateWorker(workerId, {
        ...(text ? { instructionsDelivered: text } : {}),
        ...(ids.length > 0 ? { instructionIdsDelivered: ids } : {}),
      } as any);
    } catch {
      // Unconfirmed: the instruction stays queued server-side and is served again.
    }
  }

  /**
   * Restore workers from disk on startup.
   * Workers with active status are marked as errored since we can't resume SDK sessions.
   * Exception: 'waiting' workers keep their status for sendMessage()-based resume.
   */
  restoreWorkersFromDisk() {
    try {
      const restored = loadAllWorkers();
      let skippedTerminal = 0;
      for (const worker of restored) {
        // A record that was ALREADY done/error before this restart (not one
        // this restart just killed) needs no live tracking: it's already
        // correctly persisted, getWorkers() merges it straight off disk, and
        // evictCompletedWorkers() would just delete it again on its very next
        // tick — pure churn. This was the single largest category in the
        // per-worker logs (worker_evicted, 37.7% of all entries): every
        // restart reloaded the whole 24h history into memory only to evict
        // it moments later.
        if (!worker.killedByRestart && (worker.status === 'done' || worker.status === 'error')) {
          skippedTerminal++;
          continue;
        }

        // Workers with active status can't be resumed (no SDK session/inputStream).
        // Exception: 'waiting' workers keep their status so the user can still answer —
        // sendMessage() will detect waiting+no-session and restart via resumeSession().
        // `killedByRestart` covers the common case: loadAllWorkers already
        // rewrote this worker from 'working' to 'error' (SDK sessions cannot
        // survive a restart), which used to make the status check below fail and
        // silently skip the notification — stranding the server row at 'running'
        // until the reaper expired it. 'stale' still arrives unrewritten, and
        // 'working' is kept for any caller that hands us a pre-rewrite row.
        if (worker.killedByRestart || worker.status === 'working' || worker.status === 'stale') {
          worker.status = 'error';
          worker.error = 'Process restarted';
          worker.completedAt = worker.completedAt || Date.now();
          worker.currentAction = 'Process restarted';
          delete worker.killedByRestart;

          // Notify server so it doesn't stay "running" forever. Carries
          // whatever cost/token/turn numbers this session had accumulated
          // before the process died — without them the crashed session's
          // terminal record (see PATCH /api/workers/[id]) would land with
          // every measurement null, exactly like the refusal-path bug this
          // was built alongside. `crashReconciled` tells the server this
          // 'failed' write is a reconciliation, not the agent's own report,
          // so its terminal record's outcome reads 'crashed' rather than an
          // ordinary failure.
          this.ctx.buildd.updateWorker(worker.id, {
            status: 'failed',
            error: 'Process restarted',
            crashReconciled: true,
            ...buildTerminalAttributionPayload(worker),
            ...(typeof worker.resultMeta?.numTurns === 'number' && worker.resultMeta.numTurns > 0
              ? { resultMeta: { numTurns: worker.resultMeta.numTurns } }
              : {}),
          }).catch(() => {});
        }
        // Ensure arrays exist (workers saved before these features were added)
        if (!worker.checkpoints) worker.checkpoints = [];
        if (!worker.subagentTasks) worker.subagentTasks = [];
        if (worker.subagentTasksObservedCount === undefined) worker.subagentTasksObservedCount = worker.subagentTasks.length;
        // Ensure checkpointEvents set exists (reconstructed from milestones by worker-store)
        if (!worker.checkpointEvents || !(worker.checkpointEvents instanceof Set)) {
          worker.checkpointEvents = new Set<CheckpointEventType>(
            worker.milestones
              .filter((m): m is Extract<typeof m, { type: 'checkpoint' }> => m.type === 'checkpoint')
              .map(m => m.event)
          );
        }
        this.ctx.workers.set(worker.id, worker);
      }
      const liveRestored = restored.length - skippedTerminal;
      if (liveRestored > 0 || skippedTerminal > 0) {
        console.log(
          `[WorkerStore] Restored ${liveRestored} worker(s) from disk` +
          (skippedTerminal > 0 ? ` (${skippedTerminal} already-terminal, left on disk)` : ''),
        );
      }
    } catch (err) {
      console.error('[WorkerStore] Failed to restore workers from disk:', err);
    }
  }

  /**
   * Persist workers that have been marked dirty since last interval.
   * Called on a 5s timer to batch disk writes.
   */
  persistDirtyWorkers() {
    if (this.ctx.dirtyForDisk.size === 0) return;
    const toSave = new Set(this.ctx.dirtyForDisk);
    this.ctx.dirtyForDisk.clear();
    for (const workerId of toSave) {
      const worker = this.ctx.workers.get(workerId);
      if (worker) {
        try {
          storeSaveWorker(worker);
        } catch (err) {
          console.error(`[WorkerStore] Failed to persist worker ${workerId}:`, err);
        }
      }
    }
  }

  /**
   * Sync a single worker's state to the buildd server.
   * Handles abort responses (server-side termination) and pending instructions.
   */
  async syncWorkerToServer(worker: LocalWorker) {
    try {
      let gitFacts: GitProgressObservation | null = null;
      if (worker.worktreePath && worker.prBaseRef && worker.branch && existsSync(worker.worktreePath)) {
        try {
          const head = execSync('git rev-parse HEAD', { cwd: worker.worktreePath, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          const cached = this.gitObservations.get(worker.id);
          if (!cached || cached.head !== head || Date.now() - cached.at >= 30_000) {
            gitFacts = observeGitProgress(worker.worktreePath, worker.prBaseRef, worker.branch);
            this.gitObservations.set(worker.id, { at: Date.now(), head, facts: gitFacts });
          } else gitFacts = cached.facts;
          if (gitFacts) {
            worker.checkpointEvents ??= new Set<CheckpointEventType>();
            for (const event of [
              ...(gitFacts.commitCount > 0 ? [CheckpointEvent.FIRST_COMMIT] : []),
              ...(gitFacts.pushed ? [CheckpointEvent.FIRST_PUSH] : []),
            ]) {
              if (worker.checkpointEvents.has(event)) continue;
              worker.checkpointEvents.add(event);
              const milestone = { type: 'checkpoint' as const, event, label: CHECKPOINT_LABELS[event], ts: Date.now() };
              // Avoid addMilestone's immediate sync recursion: these facts are already on this PATCH.
              appendMilestone(worker.milestones, milestone);
              this.ctx.dirtyForDisk.add(worker.id);
              this.ctx.emit({ type: 'milestone', workerId: worker.id, milestone });
            }
          }
        } catch { /* Passive observation never interrupts the worker. */ }
      }
      const priorGit = this.reportedGit.get(worker.id);
      const gitChanged = gitFacts && (!priorGit || priorGit.lastCommitSha !== gitFacts.lastCommitSha || priorGit.commitCount !== gitFacts.commitCount);
      // Build milestones array, appending current in-progress phase as pending
      const milestones: any[] = worker.milestones.map(m => ({ ...m }));
      if (worker.phaseText && worker.phaseToolCount > 0) {
        milestones.push({
          type: 'phase' as const,
          label: extractPhaseLabel(worker.phaseText),
          toolCount: worker.phaseToolCount,
          ts: worker.phaseStart || Date.now(),
          pending: true,
          ...(worker.phaseOps?.length ? { ops: [...worker.phaseOps] } : {}),
        });
      }

      // Collect active subagent progress for dashboard visibility. agentId /
      // parentAgentId (SDK v0.3.202+) let the task view reconstruct depth-2+
      // agent trees; omitted on older CLIs, where the view stays a flat list.
      const activeProgress = worker.subagentTasks
        .filter(t => t.status === 'running' && t.progress)
        .map(t => ({
          taskId: t.taskId,
          agentName: t.progress!.agentName,
          toolCount: t.progress!.toolCount,
          durationMs: t.progress!.durationMs,
          cumulativeUsage: t.progress!.cumulativeUsage,
          ...(t.agentId ? { agentId: t.agentId } : {}),
          ...(t.parentAgentId ? { parentAgentId: t.parentAgentId } : {}),
        }));

      // Drain the append-only buffers BEFORE awaiting the PATCH, not after. Two
      // overlapping syncs both used to read the same populated buffer and clear it
      // once, so every buffered MCP call / error trace was filed twice server-side.
      // Restored below if the PATCH throws, so nothing is lost.
      const drainedMcpCalls = worker.pendingMcpCalls?.length ? worker.pendingMcpCalls : null;
      const drainedErrorTraces = worker.pendingErrorTraces?.length ? worker.pendingErrorTraces : null;
      const drainedActionEvents = worker.pendingActionEvents?.length ? worker.pendingActionEvents : null;
      const drainedPromptCompositionEvents = worker.pendingPromptCompositionEvents?.length ? worker.pendingPromptCompositionEvents : null;
      if (drainedMcpCalls) worker.pendingMcpCalls = [];
      if (drainedErrorTraces) worker.pendingErrorTraces = [];
      if (drainedActionEvents) worker.pendingActionEvents = [];
      if (drainedPromptCompositionEvents) worker.pendingPromptCompositionEvents = [];

      // Authoritative working set: the task-owned file set from git, tracked
      // locally with a generation; only the DELTA since the server's last ACK
      // goes out, one bounded chunk per tick (working-set.ts). The server
      // leases it. ~5ms shell call; only computed when a worktree exists.
      const touched = worker.worktreePath && existsSync(worker.worktreePath)
        ? computeTouchedPaths(worker.worktreePath, worker.prBaseRef)
        : undefined;
      const syncNow = Date.now();
      let workingSetDelta: ReturnType<typeof nextWorkingSetDelta> = null;
      if (touched) {
        const state = worker.workingSet = normalizeWorkingSetState(worker.workingSet ?? createWorkingSetState());
        observeWorkingSet(state, { paths: touched.paths, trustRemovals: touched.complete });
        workingSetDelta = nextWorkingSetDelta(state, { now: syncNow });
      }
      // Diagnostic sample for the dashboard (bounded server-side), and what a
      // server predating `workingSet` leases from. Never the cumulative list.
      const touchedPaths = workingSetDelta?.add;
      // Ship checkpoints whose coverage could not be proven while the server
      // was unreachable: drained here, restored below if this PATCH fails too.
      const drainedShipReports = worker.pendingShipReports?.length ? worker.pendingShipReports : null;
      if (drainedShipReports) worker.pendingShipReports = [];
      // Live sibling conflict probe results (sibling-probe.ts), same drain/restore.
      const drainedProbeResults = worker.pendingSiblingProbeResults?.length ? worker.pendingSiblingProbeResults : null;
      if (drainedProbeResults) worker.pendingSiblingProbeResults = [];
      // Refresh an unresolvable base ref outside the hot hook, throttled and
      // async (never blocks this loop); the next tick measures against it.
      if (touched && !touched.baseResolved && worker.prBaseRef && worker.worktreePath
        && Date.now() - (worker.pathSweepBaseFetchedAt ?? 0) > BASE_REFRESH_INTERVAL_MS) {
        worker.pathSweepBaseFetchedAt = Date.now();
        void refreshBaseRef(worker.worktreePath, worker.prBaseRef);
      }
      // Dirty-worktree signal for the complete_task gate — see computeDirtyWorktree.
      const dirtyWorktree = worker.worktreePath && existsSync(worker.worktreePath)
        ? computeDirtyWorktree(worker.worktreePath)
        : undefined;

      // Degraded path-claim calls since the last successful sync: the server's
      // declaration denominator (conflict-aware-orchestration.md §3), split by
      // cause so a timeout is never reported as a backend outage.
      const degradedTotal = worker.pathClaimDegraded ?? 0;
      const degradedDelta = degradedTotal - (worker.pathClaimDegradedReported ?? 0);
      const byCause = worker.pathClaimDegradedByCause ?? { timeout: 0, error: 0 };
      const byCauseReported = worker.pathClaimDegradedByCauseReported ?? { timeout: 0, error: 0 };
      const byCauseDelta = { timeout: byCause.timeout - byCauseReported.timeout, error: byCause.error - byCauseReported.error };

      const update: Parameters<BuilddClient['updateWorker']>[1] = {
        status: worker.status === 'waiting' ? 'waiting_input' : 'running',
        currentAction: worker.currentAction,
        milestones,
        ...(gitChanged ? { lastCommitSha: gitFacts!.lastCommitSha, commitCount: gitFacts!.commitCount } : {}),
        localUiUrl: this.ctx.config.localUiUrl,
        // Re-send on every tick so a workers.branch row corrupted by a prior
        // (now-fixed, #2305) redaction bug self-heals within one sync interval
        // instead of staying stuck until the worker is killed and restarted on
        // a fresh branch — this local value is the actual checked-out branch,
        // set once at startup and never itself corrupted.
        ...(worker.branch ? { branch: worker.branch } : {}),
        ...(activeProgress.length > 0 ? { taskProgress: activeProgress } : {}),
        ...(drainedMcpCalls ? { appendMcpCalls: drainedMcpCalls } : {}),
        ...(drainedErrorTraces ? { appendErrorTraces: drainedErrorTraces } : {}),
        ...(drainedActionEvents ? { appendActionEvents: drainedActionEvents } : {}),
        ...(drainedPromptCompositionEvents ? { appendPromptCompositionEvents: drainedPromptCompositionEvents } : {}),
        // The working-set delta (leases) and the same paths as the observed
        // sample. The hook's own `pendingPaths` queue is runner-local now: a
        // path written while the claim endpoint was unreachable shows up in the
        // git sweep and is leased through this delta instead.
        ...(workingSetDelta ? { workingSet: workingSetDelta } : {}),
        ...(touchedPaths && touchedPaths.length > 0 ? { touchedPaths } : {}),
        ...(drainedShipReports ? { shipCheckpoints: drainedShipReports } : {}),
        ...(drainedProbeResults ? { siblingProbeResults: drainedProbeResults } : {}),
        // This runner can run a merge-tree probe against a live sibling's branch.
        siblingProbe: true,
        ...(dirtyWorktree !== undefined ? { dirtyWorktree } : {}),
        ...(degradedDelta > 0 ? { pathClaimDegraded: degradedDelta } : {}),
        ...(byCauseDelta.timeout > 0 || byCauseDelta.error > 0
          ? { pathClaimDegradedByCause: { ...(byCauseDelta.timeout > 0 ? { timeout: byCauseDelta.timeout } : {}), ...(byCauseDelta.error > 0 ? { error: byCauseDelta.error } : {}) } }
          : {}),
        // This loop is the one real consumer of the human-instruction queue:
        // it injects `response.instructions` into the live session. Declaring it
        // is what stops every other PATCH (milestones, branch, status) from
        // draining the queue and throwing an undelivered instruction away.
        consumeInstructions: true,
        // ...and it speaks ids: served `instructionIds` are echoed back on
        // injection (delivered) and again once the turn reads them (acknowledged).
        consumer: 'runner',
      } as Parameters<BuilddClient['updateWorker']>[1] & { consumeInstructions?: boolean; consumer?: 'runner' };
      if (worker.status === 'waiting' && worker.waitingFor) {
        update.waitingFor = worker.waitingFor.type === 'question'
          // Keep the question brief (context, per-option consequence, recommended, where).
          ? questionPayload(worker.waitingFor) as any
          : {
              type: worker.waitingFor.type,
              prompt: worker.waitingFor.prompt,
              options: worker.waitingFor.options?.map((o: any) => typeof o === 'string' ? o : o.label),
            };
      }
      let response: Awaited<ReturnType<BuilddClient['updateWorker']>>;
      try {
        response = await this.ctx.buildd.updateWorker(worker.id, update);
      } catch (err) {
        // Sync failed — put the drained entries back at the front so the next
        // sync ships them. (The outbox handles retry for the rest of the payload.)
        if (drainedMcpCalls) worker.pendingMcpCalls = [...drainedMcpCalls, ...(worker.pendingMcpCalls ?? [])];
        if (drainedErrorTraces) worker.pendingErrorTraces = [...drainedErrorTraces, ...(worker.pendingErrorTraces ?? [])];
        if (drainedActionEvents) worker.pendingActionEvents = [...drainedActionEvents, ...(worker.pendingActionEvents ?? [])];
        if (drainedPromptCompositionEvents) worker.pendingPromptCompositionEvents = [...drainedPromptCompositionEvents, ...(worker.pendingPromptCompositionEvents ?? [])];
        if (drainedShipReports) worker.pendingShipReports = [...drainedShipReports, ...(worker.pendingShipReports ?? [])];
        if (drainedProbeResults) worker.pendingSiblingProbeResults = [...drainedProbeResults, ...(worker.pendingSiblingProbeResults ?? [])];
        throw err;
      }

      this.lastSyncedAt.set(worker.id, Date.now());
      if (gitChanged) this.reportedGit.set(worker.id, { lastCommitSha: gitFacts!.lastCommitSha, commitCount: gitFacts!.commitCount });
      worker.pathClaimDegradedReported = degradedTotal;
      worker.pathClaimDegradedByCauseReported = { ...byCause };

      // Fold the server's ACK into the tracker: what it now holds for us, what
      // a sibling blocked. No ACK (an older server) leaves the delta pending,
      // so it is re-offered next tick rather than assumed held.
      let collision: PathCollision | null = null;
      if (workingSetDelta && worker.workingSet) {
        const ack = readWorkingSetAck(response);
        if (ack) {
          applyWorkingSetAck(worker.workingSet, workingSetDelta, ack, syncNow);
          const blocked = worker.workingSet.blocked[0];
          if (blocked) collision = blockedToCollision(blocked, 'sync', syncNow);
        }
      }
      // A path this sync reported is held by another live task. In enforce mode
      // that stops the task (checkpoint + deferral, in WorkerManager); advisory
      // mode leaves it to the §6d overlap message the server already sent.
      collision = collision ?? firstCollision(response, 'sync');
      if (collision) {
        if (worker.pathClaimMode === 'enforce' && !worker.pathCollision) {
          worker.pathCollision = collision;
          this.ctx.onPathCollision?.(worker, collision);
        } else if (worker.pathClaimMode !== 'enforce') {
          console.log(`[Worker ${worker.id}] Path-claim advisory: ${collision.path} is held by ${collision.blockingTaskId}`);
        }
      }

      // Server says worker was already terminated
      if (response?.abort) {
        // If the server says the worker already completed (or has deliverables),
        // this is just a race with the agent's complete_task call — NOT a real abort.
        // Accept the server's completion state and let the SDK session finish naturally.
        if (response.actualStatus === 'completed' || response.hasDeliverables) {
          console.log(`[Worker ${worker.id}] Server confirms completed (sync race) — skipping abort`);
          worker.status = 'done';
          worker.completedAt = worker.completedAt || Date.now();
          this.ctx.emit({ type: 'worker_update', worker });
          return;
        }

        // A conflict the server did not explain is NOT a termination. It used to
        // be a lost update on the server's worker-row compare-and-swap (two
        // in-flight PATCHes for the same live worker), and treating it as an
        // abort hard-killed healthy sessions ~1s after they started, with 0
        // turns of real work. Only hard-abort when the server names a terminal
        // cause; otherwise re-sync and let the next cycle settle it.
        const statedTerminal = typeof response.actualStatus === 'string'
          && SERVER_TERMINAL_STATUSES.has(response.actualStatus);
        const hasStatedCause = statedTerminal
          || (typeof response.reason === 'string' && response.reason.length > 0);
        if (response.retryable === true || !hasStatedCause) {
          console.warn(
            `[Worker ${worker.id}] Server reported a conflict with no terminal cause ` +
            `(actualStatus=${response.actualStatus ?? 'unknown'}) — re-syncing instead of aborting`,
          );
          sessionLog(worker.id, 'warn', 'sync_conflict_retry',
            `Unexplained server conflict (actualStatus=${response.actualStatus ?? 'unknown'}) — keeping session alive and re-syncing`);
          this.markDirty(worker.id);
          return;
        }

        // Genuinely terminated (reassigned, admin killed, stale cleanup, etc.)
        console.log(`[Worker ${worker.id}] Server says worker terminated: ${response.reason}`);
        worker.status = 'error';
        worker.error = response.reason || 'Terminated by server';
        worker.completedAt = worker.completedAt || Date.now();
        this.ctx.emit({ type: 'worker_update', worker });
        await this.ctx.abort(worker.id);
        return;
      }

      // Probes the server handed this runner: run in the background, reported next sync.
      void enqueueSiblingProbes(worker, response?.siblingProbes)?.catch(err =>
        console.warn(`[Worker ${worker.id}] sibling probe failed:`, err));

      // Report human text that reached the session through another path (Pusher
      // command, local /message endpoint) so the server can mark it delivered.
      const newestUserTs = this.latestUserMessageTs(worker);
      const seenUserTs = this.lastSeenUserMessageTs.get(worker.id);
      if (seenUserTs === undefined) {
        this.lastSeenUserMessageTs.set(worker.id, newestUserTs);
      } else if (newestUserTs > seenUserTs) {
        this.lastSeenUserMessageTs.set(worker.id, newestUserTs);
        const foreign = ((worker.messages ?? []) as Array<{ type?: string; content?: string; timestamp?: number }>)
          .filter(m => m?.type === 'user' && typeof m.content === 'string' && (m.timestamp ?? 0) > seenUserTs);
        for (const msg of foreign) {
          await this.confirmInstructionDelivery(worker.id, msg.content as string);
        }
      }

      // Process any pending instructions from sync response
      if (response?.instructions) {
        // `instructionsAck` is the queued human text, served as the prefix of the
        // payload (mission notes are appended after it).
        const ackText: string | null = typeof response.instructionsAck === 'string'
          ? response.instructionsAck
          : null;
        // The same urgent instruction can arrive twice: instantly over Pusher and
        // again from the queue that backs it up. Text already in this session's
        // transcript is confirmed rather than replayed to the agent.
        const duplicatePrefix = !!ackText
          && response.instructions.startsWith(ackText)
          && this.alreadyInjected(worker, ackText);
        const toInject = duplicatePrefix && ackText
          ? response.instructions.slice(ackText.length)
          : response.instructions;
        // History ids of the served messages (+ served mission-note ids).
        const ids: string[] = Array.isArray(response.instructionIds)
          ? (response.instructionIds as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];

        let delivered = true;
        if (toInject.trim().length > 0) {
          delivered = (await this.ctx.sendMessage(worker.id, toInject, ids)) !== false;
          // Our own injection must not be re-reported as a foreign delivery on
          // the next cycle.
          if (delivered) this.lastSeenUserMessageTs.set(worker.id, this.latestUserMessageTs(worker));
        }
        // Only a real injection may clear the server-side queue. A failed
        // sendMessage leaves it queued, and the next sync retries it.
        if (delivered) {
          await this.confirmInstructionDelivery(worker.id, ackText, ids);
        }
      }

      // Worker→worker messages: on a runner-managed worker this loop is their
      // only consumer too (the agent's own MCP check-ins are not served them),
      // so they reach the agent at its next turn boundary like human text.
      // Rendered, injected, then acked by id; an unacked one is served again.
      const workerMessages = Array.isArray(response?.pendingMessages)
        ? (response.pendingMessages as WorkerMessage[]).filter(m => m && typeof m.id === 'string')
        : [];
      if (workerMessages.length > 0) {
        const injected = (await this.ctx.sendMessage(worker.id, formatWorkerMessages(workerMessages))) !== false;
        if (injected) {
          this.lastSeenUserMessageTs.set(worker.id, this.latestUserMessageTs(worker));
          try {
            await this.ctx.buildd.updateWorker(worker.id, { workerMessagesDelivered: workerMessages.map(m => m.id) } as any);
          } catch {
            // Unconfirmed: served again on the next sync.
          }
        }
      }
    } catch (err) {
      // Silently ignore sync errors
    }
  }

  /**
   * Mark a worker as needing sync on next interval.
   */
  markDirty(workerId: string) {
    this.ctx.dirtyWorkers.add(workerId);
  }

  /**
   * Sync one worker now: the `deliver_pending` wake-up, sent (text-free) when a
   * message is queued for it, so delivery does not wait for its next
   * activity-driven sync.
   */
  async requestSync(workerId: string) {
    const worker = this.ctx.workers.get(workerId);
    if (!worker || !(worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting')) return;
    this.ctx.dirtyWorkers.delete(workerId);
    await this.syncWorkerToServer(worker);
  }

  /**
   * Sync only dirty worker states to server.
   * Always includes waiting workers so they can pick up pendingInstructions.
   * Called on a 10s timer.
   */
  async syncToServer(now: number = Date.now()) {
    for (const [id, worker] of this.ctx.workers) {
      // Always sync waiting workers so they can pick up pendingInstructions
      // (answers to AskUserQuestion) even if Pusher delivery fails.
      if (worker.status === 'waiting') {
        this.ctx.dirtyWorkers.add(id);
      // A working worker inside one long silent tool call is not dirty and
      // would never collect a queued message. Without Pusher (or a missed
      // deliver_pending) this is what bounds delivery: at most ~30s.
      } else if (worker.status === 'working' && now - (this.lastSyncedAt.get(id) ?? 0) >= QUIET_SYNC_INTERVAL_MS) {
        this.ctx.dirtyWorkers.add(id);
      }
    }

    if (this.ctx.dirtyWorkers.size === 0) return;
    const toSync = new Set(this.ctx.dirtyWorkers);
    this.ctx.dirtyWorkers.clear();
    try {
      for (const workerId of toSync) {
        const worker = this.ctx.workers.get(workerId);
        if (worker && (worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting')) {
          await this.syncWorkerToServer(worker);
        }
      }
    } catch {
      // Silently ignore sync errors - server may be temporarily unreachable
    }
  }

  /**
   * Evict completed/failed workers from in-memory Map after 10 minutes
   * to prevent unbounded memory growth during long-running sessions.
   * Workers remain on disk (24h TTL) so getWorkers() can still serve them.
   */
  evictCompletedWorkers() {
    const RETENTION_MS = TERMINAL_WORKER_RETENTION_MS;
    const now = Date.now();
    for (const [id, worker] of this.ctx.workers.entries()) {
      // Abandoned `waiting` workers are NEVER evicted from memory/disk (kept for
      // history + possible resume), so their worktree would otherwise leak
      // forever. Reclaim the worktree (only) once the worker has been idle past
      // the 24h TTL; the worker record itself is preserved. Clearing
      // worktreePath prevents re-attempting removal on later cycles.
      if (worker.status === 'waiting') {
        if (
          now - worker.lastActivity >= WAITING_WORKTREE_TTL_MS &&
          worker.worktreePath &&
          existsSync(worker.worktreePath)
        ) {
          if (isWorktreePathOwnedByOtherLiveWorker(this.ctx.workers, worker.worktreePath, id)) {
            sessionLog(id, 'info', 'waiting_worktree_reclaim_skipped', 'Skipped TTL reclaim: worktree path is now owned by another active worker');
          } else {
            // Guarded removal: a waiting worker's tree can hold commits that
            // exist nowhere else. protectUnpushed refuses those (fail-closed);
            // a refused tree is left for the doctor reaper, which is the cheap
            // side of being wrong.
            const worktreePath = worker.worktreePath;
            removeWorktreeIfUnowned({
              repoPath: repoPathFromWorktree(worktreePath),
              worktreePath,
              workerId: id,
              workers: this.ctx.workers,
              branch: worker.branch,
              protectUnpushed: true,
            }).then(outcome => {
              if (outcome.removed) {
                sessionLog(id, 'info', 'waiting_worktree_reclaimed', `Reclaimed worktree of abandoned waiting worker after ${Math.round(WAITING_WORKTREE_TTL_MS / 3600000)}h TTL`);
              }
            }).catch(err => {
              console.error(`[Worker ${id}] Waiting worktree TTL cleanup failed:`, err);
            });
          }
          worker.worktreePath = undefined;
        }
        continue; // never evict waiting workers from memory
      }

      // Fast eviction for: E2E test workers, and workers that failed within 30s (e.g., quota errors)
      const sessionDuration = worker.completedAt ? worker.completedAt - (worker.startedAt || worker.completedAt) : Infinity;
      const isQuickFailure = worker.status === 'error' && sessionDuration < 30_000;
      const retention = isEphemeralTestBranch(worker.branch) || isQuickFailure ? 0 : RETENTION_MS;
      if (
        (worker.status === 'done' || worker.status === 'error') &&
        now - worker.lastActivity >= retention
      ) {
        // Clean up worktree if it still exists (completed workers keep worktree for resume).
        // Worktree paths are branch-keyed, so a retry on the same task can already be
        // checked out at this exact path by the time this (older, failed) worker's
        // retention window elapses — skip cleanup rather than deleting a live worktree
        // out from under an active worker.
        if (worker.worktreePath && existsSync(worker.worktreePath)) {
          if (isWorktreePathOwnedByOtherLiveWorker(this.ctx.workers, worker.worktreePath, id)) {
            sessionLog(id, 'info', 'eviction_worktree_cleanup_skipped', 'Skipped worktree cleanup on eviction: path is now owned by another active worker');
          } else {
            removeWorktreeIfUnowned({
              repoPath: repoPathFromWorktree(worker.worktreePath),
              worktreePath: worker.worktreePath,
              workerId: id,
              workers: this.ctx.workers,
              branch: worker.branch,
              protectUnpushed: true,
            }).catch(err => {
              console.error(`[Worker ${id}] Eviction worktree cleanup failed:`, err);
            });
          }
        }
        sessionLog(id, 'info', 'worker_evicted', `Evicted from memory after retention period (status: ${worker.status})`);
        this.ctx.workers.delete(id);
        teardownSession(this.ctx.sessions, id);
        this.lastSeenUserMessageTs.delete(id);
        this.gitObservations.delete(id);
        this.reportedGit.delete(id);
        // Every terminal worker passes through here before leaving memory —
        // whether it already unsubscribed via an explicit abort (redundant,
        // idempotent no-op) or never did (normal completion, auth failure,
        // budget exceeded, server refusal, reconciliation, markDone — none of
        // those touch Pusher). This is the one unconditional teardown point.
        try {
          this.ctx.unsubscribeFromWorker(id);
        } catch (err) {
          console.error(`[Worker ${id}] Failed to unsubscribe Pusher channel on eviction:`, err);
        }
        // Note: NOT deleting from disk — workers persist for 24h for history
      }
    }
  }

  /**
   * Detect stale workers and apply graduated recovery:
   * 1. First, send a soft probe message
   * 2. If still unresponsive after probe, abort the worker
   * 3. Hard timeout (30min) aborts any idle worker regardless of state
   */
  checkStale() {
    const now = Date.now();
    const timeout = this.ctx.getAdaptiveStaleTimeout();
    // Hard absolute timeout: no worker process should run longer than 30 minutes
    // without producing activity. This catches zombie processes that ignore probes.
    // The timer resets on ANY SDK message (tool calls, text, MCP calls like update_progress)
    // because handleMessage() updates worker.lastActivity on every message.
    // So an agent actively reporting progress via update_progress will never hit this.
    // Shared with the server's reap threshold (WORKER_STALE_REAP_MS is derived
    // from this) so the two can never drift apart again.
    const HARD_TIMEOUT_MS = WORKER_HARD_TIMEOUT_MS;

    for (const worker of this.ctx.workers.values()) {
      // Post-completion watchdog: the worker record is already terminal, but
      // its SDK session is still alive (e.g. complete_task returned and then
      // the process hung on a stuck tool/MCP call). Reap the session once it
      // has outlived a grace period past completion — but never touch the
      // worker record or call the server: the worker already legitimately
      // finished, and ctx.abort()/a PATCH here would misreport a real
      // completion as a failure.
      if (worker.status === 'done' || worker.status === 'error') {
        //
        // Two stages. First abort and leave the map entry: the session's own
        // finally block needs it to clean up credentials/config dirs, and
        // `reapedAt` tells its catch path not to report a failure. Only if the
        // entry is STILL there a full grace period later (the process ignored
        // the abort, so finally never ran) is it dropped outright.
        const session = this.ctx.sessions.get(worker.id);
        if (session) {
          if (session.reapedAt === undefined) {
            const referenceTs = worker.completedAt ?? worker.lastActivity;
            const idleMs = now - referenceTs;
            if (idleMs > POST_COMPLETION_SESSION_GRACE_MS) {
              sessionLog(worker.id, 'warn', 'post_completion_session_reaped',
                `Reaping live SDK session ${Math.round(idleMs / 1000)}s after worker reached status=${worker.status}`);
              reapSession(session, now, worker.id);
            }
          } else if (now - session.reapedAt > POST_COMPLETION_SESSION_GRACE_MS) {
            sessionLog(worker.id, 'warn', 'post_completion_session_dropped',
              `Session ignored abort for ${Math.round((now - session.reapedAt) / 1000)}s — dropping its entry`);
            teardownSession(this.ctx.sessions, worker.id);
          }
        }
        continue;
      }

      // Skip stale check for workers waiting on user input (plan approval, questions)
      if (worker.status === 'waiting') continue;

      // Hard timeout: kill any worker (working or stale) that has been idle too long
      if ((worker.status === 'working' || worker.status === 'stale') &&
          now - worker.lastActivity > HARD_TIMEOUT_MS) {
        const idleSec = Math.round((now - worker.lastActivity) / 1000);
        console.log(`[Worker ${worker.id}] Hard timeout — idle ${idleSec}s, aborting`);
        sessionLog(worker.id, 'warn', 'hard_timeout', `Aborting after ${idleSec}s idle (hard timeout ${HARD_TIMEOUT_MS / 1000}s)`);
        this.ctx.probedWorkers.delete(worker.id);
        this.ctx.abort(worker.id, `Hard timeout: idle ${idleSec}s`).catch(() => {});
        continue;
      }

      // Skip the soft-probe/stale-abort path while a tool/subagent call is in
      // flight. Long silent tools (e.g. a bash waiting on CI) emit no SDK stream
      // messages and would otherwise trip the adaptive timeout and get a HEALTHY
      // session aborted mid-tool-call. The 30-min hard timeout above still fires
      // regardless of toolInFlight, backstopping genuinely dead sessions.
      if (worker.status === 'working' && !worker.toolInFlight) {
        if (now - worker.lastActivity > timeout) {
          // Graduated recovery: if session is still alive, try a soft probe first
          const session = this.ctx.sessions.get(worker.id);
          if (session && !this.ctx.probedWorkers.has(worker.id)) {
            this.ctx.probedWorkers.add(worker.id);
            console.log(`[Worker ${worker.id}] Idle ${Math.round((now - worker.lastActivity) / 1000)}s — sending soft probe before marking stale`);
            try {
              session.inputStream.enqueue(this.ctx.buildUserMessage(
                'You appear to have stalled. If you are still working, continue. If you are stuck, summarize what you have done and finish.',
                { sessionId: worker.sessionId },
              ));
              worker.lastActivity = now;  // Give it another cycle to respond
              worker.currentAction = 'Probed (idle recovery)';
              this.ctx.addMilestone(worker, { type: 'status', label: 'Idle probe sent', ts: now });
              this.ctx.emit({ type: 'worker_update', worker });
            } catch {
              // Session stream closed — abort the worker
              console.log(`[Worker ${worker.id}] Probe failed (stream closed) — aborting`);
              this.ctx.probedWorkers.delete(worker.id);
              this.ctx.abort(worker.id, 'Stale: probe failed (stream closed)').catch(() => {});
            }
          } else {
            // Already probed or no session — abort the worker (not just mark stale)
            const idleSec = Math.round((now - worker.lastActivity) / 1000);
            console.log(`[Worker ${worker.id}] Stale after probe — idle ${idleSec}s, aborting`);
            sessionLog(worker.id, 'warn', 'stale_abort', `Aborting after probe failed — idle ${idleSec}s`);
            this.ctx.probedWorkers.delete(worker.id);
            this.ctx.abort(worker.id, `Stale: no response to probe after ${idleSec}s`).catch(() => {});
          }
        }
      }
    }
  }

  /**
   * Record a completed worker's cycle time and recalculate adaptive stale timeout.
   * Uses median of recent cycle times to set timeout at 50% of typical duration,
   * bounded between 5 and 10 minutes.
   */
  recordCycleTime(worker: LocalWorker) {
    const duration = (worker.completedAt || Date.now()) - worker.startedAt;
    if (duration <= 0) return;

    this.ctx.recentCycleTimes.push(duration);
    // Keep last 20 cycle times
    if (this.ctx.recentCycleTimes.length > 20) {
      this.ctx.recentCycleTimes.shift();
    }

    // Need at least 3 samples before adapting
    if (this.ctx.recentCycleTimes.length < 3) return;

    // Median of recent cycle times
    const sorted = [...this.ctx.recentCycleTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Timeout = 50% of median cycle time (workers that go silent for half their
    // typical total runtime are likely stuck), bounded [5 min, 10 min]. The 5-min
    // floor sits above common legit silent operations (CI polling, large installs)
    // so healthy workers aren't probed/aborted during them.
    const newTimeout = Math.max(300_000, Math.min(600_000, Math.round(median * 0.5)));

    // Only adjust on >20% change to prevent thrashing
    const currentTimeout = this.ctx.getAdaptiveStaleTimeout();
    if (Math.abs(newTimeout - currentTimeout) / currentTimeout > 0.2) {
      console.log(`[Adaptive timeout] ${Math.round(currentTimeout / 1000)}s → ${Math.round(newTimeout / 1000)}s (median cycle: ${Math.round(median / 1000)}s, samples: ${this.ctx.recentCycleTimes.length})`);
      this.ctx.setAdaptiveStaleTimeout(newTimeout);
    }
  }
}
