import type { LocalWorker, CheckpointEventType } from './types';
import type { BuilddClient } from './buildd';
import type { LocalUIConfig } from './types';
import { existsSync } from 'fs';
import { join } from 'path';
import { saveWorker as storeSaveWorker, loadAllWorkers } from './worker-store';
import { cleanupWorktree } from './git-operations';
import { sessionLog } from './session-logger';

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
  sessions: Map<string, { inputStream: any; abortController: AbortController }>;
  dirtyWorkers: Set<string>;
  dirtyForDisk: Set<string>;
  emit: (event: any) => void;
  abort: (workerId: string, reason?: string) => Promise<void>;
  sendMessage: (workerId: string, message: string) => Promise<void>;
  /** Adaptive stale timeout getter (may be updated externally) */
  getAdaptiveStaleTimeout: () => number;
  setAdaptiveStaleTimeout: (ms: number) => void;
  recentCycleTimes: number[];
  probedWorkers: Set<string>;
  addMilestone: (worker: LocalWorker, milestone: any) => void;
  buildUserMessage: (content: string, opts?: { sessionId?: string }) => any;
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
  constructor(private ctx: WorkerSyncContext) {}

  /**
   * Restore workers from disk on startup.
   * Workers with active status are marked as errored since we can't resume SDK sessions.
   * Exception: 'waiting' workers keep their status for sendMessage()-based resume.
   */
  restoreWorkersFromDisk() {
    try {
      const restored = loadAllWorkers();
      const needsReconciliation: LocalWorker[] = [];
      for (const worker of restored) {
        // Workers with active status can't be resumed (no SDK session/inputStream).
        // Exception: 'waiting' workers keep their status so the user can still answer —
        // sendMessage() will detect waiting+no-session and restart via resumeSession().
        if (worker.status === 'working' || worker.status === 'stale') {
          // Don't immediately fail — the task may have completed on the server
          // (e.g. agent called complete_task but runner restarted before local state updated).
          // Mark as stale so reconciliation can check the server before deciding.
          worker.status = 'stale';
          worker.currentAction = 'Checking server after restart...';
          needsReconciliation.push(worker);
        }
        // Ensure arrays exist (workers saved before these features were added)
        if (!worker.checkpoints) worker.checkpoints = [];
        if (!worker.subagentTasks) worker.subagentTasks = [];
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
      if (restored.length > 0) {
        console.log(`[WorkerStore] Restored ${restored.length} worker(s) from disk`);
      }
      // Reconcile interrupted workers against server state before failing them
      if (needsReconciliation.length > 0) {
        console.log(`[WorkerStore] ${needsReconciliation.length} interrupted worker(s) — checking server before marking failed`);
        this.reconcileInterruptedWorkers(needsReconciliation);
      }
    } catch (err) {
      console.error('[WorkerStore] Failed to restore workers from disk:', err);
    }
  }

  /**
   * Check interrupted workers against the server to self-heal status.
   * If the server says completed, adopt success. Otherwise, mark as failed.
   * Runs async but with a timeout — we don't want to block startup forever.
   */
  private reconcileInterruptedWorkers(workers: LocalWorker[]) {
    const TIMEOUT_MS = 10_000;

    const check = async () => {
      for (const worker of workers) {
        try {
          const remote = await this.ctx.buildd.getWorkerRemote(worker.id);

          if (remote) {
            const isCompleted = remote.status === 'completed' ||
              remote.task?.status === 'completed';

            if (isCompleted) {
              console.log(`[WorkerStore] Worker ${worker.id} (${worker.taskTitle}) completed on server — self-healing to done`);
              worker.status = 'done';
              worker.completedAt = worker.completedAt || Date.now();
              worker.currentAction = 'Completed (confirmed by server after restart)';
              this.ctx.dirtyForDisk.add(worker.id);
              this.ctx.emit({ type: 'worker_update', worker });
              continue;
            }
          }

          // Server says not completed (or unreachable) — mark as failed
          console.log(`[WorkerStore] Worker ${worker.id} (${worker.taskTitle}) not completed on server — marking failed`);
          worker.status = 'error';
          worker.error = 'Process restarted';
          worker.completedAt = worker.completedAt || Date.now();
          worker.currentAction = 'Process restarted';
          this.ctx.dirtyForDisk.add(worker.id);
          this.ctx.emit({ type: 'worker_update', worker });

          // Notify server so it doesn't stay "running" forever
          this.ctx.buildd.updateWorker(worker.id, {
            status: 'failed',
            error: 'Process restarted',
          }).catch(() => {});
        } catch {
          // Network error — fail safe, mark as error
          worker.status = 'error';
          worker.error = 'Process restarted (server unreachable)';
          worker.completedAt = worker.completedAt || Date.now();
          worker.currentAction = 'Process restarted';
          this.ctx.dirtyForDisk.add(worker.id);
          this.ctx.emit({ type: 'worker_update', worker });

          this.ctx.buildd.updateWorker(worker.id, {
            status: 'failed',
            error: 'Process restarted',
          }).catch(() => {});
        }
      }
    };

    // Race against timeout — if server is slow, fail workers rather than leaving them stale
    Promise.race([
      check(),
      new Promise<void>(resolve => setTimeout(() => {
        // Timeout: fail any workers still in 'stale' status
        for (const worker of workers) {
          if (worker.status === 'stale') {
            console.log(`[WorkerStore] Timeout checking worker ${worker.id} — marking failed`);
            worker.status = 'error';
            worker.error = 'Process restarted (reconciliation timeout)';
            worker.completedAt = worker.completedAt || Date.now();
            worker.currentAction = 'Process restarted';
            this.ctx.dirtyForDisk.add(worker.id);
            this.ctx.emit({ type: 'worker_update', worker });

            this.ctx.buildd.updateWorker(worker.id, {
              status: 'failed',
              error: 'Process restarted',
            }).catch(() => {});
          }
        }
        resolve();
      }, TIMEOUT_MS)),
    ]).catch(err => {
      console.error('[WorkerStore] Interrupted worker reconciliation failed:', err);
    });
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
      // Build milestones array, appending current in-progress phase as pending
      const milestones: any[] = worker.milestones.map(m => ({ ...m }));
      if (worker.phaseText && worker.phaseToolCount > 0) {
        milestones.push({
          type: 'phase' as const,
          label: extractPhaseLabel(worker.phaseText),
          toolCount: worker.phaseToolCount,
          ts: worker.phaseStart || Date.now(),
          pending: true,
        });
      }

      // Collect active subagent progress for dashboard visibility
      const activeProgress = worker.subagentTasks
        .filter(t => t.status === 'running' && t.progress)
        .map(t => ({
          taskId: t.taskId,
          agentName: t.progress!.agentName,
          toolCount: t.progress!.toolCount,
          durationMs: t.progress!.durationMs,
          cumulativeUsage: t.progress!.cumulativeUsage,
        }));

      const update: Parameters<BuilddClient['updateWorker']>[1] = {
        status: worker.status === 'waiting' ? 'waiting_input' : 'running',
        currentAction: worker.currentAction,
        milestones,
        localUiUrl: this.ctx.config.localUiUrl,
        ...(activeProgress.length > 0 ? { taskProgress: activeProgress } : {}),
        ...(worker.pendingMcpCalls?.length ? { appendMcpCalls: worker.pendingMcpCalls } : {}),
      };
      if (worker.status === 'waiting' && worker.waitingFor) {
        update.waitingFor = {
          type: worker.waitingFor.type,
          prompt: worker.waitingFor.prompt,
          options: worker.waitingFor.options?.map((o: any) => typeof o === 'string' ? o : o.label),
        };
      }
      const response = await this.ctx.buildd.updateWorker(worker.id, update);

      // Clear MCP call buffer after successful sync
      if (worker.pendingMcpCalls?.length) {
        worker.pendingMcpCalls = [];
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

        // Genuinely terminated (reassigned, admin killed, stale cleanup, etc.)
        console.log(`[Worker ${worker.id}] Server says worker terminated: ${response.reason}`);
        worker.status = 'error';
        worker.error = response.reason || 'Terminated by server';
        worker.completedAt = worker.completedAt || Date.now();
        this.ctx.emit({ type: 'worker_update', worker });
        await this.ctx.abort(worker.id);
        return;
      }

      // Process any pending instructions from sync response
      if (response?.instructions) {
        await this.ctx.sendMessage(worker.id, response.instructions);
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
   * Sync only dirty worker states to server.
   * Always includes waiting workers so they can pick up pendingInstructions.
   * Called on a 10s timer.
   */
  async syncToServer() {
    // Always sync waiting workers so they can pick up pendingInstructions
    // (answers to AskUserQuestion) even if Pusher delivery fails.
    for (const [id, worker] of this.ctx.workers) {
      if (worker.status === 'waiting') {
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
    const RETENTION_MS = 10 * 60 * 1000;
    const now = Date.now();
    for (const [id, worker] of this.ctx.workers.entries()) {
      // Fast eviction for: E2E test workers, and workers that failed within 30s (e.g., quota errors)
      const sessionDuration = worker.completedAt ? worker.completedAt - (worker.startedAt || worker.completedAt) : Infinity;
      const isQuickFailure = worker.status === 'error' && sessionDuration < 30_000;
      const retention = isEphemeralTestBranch(worker.branch) || isQuickFailure ? 0 : RETENTION_MS;
      if (
        (worker.status === 'done' || worker.status === 'error') &&
        now - worker.lastActivity >= retention
      ) {
        // Clean up worktree if it still exists (completed workers keep worktree for resume)
        if (worker.worktreePath && existsSync(worker.worktreePath)) {
          const worktreeMarker = join('.buildd-worktrees', '');
          const worktreeIdx = worker.worktreePath.indexOf(worktreeMarker);
          const repoPath = worktreeIdx > 0
            ? worker.worktreePath.substring(0, worktreeIdx)
            : worker.worktreePath;
          cleanupWorktree(repoPath, worker.worktreePath, id).catch(err => {
            console.error(`[Worker ${id}] Eviction worktree cleanup failed:`, err);
          });
        }
        sessionLog(id, 'info', 'worker_evicted', `Evicted from memory after retention period (status: ${worker.status})`);
        this.ctx.workers.delete(id);
        this.ctx.sessions.delete(id);
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
    const HARD_TIMEOUT_MS = 30 * 60 * 1000;

    for (const worker of this.ctx.workers.values()) {
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

      if (worker.status === 'working') {
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
   * bounded between 2 and 10 minutes.
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
    // typical total runtime are likely stuck), bounded [2 min, 10 min]
    const newTimeout = Math.max(120_000, Math.min(600_000, Math.round(median * 0.5)));

    // Only adjust on >20% change to prevent thrashing
    const currentTimeout = this.ctx.getAdaptiveStaleTimeout();
    if (Math.abs(newTimeout - currentTimeout) / currentTimeout > 0.2) {
      console.log(`[Adaptive timeout] ${Math.round(currentTimeout / 1000)}s → ${Math.round(newTimeout / 1000)}s (median cycle: ${Math.round(median / 1000)}s, samples: ${this.ctx.recentCycleTimes.length})`);
      this.ctx.setAdaptiveStaleTimeout(newTimeout);
    }
  }
}
