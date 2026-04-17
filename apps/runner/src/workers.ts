import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, LocalUIConfig, BuilddTask, WorkerCommand, ChatMessage, TeamState, Checkpoint, SubagentTask, CheckpointEventType } from './types';
import { CheckpointEvent, CHECKPOINT_LABELS } from './types';
import { BuilddClient } from './buildd';
import { createWorkspaceResolver, type WorkspaceResolver } from './workspace';
import { type SkillBundle } from '@buildd/shared';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { syncSkillToLocal } from './skills.js';
import { syncRoleToLocal, resolveRoleEnv, getRoleDir, overlayRoleFiles, type RoleConfig } from './roles.js';
import { setupWorktree, cleanupWorktree, collectGitStats } from './git-operations';
import { PusherManager } from './pusher-manager';
import { saveWorker as storeSaveWorker, loadAllWorkers, loadWorker as storeLoadWorker, deleteWorker as storeDeleteWorker } from './worker-store';
import { scanEnvironment, checkMcpPreFlight } from './env-scan';
import { sessionLog, cleanupOldLogs, readSessionLogs, claimLog } from './session-logger';
import { archiveSession } from './history-store';
import { extractTenantContext, decryptTenantSecret } from './tenant-crypto';
import type { WorkerEnvironment } from '@buildd/shared';
import {
  resolveBypassPermissions,
  resolveMaxBudgetUsd,
  resolveMaxTurns,
  discoverModelCapabilities,
  buildPrompt,
  buildSessionSummary,
  generatePromptSuggestions,
  extractFilesFromToolCalls,
} from './prompt-builder';
import { HookFactory } from './hook-factory';
import { RecoveryManager } from './recovery';
import { WorkerSync, extractPhaseLabel, isEphemeralTestBranch } from './worker-sync';
// Re-export for backwards compatibility (tests import from './workers')
export { isEphemeralTestBranch };

type EventHandler = (event: any) => void;
type CommandHandler = (workerId: string, command: WorkerCommand) => void;

// Async message stream for multi-turn conversations
class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;

  enqueue(message: SDKUserMessage) {
    if (this.done) {
      console.log(`[MessageStream] ⚠️ enqueue called after stream ended — parent_tool_use_id=${message.parent_tool_use_id}`);
      return;
    }
    const hasWaiter = this.resolvers.length > 0;
    console.log(`[MessageStream] enqueue: parent_tool_use_id=${message.parent_tool_use_id}, session_id=${message.session_id?.slice(0, 12) || '(empty)'}, hasWaiter=${hasWaiter}`);
    if (hasWaiter) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  end() {
    this.done = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined as any, done: true });
    }
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise(resolve => {
          this.resolvers.push(resolve);
        });
      }
    };
  }
}

// Build a user message for the SDK
function buildUserMessage(
  content: string | Array<{ type: string; text?: string; source?: any }>,
  opts?: { parentToolUseId?: string; sessionId?: string },
): SDKUserMessage {
  const messageContent = typeof content === 'string'
    ? [{ type: 'text' as const, text: content }]
    : content;

  return {
    type: 'user',
    session_id: opts?.sessionId || '',
    message: {
      role: 'user',
      content: messageContent as any,
    },
    parent_tool_use_id: opts?.parentToolUseId || null,
  };
}

// Worker session state
interface WorkerSession {
  inputStream: MessageStream;
  abortController: AbortController;
  cwd: string;
  repoPath: string;  // Original repo path (different from cwd when using worktrees)
  queryInstance?: ReturnType<typeof query>;  // Stored for rewindFiles() access
  generation: number;  // Session generation counter — used to detect stale post-loop cleanup
}

// Constants for repetition detection
const MAX_IDENTICAL_TOOL_CALLS = 5;  // Abort after 5 identical consecutive calls
const MAX_SIMILAR_TOOL_CALLS = 8;    // Abort after 8 similar calls (same tool, same key params)

// Check if Claude Code credentials exist (OAuth or API key)
// We don't validate - just check if credentials exist
function hasClaudeCredentials(): boolean {
  // Check for OAuth credentials from `claude login` (.credentials.json)
  const credentialsPath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credentialsPath)) {
    return true;
  }

  // Check for oauthAccount in Claude state files (where OAuth is sometimes stored)
  const stateFiles = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
    join(homedir(), '.claude.json'),
  ];
  for (const statePath of stateFiles) {
    if (existsSync(statePath)) {
      try {
        const data = JSON.parse(readFileSync(statePath, 'utf-8'));
        if (data.oauthAccount?.accountUuid) {
          return true;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Check env vars
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }

  return false;
}

export class WorkerManager {
  private config: LocalUIConfig;
  private workers = new Map<string, LocalWorker>();
  private sessions = new Map<string, WorkerSession>();
  private buildd: BuilddClient;
  private resolver: WorkspaceResolver;
  private eventHandlers: EventHandler[] = [];
  private commandHandlers: CommandHandler[] = [];
  private staleCheckInterval?: Timer;
  private syncInterval?: Timer;
  private pusherManager: PusherManager;
  private hasCredentials: boolean = false;
  private acceptRemoteTasks: boolean = true;
  private cleanupInterval?: Timer;
  private heartbeatInterval?: Timer;
  private evictionInterval?: Timer;
  private diskPersistInterval?: Timer;
  private reconcileInterval?: Timer;
  private claimPollInterval?: Timer;
  private viewerToken?: string;
  private dirtyWorkers = new Set<string>();
  private dirtyForDisk = new Set<string>();
  // Circuit breaker: pause claims when quota exhausted or repeated rapid failures
  private consecutiveQuickFailures = 0;
  private claimsPaused = false;
  private claimsPausedUntil = 0;

  /**
   * Classify an error as a systemic issue that should trip the circuit breaker.
   * Returns pause config if the error affects all workers, null if worker-specific.
   */
  private classifyErrorForCircuitBreaker(err: string): { label: string; pauseMs: number } | null {
    // Quota exhaustion: "out of extra usage · resets 5pm (UTC)"
    const quotaMatch = err.match(/out of extra usage.*resets\s+(\d{1,2}(?:am|pm)?)\s*\((\w+)\)/i);
    if (quotaMatch) {
      return { label: `Quota exhausted (resets ${quotaMatch[1]} ${quotaMatch[2]})`, pauseMs: this.parseResetDelay(quotaMatch[1]) };
    }

    // Usage limit / rate limit patterns from Claude API
    if (err.includes('rate limit') || err.includes('rate_limit') || err.includes('too many requests')) {
      return { label: 'Rate limited', pauseMs: 5 * 60 * 1000 };
    }
    if (err.includes('overloaded') || err.includes('529') || err.includes('service unavailable')) {
      return { label: 'API overloaded', pauseMs: 2 * 60 * 1000 };
    }

    // Billing / credits
    if (err.includes('billing') || err.includes('insufficient credits') || err.includes('payment') || err.includes('out_of_credits')) {
      return { label: 'Billing error', pauseMs: 60 * 60 * 1000 };
    }

    // Auth failures (affect all workers using same key)
    if (err.includes('invalid api key') || err.includes('authentication failed') || err.includes('401 unauthorized') || err.includes('api key is required')) {
      return { label: 'Auth failure', pauseMs: 30 * 60 * 1000 };
    }

    // SDK budget limit (maxBudgetUsd) is per-worker — don't circuit-break.
    // The server handles account-level budget exhaustion by filtering tasks.

    return null; // Worker-specific error, no circuit breaker
  }

  /** Parse a reset time like "5pm" into ms delay from now (assumes UTC) */
  private parseResetDelay(timeStr: string): number {
    const hourMatch = timeStr.match(/^(\d{1,2})(am|pm)?$/i);
    if (!hourMatch) return 60 * 60 * 1000;

    let hour = parseInt(hourMatch[1], 10);
    const ampm = hourMatch[2]?.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(hour, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setUTCDate(target.getUTCDate() + 1);
    }

    return Math.max(5 * 60 * 1000, Math.min(target.getTime() - now.getTime(), 24 * 60 * 60 * 1000));
  }
  private environment?: WorkerEnvironment;
  private envScanInterval?: Timer;
  private hookFactory: HookFactory;
  private recoveryManager: RecoveryManager;
  private workerSync: WorkerSync;
  // Adaptive idle timeout: track recent worker durations to calibrate stale threshold
  private recentCycleTimes: number[] = [];  // Duration in ms of last N completed workers
  private adaptiveStaleTimeout: number = 300_000;  // Start at 5 min, adapt from cycle data
  // Graduated recovery: track which stale workers have been probed (avoid repeated probes)
  private probedWorkers = new Set<string>();
  private sessionGeneration = 0;
  // Pending permission request resolvers — keyed by worker ID.
  // When a PermissionRequest hook fires, we store a resolver here.
  // The UI calls resolvePermission() to complete the promise with allow/deny.
  private pendingPermissionRequests = new Map<string, {
    resolve: (result: any) => void;
    toolInput: Record<string, unknown>;
    suggestions: unknown[];
  }>();

  constructor(config: LocalUIConfig, resolver?: WorkspaceResolver) {
    this.config = config;
    this.buildd = new BuilddClient(config);
    this.resolver = resolver || createWorkspaceResolver(config.projectRoots);
    this.acceptRemoteTasks = config.acceptRemoteTasks !== false;
    this.pusherManager = new PusherManager(config, this.buildd, {
      getWorkers: () => this.workers,
      emit: (event) => this.emit(event),
      emitCommand: (workerId, command) => this.emitCommand(workerId, command),
      abort: (workerId) => this.abort(workerId),
      sendMessage: (workerId, text) => this.sendMessage(workerId, text),
      rollback: (workerId, uuid) => this.rollback(workerId, uuid),
      recover: (workerId, mode) => this.recover(workerId, mode),
      sendHeartbeat: () => this.sendHeartbeat(),
      claimPendingTasks: () => this.claimPendingTasks(),
      claimAndStart: (task) => this.claimAndStart(task),
      getProbedWorkers: () => this.probedWorkers,
    });
    this.hookFactory = new HookFactory({
      config: { inputAsRetry: config.inputAsRetry },
      buildd: this.buildd,
      addMilestone: (worker, milestone) => this.addMilestone(worker, milestone),
      emit: (event) => this.emit(event),
      pendingPermissionRequests: this.pendingPermissionRequests,
    });
    this.recoveryManager = new RecoveryManager({
      workers: this.workers,
      sessions: this.sessions,
      buildd: this.buildd,
      resolver: this.resolver,
      pendingPermissionRequests: this.pendingPermissionRequests,
      emit: (event) => this.emit(event),
      addMilestone: (worker, milestone) => this.addMilestone(worker, milestone),
      unsubscribeFromWorker: (workerId) => this.pusherManager.unsubscribeFromWorker(workerId),
      startSession: (worker, cwd, task, resumeSessionId?) => this.startSession(worker, cwd, task, resumeSessionId),
    });
    this.workerSync = new WorkerSync({
      config,
      buildd: this.buildd,
      workers: this.workers,
      sessions: this.sessions,
      dirtyWorkers: this.dirtyWorkers,
      dirtyForDisk: this.dirtyForDisk,
      emit: (event) => this.emit(event),
      abort: (workerId, reason) => this.abort(workerId, reason),
      sendMessage: (workerId, message) => this.sendMessage(workerId, message),
      getAdaptiveStaleTimeout: () => this.adaptiveStaleTimeout,
      setAdaptiveStaleTimeout: (ms) => { this.adaptiveStaleTimeout = ms; },
      recentCycleTimes: this.recentCycleTimes,
      probedWorkers: this.probedWorkers,
      addMilestone: (worker, milestone) => this.addMilestone(worker, milestone),
      buildUserMessage: (content, opts) => buildUserMessage(content, opts),
    });

    // Check for stale workers every 30s
    this.staleCheckInterval = setInterval(() => this.workerSync.checkStale(), 30_000);

    // Sync dirty worker state to server every 10s (immediate sync for critical changes via markDirty)
    this.syncInterval = setInterval(() => this.workerSync.syncToServer(), 10_000);

    // Run cleanup every 30 minutes (includes session logs)
    this.cleanupInterval = setInterval(() => { this.runCleanup(); cleanupOldLogs(); }, 30 * 60 * 1000);

    // Evict completed workers from memory every 5 minutes to prevent unbounded growth
    this.evictionInterval = setInterval(() => this.workerSync.evictCompletedWorkers(), 5 * 60 * 1000);

    // Persist dirty worker state to disk every 5s
    this.diskPersistInterval = setInterval(() => this.workerSync.persistDirtyWorkers(), 5_000);

    // Restore workers from disk on startup
    this.workerSync.restoreWorkersFromDisk();

    // Scan environment on startup (sync — runs once, fast enough for init)
    try {
      this.environment = scanEnvironment();
      const mcpCount = this.environment.mcpServers?.length || this.environment.mcp.length;
      console.log(`Environment scan: ${this.environment.tools.length} tools, ${this.environment.envKeys.length} env keys, ${mcpCount} MCP servers`);
    } catch (err) {
      console.warn('Environment scan failed:', err);
    }
    // Re-scan every 30 minutes
    this.envScanInterval = setInterval(() => {
      try {
        this.environment = scanEnvironment();
      } catch { /* non-fatal */ }
    }, 30 * 60_000);

    // Send heartbeat to register availability (immediate + periodic)
    // Heartbeat is now a lightweight ping (no workspace queries server-side)
    if (!config.serverless) {
      this.sendHeartbeat();
      this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 5 * 60_000); // Every 5 minutes

      // Reconcile local workers against remote state on startup and every 10 minutes.
      // Prevents ghost workers (e.g. 23 stale files across 12 tasks) from accumulating.
      this.reconcileLocalWorkers().catch(err => {
        console.warn('[Reconcile] Startup reconciliation failed:', err instanceof Error ? err.message : err);
      });
      this.reconcileInterval = setInterval(() => {
        this.reconcileLocalWorkers().catch(err => {
          console.warn('[Reconcile] Periodic reconciliation failed:', err instanceof Error ? err.message : err);
        });
      }, 10 * 60_000); // Every 10 minutes

      // Fallback poll: catch tasks whose Pusher events were missed (crash, reconnect race)
      this.claimPollInterval = setInterval(() => {
        const active = Array.from(this.workers.values()).filter(
          w => w.status === 'working' || w.status === 'stale'
        ).length;
        if (active < this.config.maxConcurrent) {
          this.claimPendingTasks().catch(() => {});
        }
      }, 2 * 60_000); // Every 2 min, only when idle slots exist
    }

    // Initialize Pusher if configured
    this.pusherManager.initialize();

    // Check if credentials exist (don't validate, SDK handles auth)
    // Skip in serverless mode — SDK handles its own auth, no server to report to
    this.hasCredentials = hasClaudeCredentials();
    if (!config.serverless) {
      if (this.hasCredentials) {
        console.log('Claude Code: credentials found');
      } else {
        console.warn('Claude Code: no credentials - run `claude login` or set ANTHROPIC_API_KEY');
      }
    }
  }

  // Set whether to accept remote task assignments
  setAcceptRemoteTasks(enabled: boolean) {
    this.acceptRemoteTasks = enabled;
    this.pusherManager.setAcceptRemoteTasks(enabled);
    console.log(`Accept remote tasks: ${enabled}`);
  }

  // Check if credentials exist
  getAuthStatus(): { hasCredentials: boolean } {
    return { hasCredentials: this.hasCredentials };
  }

  getViewerToken(): string | undefined {
    return this.viewerToken;
  }

  /** Expose internal state for the debug dashboard */
  getInternalState() {
    const cycleTimes = this.recentCycleTimes;
    const sorted = [...cycleTimes].sort((a, b) => a - b);
    const medianCycleMs = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;

    return {
      circuitBreaker: {
        paused: this.claimsPaused,
        pausedUntil: this.claimsPaused ? this.claimsPausedUntil : null,
        consecutiveQuickFailures: this.consecutiveQuickFailures,
      },
      adaptiveTimeout: {
        currentMs: this.adaptiveStaleTimeout,
        recentCycleTimes: cycleTimes,
        medianCycleMs,
      },
      pusher: this.pusherManager.getDebugState(),
      environment: this.environment || null,
      memory: {
        workersInMemory: this.workers.size,
        sessionsInMemory: this.sessions.size,
        dirtyWorkers: this.dirtyWorkers.size,
        dirtyForDisk: this.dirtyForDisk.size,
        probedWorkers: [...this.probedWorkers],
      },
      uptime: Math.floor(process.uptime() * 1000),
    };
  }

  // Subscribe to commands from server
  onCommand(handler: CommandHandler) {
    this.commandHandlers.push(handler);
    return () => {
      this.commandHandlers = this.commandHandlers.filter(h => h !== handler);
    };
  }

  private emitCommand(workerId: string, command: WorkerCommand) {
    for (const handler of this.commandHandlers) {
      handler(workerId, command);
    }
  }

  onEvent(handler: EventHandler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  private emit(event: any) {
    // Auto-mark workers dirty for server sync and disk persistence when their state changes
    if (event.type === 'worker_update' && event.worker?.id) {
      this.dirtyWorkers.add(event.worker.id);
      this.dirtyForDisk.add(event.worker.id);
    }
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  // Send heartbeat to server announcing this runner instance is alive and ready
  private async sendHeartbeat() {
    try {
      const activeCount = Array.from(this.workers.values()).filter(
        w => w.status === 'working' || w.status === 'waiting'
      ).length;
      const { viewerToken, pendingTaskCount, latestCommit } = await this.buildd.sendHeartbeat(this.config.localUiUrl, activeCount, this.environment);
      if (viewerToken) {
        this.viewerToken = viewerToken;
      }
      // Emit version info for auto-update checks
      if (latestCommit) {
        this.emit({ type: 'version_info', latestCommit });
      }
      // If server reports pending tasks and we have capacity, claim immediately
      if (pendingTaskCount && pendingTaskCount > 0 && this.acceptRemoteTasks) {
        const active = Array.from(this.workers.values()).filter(
          w => w.status === 'working' || w.status === 'stale'
        ).length;
        if (active < this.config.maxConcurrent) {
          this.claimPendingTasks().catch(() => {});
        }
      }
    } catch {
      // Non-fatal - heartbeat is best-effort
    }
  }

  // Periodically call the cleanup API to handle stale workers/tasks
  private async runCleanup() {
    try {
      await this.buildd.runCleanup();
    } catch (err) {
      console.warn('[Cleanup] Failed to run server cleanup:', err instanceof Error ? err.message : err);
    }
  }

  /** Remove completed/errored workers from memory and disk. Returns count purged. */
  purgeCompleted(): number {
    let count = 0;
    // Remove from memory
    for (const [id, worker] of this.workers.entries()) {
      if (worker.status === 'done' || worker.status === 'error') {
        this.workers.delete(id);
        this.sessions.delete(id);
        storeDeleteWorker(id);
        count++;
      }
    }
    // Remove from disk (workers not in memory)
    for (const worker of loadAllWorkers()) {
      if (worker.status === 'done' || worker.status === 'error') {
        storeDeleteWorker(worker.id);
        count++;
      }
    }
    return count;
  }

  /**
   * Reconcile local worker state against remote server.
   * Checks all non-terminal local workers and cleans up those whose
   * remote worker/task is 404, completed, or failed.
   * Runs on startup and every 10 minutes to prevent ghost worker buildup.
   */
  async reconcileLocalWorkers(): Promise<{ checked: number; cleaned: number }> {
    const allWorkers = this.getWorkers();
    const nonTerminal = allWorkers.filter(
      w => w.status !== 'done' && w.status !== 'error'
    );

    if (nonTerminal.length === 0) {
      return { checked: 0, cleaned: 0 };
    }

    console.log(`[Reconcile] Checking ${nonTerminal.length} non-terminal local worker(s) against remote state`);

    let cleaned = 0;

    for (const worker of nonTerminal) {
      try {
        const remote = await this.buildd.getWorkerRemote(worker.id);

        if (!remote) {
          // Worker not found remotely (404) — mark as error
          console.log(`[Reconcile] Worker ${worker.id} (task: ${worker.taskTitle}) not found remotely, marking as error`);
          worker.status = 'error';
          worker.error = 'Worker no longer exists on remote server';
          worker.completedAt = worker.completedAt || Date.now();
          this.dirtyForDisk.add(worker.id);
          this.emit({ type: 'worker_update', worker });
          cleaned++;
          continue;
        }

        const remoteTerminal = remote.status === 'completed' || remote.status === 'failed';
        const taskTerminal = remote.task && (remote.task.status === 'completed' || remote.task.status === 'failed');

        if (remoteTerminal || taskTerminal) {
          const isSuccess = remote.status === 'completed' || remote.task?.status === 'completed';
          console.log(`[Reconcile] Worker ${worker.id} (task: ${worker.taskTitle}) is ${remote.status} remotely, cleaning up locally`);

          if (isSuccess) {
            worker.status = 'done';
          } else {
            worker.status = 'error';
            worker.error = 'Task failed or was cancelled on remote server';
          }
          worker.completedAt = worker.completedAt || Date.now();
          this.dirtyForDisk.add(worker.id);
          this.emit({ type: 'worker_update', worker });

          // Abort any active SDK session for this worker
          const session = this.sessions.get(worker.id);
          if (session) {
            session.abortController.abort();
            session.inputStream.end();
            this.sessions.delete(worker.id);
          }

          cleaned++;
        }
      } catch (err) {
        // Non-fatal — skip this worker and try the rest
        console.warn(`[Reconcile] Error checking worker ${worker.id}:`, err instanceof Error ? err.message : err);
      }
    }

    if (cleaned > 0) {
      console.log(`[Reconcile] Cleaned up ${cleaned}/${nonTerminal.length} stale local worker(s)`);
    }

    return { checked: nonTerminal.length, cleaned };
  }

  getWorkers(): LocalWorker[] {
    // Merge in-memory workers with completed workers persisted on disk (24h history)
    const inMemory = Array.from(this.workers.values());
    const inMemoryIds = new Set(inMemory.map(w => w.id));

    const diskWorkers = loadAllWorkers()
      .filter(w => !inMemoryIds.has(w.id) && (w.status === 'done' || w.status === 'error'));

    return [...inMemory, ...diskWorkers];
  }

  getWorker(id: string): LocalWorker | undefined {
    // Check in-memory first, then fall back to disk for evicted completed workers
    return this.workers.get(id) || storeLoadWorker(id) || undefined;
  }

  getSession(id: string): WorkerSession | undefined {
    return this.sessions.get(id);
  }

  markRead(workerId: string) {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.hasNewActivity = false;
      this.emit({ type: 'worker_update', worker });
    }
  }

  // Claim any pending tasks the server has available (no specific task ID)
  async claimPendingTasks(): Promise<LocalWorker[]> {
    if (!this.acceptRemoteTasks) return [];
    if (!this.hasCredentials && !this.config.serverless) return [];

    // Circuit breaker: pause claims after repeated rapid failures (e.g., quota exhaustion)
    if (this.claimsPaused) {
      if (Date.now() < this.claimsPausedUntil) return [];
      console.log('[WorkerManager] Circuit breaker reset — resuming claims');
      this.claimsPaused = false;
      this.consecutiveQuickFailures = 0;
      this.emit({ type: 'circuit_breaker', paused: false, pausedUntil: 0, reason: 'reset' });
    }

    const activeWorkers = Array.from(this.workers.values()).filter(
      w => w.status === 'working' || w.status === 'stale'
    );
    const slots = this.config.maxConcurrent - activeWorkers.length;
    if (slots <= 0) return [];

    try {
      const { workers: claimed, diagnostics, budgetResetsAt } = await this.buildd.claimTask(slots, undefined, this.config.localUiUrl);

      // Server reports account budget exhausted but still served tenant tasks.
      // Emit an informational event for the UI — no circuit breaker needed since
      // the server filters non-tenant tasks correctly.
      if (budgetResetsAt) {
        const resetMs = new Date(budgetResetsAt).getTime();
        const delayMs = Math.max(0, resetMs - Date.now());
        console.warn(`[WorkerManager] Account OAuth budget exhausted — resets at ${budgetResetsAt} (${Math.round(delayMs / 60_000)} min)`);
        this.emit({ type: 'budget_exhausted', budgetResetsAt, delayMs });
      }

      if (claimed.length === 0) {
        // Skip logging no_pending_tasks during polling — that's the normal idle state
        if (diagnostics && diagnostics.reason !== 'no_pending_tasks' && diagnostics.reason !== 'budget_exhausted_partial') {
          claimLog({ event: 'claim_empty', slotsRequested: slots, workersClaimed: 0, diagnosticReason: diagnostics.reason });
        }
        return [];
      }

      claimLog({ event: 'claim_success', slotsRequested: slots, workersClaimed: claimed.length });

      const started: LocalWorker[] = [];
      for (const claimedWorker of claimed) {
        const task = claimedWorker.task;
        if (!task) continue;

        const workspacePath = this.resolver.resolve({
          id: task.workspaceId,
          name: task.workspace?.name || 'unknown',
          repo: task.workspace?.repo,
        });

        if (!workspacePath) {
          console.error(`Cannot resolve workspace for claimed task: ${task.title}`);
          // Fail the worker on server so it doesn't stay "running" forever
          this.buildd.updateWorker(claimedWorker.id, {
            status: 'failed',
            error: `Cannot resolve workspace "${task.workspace?.name || 'unknown'}" (repo: ${task.workspace?.repo || 'none'})`,
          }).catch(() => {});
          continue;
        }

        let resolvedPath = workspacePath;
        if ((claimedWorker as any).roleConfig) {
          const roleConfig = (claimedWorker as any).roleConfig as RoleConfig;
          if (roleConfig.type === 'service') {
            const { cwd } = await syncRoleToLocal(roleConfig);
            resolvedPath = cwd;
          } else {
            // Builder role: sync config, then overlay files into repo
            const { cwd: roleDir } = await syncRoleToLocal(roleConfig);
            await overlayRoleFiles(roleDir, workspacePath);
          }
        }
        const worker = await this.startFromClaim(claimedWorker, task, resolvedPath);
        if (worker) started.push(worker);
      }
      return started;
    } catch (err: any) {
      console.error('Failed to claim pending tasks:', err);
      return [];
    }
  }

  async claimAndStart(task: BuilddTask): Promise<LocalWorker | null> {
    // Warn if no credentials found (but let SDK handle actual auth)
    if (!this.hasCredentials && !this.config.serverless) {
      console.warn('No Claude credentials found - task may fail. Run `claude login` to authenticate.');
    }

    // Resolve workspace path
    const workspacePath = this.resolver.resolve({
      id: task.workspaceId,
      name: task.workspace?.name || 'unknown',
      repo: task.workspace?.repo,
    });

    if (!workspacePath) {
      console.error(`Cannot resolve workspace for task: ${task.title} (${task.id}) — will skip on future retries`);
      this.pusherManager.markUnresolvable(task.id);
      return null;
    }

    // Claim from buildd (pass taskId for targeted claiming)
    const { workers: claimed, diagnostics } = await this.buildd.claimTask(1, task.workspaceId, this.config.localUiUrl, task.id);
    if (claimed.length === 0) {
      const reason = diagnostics?.reason || 'unknown';
      claimLog({ event: 'claim_empty', slotsRequested: 1, workersClaimed: 0, diagnosticReason: diagnostics?.reason, taskId: task.id });
      console.log(`No tasks claimed (reason: ${reason})`);
      return null;
    }

    claimLog({ event: 'claim_success', slotsRequested: 1, workersClaimed: 1, taskId: task.id });

    const claimedWorker = claimed[0];

    // Prefer claim response task data (full) over Pusher event task data (minimal payload)
    const fullTask = claimedWorker.task || task;

    let resolvedPath = workspacePath;
    if ((claimedWorker as any).roleConfig) {
      const roleConfig = (claimedWorker as any).roleConfig as RoleConfig;
      if (roleConfig.type === 'service') {
        const { cwd } = await syncRoleToLocal(roleConfig);
        resolvedPath = cwd;
      } else {
        // Builder role: sync config, then overlay files into repo
        const { cwd: roleDir } = await syncRoleToLocal(roleConfig);
        await overlayRoleFiles(roleDir, workspacePath);
      }
    }
    return this.startFromClaim(claimedWorker, fullTask, resolvedPath);
  }

  private async startFromClaim(
    claimedWorker: { id: string; branch?: string; task?: BuilddTask; serverApiKey?: string; serverOauthToken?: string; mcpSecrets?: Record<string, string>; roleConfig?: RoleConfig },
    fullTask: BuilddTask,
    workspacePath: string,
  ): Promise<LocalWorker | null> {

    // Use server-managed secrets (delivered inline during claim)
    let serverApiKey: string | undefined;
    let serverOauthToken: string | undefined;
    if (!this.hasCredentials) {
      if (claimedWorker.serverApiKey) {
        serverApiKey = claimedWorker.serverApiKey;
        console.log(`[Worker ${claimedWorker.id}] Using server-managed API key`);
      }
      if (claimedWorker.serverOauthToken) {
        serverOauthToken = claimedWorker.serverOauthToken;
        console.log(`[Worker ${claimedWorker.id}] Using server-managed OAuth token`);
      }
    }

    // Create local worker
    const worker: LocalWorker = {
      id: claimedWorker.id,
      taskId: fullTask.id,
      taskTitle: fullTask.title,
      taskDescription: fullTask.description,
      taskMode: fullTask.mode,
      workspaceId: fullTask.workspaceId,
      workspaceName: fullTask.workspace?.name || 'unknown',
      branch: claimedWorker.branch,
      status: 'working',
      hasNewActivity: false,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      milestones: [],
      currentAction: 'Starting...',
      commits: [],
      output: [],
      toolCalls: [],
      messages: [],
      checkpoints: [],
      subagentTasks: [],
      checkpointEvents: new Set<CheckpointEventType>(),
      pendingMcpCalls: [],
      phaseText: null,
      phaseStart: null,
      phaseToolCount: 0,
      phaseTools: [],
    };

    // Attach server-managed credentials if redeemed
    if (serverApiKey) {
      worker.serverApiKey = serverApiKey;
    }
    if (serverOauthToken) {
      worker.serverOauthToken = serverOauthToken;
    }
    if (claimedWorker.mcpSecrets && Object.keys(claimedWorker.mcpSecrets).length > 0) {
      worker.mcpSecrets = claimedWorker.mcpSecrets;
      console.log(`[Worker ${claimedWorker.id}] Received ${Object.keys(claimedWorker.mcpSecrets).length} MCP credential secret(s)`);
    }
    if (claimedWorker.roleConfig) {
      worker.roleConfig = claimedWorker.roleConfig;
      console.log(`[Worker ${claimedWorker.id}] Received role config: ${claimedWorker.roleConfig.slug} (${claimedWorker.roleConfig.type})`);
    }

    this.workers.set(worker.id, worker);
    this.emit({ type: 'worker_update', worker });

    // Immediately persist new worker to disk
    storeSaveWorker(worker);

    // Subscribe to Pusher for commands
    this.pusherManager.subscribeToWorker(worker.id);

    // Register localUiUrl with server
    if (this.config.localUiUrl) {
      this.buildd.updateWorker(worker.id, {
        localUiUrl: this.config.localUiUrl,
        status: 'running',
      }).catch(err => console.error('Failed to register localUiUrl:', err));
    }

    // Set up git worktree for isolation (if branching strategy is not 'none')
    // Skip worktree setup entirely for coordination workspaces (no repo)
    const hasRepo = !!fullTask.workspace?.repo;
    const gitConfig = fullTask.workspace?.gitConfig;
    const branchingStrategy = gitConfig?.branchingStrategy || 'feature';
    const defaultBranch = gitConfig?.defaultBranch || 'main';

    let sessionCwd = workspacePath;
    if (hasRepo && branchingStrategy !== 'none' && claimedWorker.branch) {
      worker.currentAction = 'Setting up worktree...';
      this.emit({ type: 'worker_update', worker });

      const worktreePath = await setupWorktree(
        workspacePath,
        claimedWorker.branch,
        defaultBranch,
        worker.id,
        fullTask.context,
      );

      if (worktreePath) {
        worker.worktreePath = worktreePath;
        sessionCwd = worktreePath;
        this.addMilestone(worker, { type: 'status', label: 'Worktree ready', ts: Date.now() });
      } else {
        // Worktree setup failed — fall back to main repo (legacy behavior)
        console.warn(`[Worker ${worker.id}] Worktree setup failed, falling back to main repo`);
        this.addMilestone(worker, { type: 'status', label: 'Worktree failed, using repo', ts: Date.now() });
      }
    }

    // Pre-flight check: warn about missing MCP server env vars (non-blocking)
    const mcpJsonPath = join(sessionCwd, '.mcp.json');
    const { warnings } = checkMcpPreFlight(mcpJsonPath, process.env as Record<string, string | undefined>);
    for (const warning of warnings) {
      console.warn(`[Worker ${worker.id}] ${warning}`);
    }

    // Start SDK session (async, runs in background)
    this.startSession(worker, sessionCwd, fullTask).catch(err => {
      console.error(`[Worker ${worker.id}] Session failed to start:`, err);

      // Critical: notify server that session failed to start
      // Without this, worker stays "running" forever with 0 turns
      worker.status = 'error';
      worker.error = err instanceof Error ? err.message : 'Failed to start session';
      worker.currentAction = 'Session failed to start';
      worker.hasNewActivity = true;
      worker.completedAt = Date.now();

      this.buildd.updateWorker(worker.id, {
        status: 'failed',
        error: worker.error,
      }).catch(updateErr => {
        console.error(`[Worker ${worker.id}] Failed to report session start failure to server:`, updateErr);
      });

      this.emit({ type: 'worker_update', worker });

      // Clean up worktree on session start failure
      if (worker.worktreePath) {
        cleanupWorktree(workspacePath, worker.worktreePath, worker.id).catch(() => {});
      }
    });

    return worker;
  }

  // Resolve a pending permission request for a worker.
  // Called when the user clicks Allow, Always Allow, or Deny in the UI.
  resolvePermission(workerId: string, decision: 'allow' | 'allow_always' | 'deny'): boolean {
    const pending = this.pendingPermissionRequests.get(workerId);
    if (!pending) return false;

    this.pendingPermissionRequests.delete(workerId);
    const worker = this.workers.get(workerId);

    if (decision === 'allow') {
      pending.resolve({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: pending.toolInput,
          },
        },
      });
    } else if (decision === 'allow_always') {
      // Pass back the SDK's suggested permission updates so the session remembers
      pending.resolve({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: pending.toolInput,
            updatedPermissions: pending.suggestions,
          },
        },
      });
    } else {
      pending.resolve({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'Denied by user via runner',
          },
        },
      });
    }

    // Clear waiting state
    if (worker) {
      worker.status = 'working';
      worker.waitingFor = undefined;
      worker.currentAction = decision === 'deny' ? 'Permission denied' : 'Resuming...';
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.buildd.updateWorker(worker.id, {
        status: 'running',
        currentAction: worker.currentAction,
        waitingFor: null,
      }).catch(() => {});
      storeSaveWorker(worker);
      this.emit({ type: 'worker_update', worker });
    }

    return true;
  }


  private async startSession(worker: LocalWorker, cwd: string, task: BuilddTask, resumeSessionId?: string) {
    sessionLog(worker.id, 'info', 'session_start', `mode=${task.mode || 'execution'} resume=${!!resumeSessionId} cwd=${cwd}`, task.id);
    const inputStream = new MessageStream();
    const abortController = new AbortController();

    // Resolve the original repo path (for worktree cleanup).
    // When using worktrees, cwd is inside <repoPath>/.buildd-worktrees/<branch>/
    const worktreeMarker = `${join('.buildd-worktrees', '')}`;
    const worktreeIdx = cwd.indexOf(worktreeMarker);
    const repoPath = worktreeIdx > 0 ? cwd.substring(0, worktreeIdx) : cwd;

    // Store session state for sendMessage and abort
    const generation = ++this.sessionGeneration;
    this.sessions.set(worker.id, { inputStream, abortController, cwd, repoPath, generation });

    try {
      // Fetch workspace git config from server
      const workspaceConfig = await this.buildd.getWorkspaceConfig(task.workspaceId);
      const gitConfig = workspaceConfig.gitConfig;
      const isConfigured = workspaceConfig.configStatus === 'admin_confirmed';

      // Extract image attachments from task context (if any)
      // Supported formats: image/jpeg, image/png, image/gif, image/webp (Anthropic API)
      const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB per image
      const imageBlocks: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [];

      const ctx = task.context as { attachments?: Array<{ filename: string; mimeType: string; data?: string; url?: string }> } | undefined;
      if (ctx?.attachments && Array.isArray(ctx.attachments)) {
        for (const att of ctx.attachments) {
          if (!SUPPORTED_IMAGE_TYPES.has(att.mimeType)) {
            this.addMilestone(worker, { type: 'status', label: `Skipped unsupported: ${att.filename} (${att.mimeType})`, ts: Date.now() });
            continue;
          }

          if (att.url) {
            // R2 presigned URL format — fetch and convert to base64
            try {
              const response = await fetch(att.url);
              if (!response.ok) {
                this.addMilestone(worker, { type: 'status', label: `Failed to fetch image: ${att.filename} (${response.status})`, ts: Date.now() });
                continue;
              }
              const arrayBuffer = await response.arrayBuffer();
              if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
                this.addMilestone(worker, { type: 'status', label: `Skipped oversized: ${att.filename} (${Math.round(arrayBuffer.byteLength / 1024 / 1024)}MB)`, ts: Date.now() });
                continue;
              }
              const base64Data = Buffer.from(arrayBuffer).toString('base64');
              imageBlocks.push({
                type: 'image',
                source: { type: 'base64', media_type: att.mimeType, data: base64Data },
              });
              this.addMilestone(worker, { type: 'status', label: `Image: ${att.filename}`, ts: Date.now() });
            } catch (err) {
              this.addMilestone(worker, { type: 'status', label: `Failed to fetch image: ${att.filename}`, ts: Date.now() });
            }
          } else if (att.data) {
            // Inline base64 data URL format (legacy)
            const base64Match = att.data.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              imageBlocks.push({
                type: 'image',
                source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] },
              });
              this.addMilestone(worker, { type: 'status', label: `Image: ${att.filename}`, ts: Date.now() });
            }
          }
        }
      }

      // Fetch workspace memory context in parallel: full digest + task-specific matches + feedback memories
      const [compactResult, taskSearchResults, feedbackMemories] = await Promise.all([
        this.buildd.getCompactObservations(task.workspaceId),
        this.buildd.searchObservations(task.workspaceId, task.title, 5),
        this.buildd.searchFeedbackMemories(task.workspaceId),
      ]);

      // Fetch full content for task-specific memory matches
      const fullObservations = taskSearchResults.length > 0
        ? await this.buildd.getBatchObservations(
            task.workspaceId,
            taskSearchResults.map(r => r.id),
          )
        : [];

      // Sync skills to disk for native SDK discovery (no prompt injection)
      const skillBundles = (task.context as any)?.skillBundles as SkillBundle[] | undefined;
      const skillSlugs: string[] = (task.context as any)?.skillSlugs || [];

      if (skillBundles && skillBundles.length > 0) {
        for (const bundle of skillBundles) {
          try {
            await syncSkillToLocal(bundle);
            this.addMilestone(worker, { type: 'status', label: `Skill synced: ${bundle.name}`, ts: Date.now() });
            if (!skillSlugs.includes(bundle.slug)) {
              skillSlugs.push(bundle.slug);
            }
          } catch (err) {
            console.error(`[Worker ${worker.id}] Failed to sync skill ${bundle.slug}:`, err);
            this.addMilestone(worker, { type: 'status', label: `Skill sync failed: ${bundle.slug}`, ts: Date.now() });
          }
        }
      }

      // Build prompt with workspace context
      const inputPolicy = (task.context?.inputPolicy as string) || 'autonomous';
      let promptText = buildPrompt({
        task,
        worker,
        gitConfig,
        isConfigured,
        compactResult,
        taskSearchResults,
        fullObservations,
        inputPolicy,
        hasApiKey: !!this.config.apiKey,
        inputAsRetry: this.config.inputAsRetry,
        resolvedContextProviders: (task.context as any)?.resolvedContextProviders as string[] | undefined,
        feedbackMemories,
      });

      // Add tenant context to prompt (Dispatch multi-tenant mode)
      const promptTenantCtx = extractTenantContext(task.context as Record<string, unknown>);
      if (promptTenantCtx) {
        const tenantLines = [
          `## Tenant Context`,
          `You are processing work for tenant **${promptTenantCtx.displayName || promptTenantCtx.tenantId}** (ID: ${promptTenantCtx.tenantId}).`,
          `All Dispatch API calls must include the header \`X-Tenant-ID: ${promptTenantCtx.tenantId}\`.`,
          `Results and data must be scoped to this tenant — never mix data across tenants.`,
        ];
        if (promptTenantCtx.dispatchUrl) {
          tenantLines.push(`Dispatch API base URL: ${promptTenantCtx.dispatchUrl}`);
        }
        promptText = promptText + '\n\n' + tenantLines.join('\n');
      }

      // Filter out potentially problematic env vars (expired OAuth tokens)
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          !k.includes('CLAUDE_CODE_OAUTH_TOKEN')  // Can contain expired tokens
        )
      );

      // Inject LLM provider config into environment (for OpenRouter, etc.)
      // The Claude Agent SDK reads ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN
      if (this.config.llmProvider?.provider === 'openrouter') {
        cleanEnv.ANTHROPIC_BASE_URL = this.config.llmProvider.baseUrl || 'https://openrouter.ai/api';
        cleanEnv.ANTHROPIC_AUTH_TOKEN = this.config.llmProvider.apiKey || '';
        cleanEnv.ANTHROPIC_API_KEY = '';  // Must be empty for OpenRouter
        console.log(`[Worker ${worker.id}] Using OpenRouter provider`);
      } else if (this.config.llmProvider?.baseUrl) {
        // Custom provider with base URL
        cleanEnv.ANTHROPIC_BASE_URL = this.config.llmProvider.baseUrl;
        if (this.config.llmProvider.apiKey) {
          cleanEnv.ANTHROPIC_AUTH_TOKEN = this.config.llmProvider.apiKey;
          cleanEnv.ANTHROPIC_API_KEY = '';
        }
      }

      // Inject server-managed API key (delivered inline during claim)
      if (worker.serverApiKey && !cleanEnv.ANTHROPIC_API_KEY) {
        cleanEnv.ANTHROPIC_API_KEY = worker.serverApiKey;
        console.log(`[Worker ${worker.id}] Injected server-managed ANTHROPIC_API_KEY`);
      }

      // Inject server-managed OAuth token (delivered inline during claim)
      if (worker.serverOauthToken && !cleanEnv.CLAUDE_CODE_OAUTH_TOKEN) {
        cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = worker.serverOauthToken;
        console.log(`[Worker ${worker.id}] Injected server-managed CLAUDE_CODE_OAUTH_TOKEN`);
      }

      // Inject tenant OAuth token from task context (Dispatch multi-tenant mode)
      // Tenants authenticate via their Anthropic subscription (OAuth).
      // Decrypted at runtime using the shared TENANT_MASTER_KEY so costs go to the tenant's subscription.
      const tenantCtx = extractTenantContext(task.context as Record<string, unknown>);
      if (tenantCtx?.encryptedOauthToken && process.env.TENANT_MASTER_KEY) {
        try {
          const tenantOauthToken = decryptTenantSecret(tenantCtx.encryptedOauthToken);
          cleanEnv.CLAUDE_CODE_OAUTH_TOKEN = tenantOauthToken;
          console.log(`[Worker ${worker.id}] Injected tenant OAuth token for tenant ${tenantCtx.tenantId} (${tenantCtx.displayName || 'unnamed'})`);
          this.addMilestone(worker, { type: 'status', label: `Tenant: ${tenantCtx.displayName || tenantCtx.tenantId}`, ts: Date.now() });
        } catch (err) {
          console.error(`[Worker ${worker.id}] Failed to decrypt tenant OAuth token:`, err);
          this.addMilestone(worker, { type: 'status', label: 'Tenant token decryption failed', ts: Date.now() });
        }
      }

      // Inject MCP credential env vars so ${BUILDD_API_KEY} references in .mcp.json resolve
      if (this.config.apiKey) {
        cleanEnv.BUILDD_API_KEY = this.config.apiKey;
      }

      // Inject MCP credential secrets (env vars for MCP server authentication)
      if (worker.mcpSecrets) {
        for (const [envVar, value] of Object.entries(worker.mcpSecrets)) {
          cleanEnv[envVar] = value;
        }
        console.log(`[Worker ${worker.id}] Injected ${Object.keys(worker.mcpSecrets).length} MCP credential env var(s)`);
      }

      // Enable Agent Teams (SDK handles TeamCreate, SendMessage, TaskCreate/Update/List)
      cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

      // Resolve role env vars (secret labels → actual values)
      if (worker.roleConfig) {
        try {
          const roleEnv = await resolveRoleEnv(
            getRoleDir(worker.roleConfig.slug),
            { ...process.env as Record<string, string>, ...(worker.mcpSecrets || {}) },
          );
          Object.assign(cleanEnv, roleEnv);
          console.log(`[Worker ${worker.id}] Resolved ${Object.keys(roleEnv).length} role env var(s) for ${worker.roleConfig.slug}`);
        } catch (err) {
          console.error(`[Worker ${worker.id}] Failed to resolve role env:`, err);
        }
      }

      // Determine whether to load CLAUDE.md
      // Default to true if not configured, respect admin setting if configured
      const useClaudeMd = !isConfigured || gitConfig?.useClaudeMd !== false;

      // Resolve permission mode
      const bypassPermissions = resolveBypassPermissions(workspaceConfig, this.config.bypassPermissions);
      const permissionMode: 'acceptEdits' | 'bypassPermissions' = bypassPermissions ? 'bypassPermissions' : 'acceptEdits';

      // Check if skills should be used as subagents
      const useSkillAgents = !!(task.context as any)?.useSkillAgents;

      // Build allowedTools with skill scoping
      const allowedTools: string[] = [];
      if (skillSlugs.length > 0 && !useSkillAgents) {
        // Scoped: only allow assigned skills (unless using as subagents)
        for (const slug of skillSlugs) {
          allowedTools.push(`Skill(${slug})`);
        }
      }
      // Note: when no skills assigned or useSkillAgents, don't add Skill to allowedTools — let SDK defaults apply

      // Build system prompt with optional skill usage instruction
      const systemPrompt: any = { type: 'preset', preset: 'claude_code' };
      if (skillSlugs.length > 0 && !useSkillAgents) {
        if (skillSlugs.length === 1) {
          systemPrompt.append = `You MUST use the ${skillSlugs[0]} skill for this task. Invoke it with the Skill tool before starting work.`;
        } else {
          systemPrompt.append = `Use these skills for this task: ${skillSlugs.join(', ')}. Invoke them with the Skill tool as needed.`;
        }
      }

      // Convert skills to subagent definitions when useSkillAgents is enabled
      // Resolve worktree isolation: task-level override > workspace-level setting
      const taskWorktreeIsolation = (task.context as any)?.useWorktreeIsolation;
      const useWorktreeIsolation = taskWorktreeIsolation !== undefined
        ? Boolean(taskWorktreeIsolation)
        : Boolean(gitConfig?.useWorktreeIsolation);

      // Resolve background agents: task-level override > workspace-level setting
      const taskBackgroundAgents = (task.context as any)?.useBackgroundAgents;
      const useBackgroundAgents = taskBackgroundAgents !== undefined
        ? Boolean(taskBackgroundAgents)
        : Boolean(gitConfig?.useBackgroundAgents);

      let agents: Record<string, { description: string; prompt: string; tools: string[]; model: string; isolation?: string; background?: boolean; maxTurns?: number }> | undefined;
      if (useSkillAgents && skillBundles && skillBundles.length > 0) {
        agents = {};
        for (const bundle of skillBundles) {
          const defaultTools = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
          const tools = bundle.allowedTools && bundle.allowedTools.length > 0
            ? bundle.allowedTools
            : defaultTools;

          // Add delegation tools for each delegatee
          const delegationTools = bundle.canDelegateTo && bundle.canDelegateTo.length > 0
            ? bundle.canDelegateTo.map((slug: string) => `Task(${slug})`)
            : [];

          agents[bundle.slug] = {
            description: bundle.description || bundle.name,
            prompt: bundle.content,
            tools: [...tools, ...delegationTools],
            model: bundle.model || 'inherit',
            // SDK v0.2.49+: run subagent in isolated git worktree to prevent file conflicts
            ...(useWorktreeIsolation ? { isolation: 'worktree' } : {}),
            // Background: bundle-level override > workspace-level setting
            ...(bundle.background || useBackgroundAgents ? { background: true } : {}),
            // Max turns from role config
            ...(bundle.maxTurns ? { maxTurns: bundle.maxTurns } : {}),
          };
        }
      }

      // Build sandbox config from workspace config
      const sandboxConfig = gitConfig?.sandbox?.enabled ? gitConfig.sandbox : undefined;

      // Resolve max budget for SDK-level cost control
      const maxBudgetUsd = resolveMaxBudgetUsd(workspaceConfig, this.config.maxBudgetUsd);

      // Resolve fallback model: task-level override > workspace-level setting
      const taskFallbackModel = (task.context as any)?.fallbackModel as string | undefined;
      const fallbackModel = taskFallbackModel || gitConfig?.fallbackModel || undefined;

      // Resolve 1M context beta: task-level override > workspace-level setting
      const taskExtendedContext = (task.context as any)?.extendedContext;
      const extendedContext = taskExtendedContext !== undefined
        ? Boolean(taskExtendedContext)
        : Boolean(gitConfig?.extendedContext);
      const betas = extendedContext && /sonnet/i.test(this.config.model)
        ? ['context-1m-2025-08-07' as const]
        : undefined;

      // Resolve max turns for SDK-level turn limiting
      const maxTurns = resolveMaxTurns(workspaceConfig, this.config.maxTurns);

      // Resolve thinking/effort: task-level override > workspace-level setting
      const taskThinking = (task.context as any)?.thinking;
      const configuredThinking = taskThinking !== undefined ? taskThinking : gitConfig?.thinking;
      const taskEffort = (task.context as any)?.effort;
      const configuredEffort = taskEffort !== undefined ? taskEffort : gitConfig?.effort;

      // Build query options
      const queryOptions: Parameters<typeof query>[0]['options'] = {
        sessionId: worker.id,
        cwd,
        model: this.config.model,
        ...(fallbackModel ? { fallbackModel } : {}),
        abortController,
        env: cleanEnv,
        settingSources: useClaudeMd ? ['user', 'project'] : ['user'],  // Load user skills + optionally CLAUDE.md
        permissionMode,
        systemPrompt,
        enableFileCheckpointing: true,
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        ...(maxTurns ? { maxTurns } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        ...(agents ? { agents } : {}),
        ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
        // SDK debug logging from workspace config
        ...(gitConfig?.debug ? { debug: true } : {}),
        ...(gitConfig?.debugFile ? { debugFile: gitConfig.debugFile } : {}),
        // Structured output: pass outputFormat if task defines an outputSchema
        ...(task.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: task.outputSchema } } : {}),
        stderr: (data: string) => {
          console.log(`[Worker ${worker.id}] stderr: ${data}`);
        },
        // Resume previous session if provided (loads full conversation history from disk)
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        // 1M context beta for Sonnet models (4.5, 4.6+) — reduces compaction at higher cost
        ...(betas ? { betas } : {}),
        // Thinking/effort controls — validated against model capabilities below
        ...(configuredThinking ? { thinking: configuredThinking } : {}),
        ...(configuredEffort ? { effort: configuredEffort } : {}),
      };

      // Attach Buildd MCP server (HTTP remote) so workers can list/update/create tasks
      queryOptions.mcpServers = {
        buildd: {
          type: 'http',
          url: `${this.config.builddServer}/api/mcp?workspace=${encodeURIComponent(task.workspaceId)}&worker=${encodeURIComponent(worker.id)}`,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        },
      };

      // Attach permission hook (blocks dangerous commands, allows safe bash),
      // team tracking hook (captures TeamCreate, SendMessage, Task events),
      // and agent team lifecycle hooks (TeammateIdle, TaskCompleted, SubagentStart, SubagentStop).
      queryOptions.hooks = {
        PreToolUse: [{ hooks: [this.hookFactory.createPermissionHook(worker, { inputPolicy })] }],
        PostToolUse: [{ hooks: [this.hookFactory.createTeamTrackingHook(worker)] }],
        PostToolUseFailure: [{ hooks: [this.hookFactory.createMcpFailureHook(worker)] }],
        Notification: [{ hooks: [this.hookFactory.createNotificationHook(worker)] }],
        PreCompact: [{ hooks: [this.hookFactory.createPreCompactHook(worker)] }],
        PermissionRequest: [{ hooks: [this.hookFactory.createPermissionRequestHook(worker)] }],
        TeammateIdle: [{ hooks: [this.hookFactory.createTeammateIdleHook(worker)] }],
        TaskCompleted: [{ hooks: [this.hookFactory.createTaskCompletedHook(worker)] }],
        SubagentStart: [{ hooks: [this.hookFactory.createSubagentStartHook(worker)] }],
        SubagentStop: [{ hooks: [this.hookFactory.createSubagentStopHook(worker)] }],
        Stop: [{ hooks: [this.hookFactory.createStopHook(worker)] }],
        ConfigChange: [{ hooks: [this.hookFactory.createConfigChangeHook(worker, gitConfig?.blockConfigChanges ?? false)] }],
      };

      // Build prompt: use AsyncIterable<SDKUserMessage> when images are attached,
      // so image content blocks are included in the initial message to the agent.
      const prompt: string | AsyncIterable<SDKUserMessage> = imageBlocks.length > 0
        ? (async function* () {
            yield buildUserMessage([
              { type: 'text', text: promptText },
              ...imageBlocks,
            ]);
          })()
        : promptText;

      // Start query with full options
      const queryInstance = query({
        prompt,
        options: queryOptions,
      });

      // Store queryInstance in session for rewindFiles() access
      const session = this.sessions.get(worker.id);
      if (session) {
        session.queryInstance = queryInstance;
      }

      // Connect input stream for multi-turn conversations (AskUserQuestion pauses here until user responds)
      queryInstance.streamInput(inputStream);

      // Discover model capabilities via SDK v0.2.49+ supportedModels()
      // Validates configured effort/thinking against actual model support
      discoverModelCapabilities(queryInstance, worker, {
        effort: configuredEffort,
        thinking: configuredThinking,
        extendedContext,
      }, this.config.model, (e: any) => this.emit(e));

      // Stream responses with ralph loop (prompt-based self-review)
      let resultSubtype: string | undefined;
      let structuredOutput: Record<string, unknown> | undefined;
      const taskTitle = worker.taskTitle || 'Untitled task';
      const ralphTaskDescription = worker.taskDescription || (task as any).description || '';
      const maxReviewIterations = (task.context as any)?.maxReviewIterations ?? 2;
      let reviewIteration = 0;
      let outputReqNudgeCount = 0;
      const maxOutputReqNudges = 2;

      for await (const msg of queryInstance) {
        // Debug: log result/system messages and AskUserQuestion-related flow
        if (msg.type === 'result') {
          const result = msg as any;
          resultSubtype = result.subtype;
          console.log(`[Worker ${worker.id}] SDK result: subtype=${result.subtype}, worker.status=${worker.status}`);
          if (worker.status === 'waiting') {
            console.log(`[Worker ${worker.id}] ⚠️ Result received while still waiting — toolUseId=${worker.waitingFor?.toolUseId}`);
          }
          // Capture structured output from SDK result (when outputFormat was provided)
          if (result.structured_output && typeof result.structured_output === 'object') {
            structuredOutput = result.structured_output;
          }
        }

        this.handleMessage(worker, msg);

        // On result: run ralph self-review loop before completing
        if (msg.type === 'result') {
          // Output requirement gate: before letting the session end, verify the agent
          // created the required deliverable (PR or artifact). If not, nudge the agent
          // while the session is still alive rather than failing post-loop.
          let outputReqNudged = false;
          const outputReq = task.outputRequirement || 'auto';
          if ((outputReq === 'pr_required' || outputReq === 'artifact_required') && outputReqNudgeCount < maxOutputReqNudges) {
            const hasPR = worker.commits.some((c: any) => c.prUrl || c.prNumber) ||
              worker.toolCalls?.some((tc: any) => tc.name === 'create_pr' || (tc.name === 'mcp__buildd__buildd' && tc.input?.action === 'create_pr'));
            const hasArtifact = worker.toolCalls?.some((tc: any) =>
              tc.name === 'mcp__buildd__buildd' && tc.input?.action === 'create_artifact');

            const unmet = outputReq === 'pr_required' ? !hasPR :
              /* artifact_required */ !hasPR && !hasArtifact;

            if (unmet) {
              const session = this.sessions.get(worker.id);
              if (session) {
                const nudge = outputReq === 'pr_required'
                  ? 'You are not done yet — this task requires a pull request. Create one using `buildd` action: create_pr, then call complete_task.'
                  : 'You are not done yet — this task requires a deliverable. Create a PR (create_pr) or artifact (create_artifact), then call complete_task.';
                console.log(`[Worker ${worker.id}] Output requirement not met (${outputReq}) — nudging agent`);
                sessionLog(worker.id, 'info', 'output_requirement_nudge', outputReq, worker.taskId);
                this.addMilestone(worker, { type: 'status', label: `Output requirement nudge: ${outputReq}`, ts: Date.now() });
                worker.currentAction = `Creating ${outputReq === 'pr_required' ? 'PR' : 'deliverable'}...`;
                this.emit({ type: 'worker_update', worker });
                session.inputStream.enqueue(buildUserMessage(nudge, { sessionId: worker.id }));
                outputReqNudged = true;
                outputReqNudgeCount++;
              }
            }
          }
          if (outputReqNudged) {
            continue; // Keep session alive — agent needs to create the deliverable
          }

          // Check if agent already passed review (said DONE)
          const lastMsg = worker.lastAssistantMessage || '';
          if (lastMsg.includes('<promise>DONE</promise>')) {
            if (reviewIteration > 0) {
              this.addMilestone(worker, { type: 'status', label: `Self-review passed (iteration ${reviewIteration})`, ts: Date.now() });
              sessionLog(worker.id, 'info', 'ralph_review_passed', `iteration=${reviewIteration}`, worker.taskId);
            }
            break;
          }

          // Skip review for waiting/error states
          if (worker.status === 'waiting' || worker.status === 'error') {
            break;
          }

          // Check if we've exhausted review iterations
          if (reviewIteration >= maxReviewIterations) {
            this.addMilestone(worker, { type: 'status', label: `Self-review iterations exhausted (${reviewIteration}/${maxReviewIterations})`, ts: Date.now() });
            sessionLog(worker.id, 'warn', 'ralph_review_exhausted', `iterations=${reviewIteration}`, worker.taskId);
            break;
          }

          // Send self-review prompt back into the session
          reviewIteration++;
          const reviewPrompt = `Before completing, review your work against the original objective.

**Task:** ${taskTitle}
${ralphTaskDescription ? `**Description:** ${ralphTaskDescription}` : ''}

Check your implementation:
- Did you fully implement what was asked, or take shortcuts?
- Any TODO comments, stubs, or placeholder code left behind?
- Any features described in the task that you skipped or only partially implemented?
- Did you remove or break existing functionality unnecessarily?

If everything is complete and meets the objective, respond with exactly: <promise>DONE</promise>
If something is missing or incomplete, describe what and fix it now.`;

          this.addMilestone(worker, { type: 'status', label: `Self-review ${reviewIteration}/${maxReviewIterations}`, ts: Date.now() });
          sessionLog(worker.id, 'info', 'ralph_review_start', `iteration=${reviewIteration}`, worker.taskId);
          worker.currentAction = `Self-review (${reviewIteration}/${maxReviewIterations})`;
          this.emit({ type: 'worker_update', worker });

          const session = this.sessions.get(worker.id);
          if (session) {
            session.inputStream.enqueue(buildUserMessage(reviewPrompt, { sessionId: worker.id }));
          }
          continue; // Don't break — keep streaming the agent's response
        }
      }

      // If a newer session has been started (e.g. plan approval killed this one),
      // skip all post-loop cleanup to avoid overwriting the new session's state.
      const currentSession = this.sessions.get(worker.id);
      if (currentSession && currentSession.generation !== generation) {
        console.log(`[Worker ${worker.id}] Session generation mismatch (${generation} vs ${currentSession.generation}) — skipping post-loop cleanup`);
        sessionLog(worker.id, 'info', 'session_superseded', `gen=${generation} replaced by gen=${currentSession.generation}`, worker.taskId);
        return;
      }

      // inputAsRetry: AskUserQuestion triggered an abort — mark as failed with structured context.
      // The waiting_input notification was already synced in handleMessage.
      if (worker.error?.startsWith('needs_input')) {
        console.log(`[Worker ${worker.id}] inputAsRetry: marking as failed — ${worker.error}`);
        sessionLog(worker.id, 'info', 'input_as_retry', worker.error, worker.taskId);
        this.addCheckpoint(worker, CheckpointEvent.TASK_ERROR);
        const gitStats = await collectGitStats(this.sessions.get(worker.id)?.cwd, worker.id, worker.commits.length);
        worker.status = 'error';
        worker.currentAction = 'Needs input';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error,
          milestones: worker.milestones,
          ...gitStats,
        });
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
        return;
      }

      // If the worker is waiting for user input (e.g. AskUserQuestion set status to 'waiting'),
      // don't overwrite that state with 'done'. The session ended naturally but the worker
      // needs human input before it can proceed.
      if (worker.status === 'waiting') {
        console.log(`[Worker ${worker.id}] Session ended while worker is waiting — skipping post-loop cleanup`);
        sessionLog(worker.id, 'info', 'session_ended_waiting', `waitingFor=${worker.waitingFor?.type}`, worker.taskId);
        return;
      }

      // Check if session actually did work or just errored
      // Only check early output (first 500 chars) to avoid false positives
      // from agent responses that discuss auth topics
      const earlyOutput = worker.output.slice(0, 3).join('\n').toLowerCase();
      const isAuthError = earlyOutput.includes('invalid api key') ||
        earlyOutput.includes('please run /login') ||
        earlyOutput.includes('api key is required') ||
        earlyOutput.includes('401 unauthorized');

      if (isAuthError) {
        // Auth error - mark as failed, not completed
        sessionLog(worker.id, 'error', 'auth_error', 'Agent authentication failed — check API key', worker.taskId);
        this.addCheckpoint(worker, CheckpointEvent.TASK_ERROR);
        worker.status = 'error';
        worker.error = 'Agent authentication failed';
        worker.currentAction = 'Auth failed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, { status: 'failed', error: 'Agent authentication failed - check API key' });
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
      } else if (resultSubtype === 'error_max_budget_usd') {
        // Budget exceeded - report as error with specific message
        sessionLog(worker.id, 'error', 'budget_exceeded', 'maxBudgetUsd limit hit', worker.taskId);
        this.addCheckpoint(worker, CheckpointEvent.TASK_ERROR);
        const gitStats = await collectGitStats(this.sessions.get(worker.id)?.cwd, worker.id, worker.commits.length);
        worker.status = 'error';
        worker.error = 'Budget limit exceeded';
        worker.currentAction = 'Budget exceeded';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: 'Budget limit exceeded (maxBudgetUsd)',
          budgetExhausted: true,
          milestones: worker.milestones,
          ...gitStats,
        });
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
      } else {
        // Actually completed
        sessionLog(worker.id, 'info', 'session_complete', `resultSubtype=${resultSubtype}`, worker.taskId);
        const gitStats = await collectGitStats(this.sessions.get(worker.id)?.cwd, worker.id, worker.commits.length);

        this.addMilestone(worker, { type: 'status', label: 'Task completed', ts: Date.now() });
        this.addCheckpoint(worker, CheckpointEvent.TASK_COMPLETED);
        worker.status = 'done';
        worker.currentAction = 'Completed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        this.workerSync.recordCycleTime(worker);
        this.probedWorkers.delete(worker.id);  // Clean up probe tracking
        // Generate follow-up prompt suggestions if Stop hook didn't already
        if (!worker.promptSuggestions || worker.promptSuggestions.length === 0) {
          worker.promptSuggestions = generatePromptSuggestions(worker);
          if (worker.promptSuggestions.length > 0) {
            console.log(`[Worker ${worker.id}] Prompt suggestions (fallback): ${worker.promptSuggestions.join('; ')}`);
          }
        }
        // Compute aggregate token counts from SDK result metadata
        const resultMeta = worker.resultMeta || undefined;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        if (resultMeta?.modelUsage) {
          let totalIn = 0, totalOut = 0;
          for (const usage of Object.values(resultMeta.modelUsage)) {
            totalIn += usage.inputTokens + usage.cacheReadInputTokens;
            totalOut += usage.outputTokens;
          }
          if (totalIn > 0) inputTokens = totalIn;
          if (totalOut > 0) outputTokens = totalOut;
        }

        await this.buildd.updateWorker(worker.id, {
          status: 'completed',
          milestones: worker.milestones,
          ...gitStats,
          ...(resultMeta && { resultMeta }),
          ...(inputTokens && { inputTokens }),
          ...(outputTokens && { outputTokens }),
          // Include structured output if the SDK returned validated JSON
          ...(structuredOutput ? { structuredOutput } : {}),
          // Use last_assistant_message from Stop hook as summary (cleaner than transcript parsing)
          ...(worker.lastAssistantMessage ? { summary: worker.lastAssistantMessage } : {}),
        });
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);

        // Capture summary observation (non-fatal)
        try {
          const summary = buildSessionSummary(worker);
          const files = extractFilesFromToolCalls(worker.toolCalls);

          // Extract concepts from task title + commit messages for better searchability
          const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'is', 'it', 'be', 'as', 'by', 'with', 'from', 'this', 'that', 'not', 'are', 'was', 'has', 'have', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'task']);
          const conceptSource = [task.title, ...worker.commits.map(c => c.message)].join(' ');
          const concepts = [...new Set(
            conceptSource
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length > 2 && !STOPWORDS.has(w))
          )].slice(0, 15);

          await this.buildd.createObservation(task.workspaceId, {
            type: 'summary',
            title: `Task: ${task.title}`,
            content: summary,
            files,
            concepts,
            workerId: worker.id,
            taskId: task.id,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Worker ${worker.id}] Failed to capture summary observation: ${errMsg}`);
          // Non-fatal - task still completed successfully
        }
      }

    } catch (error) {
      // Check if this is an expected abort (from loop detection or user)
      const isAbortError = error instanceof Error &&
        (error.message.includes('aborted') || error.message.includes('Aborted'));

      // Before marking as failed, check if server already has this as completed.
      // This handles the race where complete_task succeeded but sync abort threw.
      try {
        const remote = await this.buildd.getWorkerRemote(worker.id);
        if (remote?.status === 'completed') {
          console.log(`[Worker ${worker.id}] Server shows completed despite local error — honoring server state`);
          sessionLog(worker.id, 'info', 'session_reconciled', 'Server confirms completed, local error ignored', worker.taskId);
          worker.status = 'done';
          worker.completedAt = worker.completedAt || Date.now();
          this.emit({ type: 'worker_update', worker });
          storeSaveWorker(worker);
          return;
        }
      } catch { /* non-fatal — proceed with fail */ }

      this.addCheckpoint(worker, CheckpointEvent.TASK_ERROR);

      if (isAbortError) {
        // Clean abort - already handled by abort() method which set worker.error
        console.log(`[Worker ${worker.id}] Session aborted: ${worker.error || 'Unknown reason'}`);
        sessionLog(worker.id, 'warn', 'session_abort', worker.error || 'Session aborted', worker.taskId);
        worker.status = 'error';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error || 'Session aborted'
        }).catch(err => console.error(`[Worker ${worker.id}] Failed to sync abort status:`, err));
      } else {
        // Unexpected error
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        const errStack = error instanceof Error ? error.stack : undefined;
        console.error(`Worker ${worker.id} error:`, error);
        sessionLog(worker.id, 'error', 'session_error', `${errMsg}${errStack ? '\n' + errStack : ''}`, worker.taskId);
        worker.status = 'error';
        worker.error = errMsg;
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        const errLower = errMsg.toLowerCase();
        const isBudgetError = errLower.includes('budget') || errLower.includes('out of extra usage') || errLower.includes('max budget');
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error,
          ...(isBudgetError && { budgetExhausted: true }),
        }).catch(err => console.error(`[Worker ${worker.id}] Failed to sync error status:`, err));
      }
      this.emit({ type: 'worker_update', worker });
      storeSaveWorker(worker);

      // When this is a resume attempt, re-throw so the caller (resumeSession)
      // can fall through to Layer 2 (reconstructed context). Without this,
      // startSession swallows the error and Layer 2 never gets a chance.
      if (resumeSessionId) {
        throw error;
      }
    } finally {
      // Clean up session
      const session = this.sessions.get(worker.id);
      if (session) {
        session.inputStream.end();

        // Only clean up worktree immediately on error/abort — completed and waiting
        // workers keep worktree alive for session resume (follow-up messages / user answers).
        // Worktrees for these workers get cleaned up during eviction.
        // Exception: e2e test worktrees are always cleaned up immediately (ephemeral).
        const isEphemeral = isEphemeralTestBranch(worker.branch);
        if (worker.worktreePath && (isEphemeral || (worker.status !== 'done' && worker.status !== 'waiting'))) {
          await cleanupWorktree(session.repoPath, worker.worktreePath, worker.id).catch(err => {
            console.error(`[Worker ${worker.id}] Worktree cleanup failed:`, err);
          });
        }

        this.sessions.delete(worker.id);
      }

      // Archive to SQLite history (non-fatal)
      if (worker.status === 'done' || worker.status === 'error') {
        try { archiveSession(worker); } catch {}
      }

      // Circuit breaker: detect errors that affect all workers and pause claims
      if (worker.status === 'error' && worker.error) {
        const err = worker.error.toLowerCase();
        const pauseReason = this.classifyErrorForCircuitBreaker(err);

        if (pauseReason) {
          const pauseMs = pauseReason.pauseMs;
          this.claimsPaused = true;
          this.claimsPausedUntil = Date.now() + pauseMs;
          this.consecutiveQuickFailures = 0;
          console.warn(`[WorkerManager] ${pauseReason.label} — pausing claims ~${Math.round(pauseMs / 60_000)} min`);
          sessionLog(worker.id, 'warn', 'circuit_breaker', `${pauseReason.label}: pausing ~${Math.round(pauseMs / 60_000)} min`, worker.taskId);
          this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: this.claimsPausedUntil, reason: pauseReason.label });
        } else {
          // Generic rapid failure detection (non-classified errors)
          const sessionDuration = worker.completedAt ? worker.completedAt - (worker.startedAt || worker.completedAt) : 0;
          if (sessionDuration < 30_000) {
            this.consecutiveQuickFailures++;
            if (this.consecutiveQuickFailures >= 3 && !this.claimsPaused) {
              this.claimsPaused = true;
              this.claimsPausedUntil = Date.now() + 5 * 60 * 1000;
              console.warn(`[WorkerManager] Circuit breaker: ${this.consecutiveQuickFailures} rapid failures. Pausing 5 min. Error: ${worker.error}`);
              sessionLog(worker.id, 'warn', 'circuit_breaker', `${this.consecutiveQuickFailures} rapid failures: ${worker.error}`, worker.taskId);
              this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: this.claimsPausedUntil, reason: `${this.consecutiveQuickFailures} rapid failures` });
            }
          }
        }
      } else if (worker.status === 'done') {
        this.consecutiveQuickFailures = 0;
        // A slot freed up — check for pending tasks
        this.claimPendingTasks().catch(() => {});
      }
    }
  }

  private handleMessage(worker: LocalWorker, msg: SDKMessage) {
    worker.lastActivity = Date.now();
    worker.hasNewActivity = true;

    // Recover from stale status when activity resumes
    if (worker.status === 'stale') {
      worker.status = 'working';
    }
    // Clear probe tracking when activity resumes (probe succeeded or agent was active)
    this.probedWorkers.delete(worker.id);

    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      worker.sessionId = msg.session_id;
      this.addCheckpoint(worker, CheckpointEvent.SESSION_STARTED);
      // Immediately persist sessionId (critical for resume)
      storeSaveWorker(worker);
    }

    // Surface rate limit events from SDK (v0.2.45+)
    if (msg.type === 'system' && (msg as any).subtype === 'rate_limit') {
      const event = msg as any;
      const info = event.rate_limit_info;
      const retryMs = event.retry_after_ms;
      const utilization = info?.utilization ?? event.utilization;

      const label = info?.status === 'rejected'
        ? `Rate limit rejected (${info.rateLimitType || 'unknown'})`
        : retryMs
          ? `Rate limited — retrying in ${Math.ceil(retryMs / 1000)}s`
          : utilization
            ? `Rate limit: ${Math.round(utilization * 100)}% utilized`
            : 'Rate limited';
      worker.currentAction = label;
      this.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Rate limit event: ${label}`);

      // Circuit breaker: if rejected, pause claims until reset
      if (info?.status === 'rejected') {
        const resetDelay = info.resetsAt ? info.resetsAt - Date.now() : undefined;
        const pauseMs = resetDelay && resetDelay > 0
          ? Math.min(resetDelay, 24 * 60 * 60 * 1000) // cap at 24h
          : info.rateLimitType === 'five_hour' ? 60 * 60 * 1000 // 1h fallback
          : 5 * 60 * 1000; // 5 min fallback

        this.claimsPaused = true;
        this.claimsPausedUntil = Date.now() + pauseMs;
        const reason = info.overageDisabledReason
          ? `${info.rateLimitType} (${info.overageDisabledReason})`
          : info.rateLimitType || 'unknown';
        console.warn(`[WorkerManager] Rate limit rejected (${reason}) — pausing claims ~${Math.round(pauseMs / 60_000)} min`);
        sessionLog(worker.id, 'warn', 'rate_limit_pause', `Pausing claims: ${reason}, ~${Math.round(pauseMs / 60_000)} min`, worker.taskId);
        this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: this.claimsPausedUntil, reason });
      }

      this.emit({ type: 'worker_update', worker });
      return;
    }

    // Track file checkpoints from SDK files_persisted events
    if (msg.type === 'system' && (msg as any).subtype === 'files_persisted') {
      const event = msg as any;
      const checkpoint: Checkpoint = {
        uuid: event.uuid,
        timestamp: Date.now(),
        files: (event.files || []).map((f: any) => ({ filename: f.filename, file_id: f.file_id })),
      };
      worker.checkpoints.push(checkpoint);
      // Keep last 50 checkpoints
      if (worker.checkpoints.length > 50) {
        worker.checkpoints.shift();
      }
      console.log(`[Worker ${worker.id}] File checkpoint: ${checkpoint.files.length} file(s), uuid=${checkpoint.uuid.slice(0, 12)}`);
      this.emit({ type: 'worker_update', worker });
    }

    // SDK v0.2.45: Subagent task started — track lifecycle from start to completion
    if (msg.type === 'system' && (msg as any).subtype === 'task_started') {
      const event = msg as any;
      const isBackground = Boolean(event.is_background);
      const subagentTask: SubagentTask = {
        taskId: event.task_id,
        toolUseId: event.tool_use_id,
        description: event.description || '',
        taskType: event.task_type || 'unknown',
        startedAt: Date.now(),
        status: 'running',
        ...(isBackground ? { isBackground: true } : {}),
      };
      worker.subagentTasks.push(subagentTask);
      // Keep last 100 subagent tasks
      if (worker.subagentTasks.length > 100) {
        worker.subagentTasks.shift();
      }
      const bgLabel = isBackground ? ' (background)' : '';
      this.addMilestone(worker, { type: 'status', label: `Subagent started${bgLabel}: ${subagentTask.description.slice(0, 50)}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent task started${bgLabel}: ${subagentTask.taskId} (${subagentTask.taskType}) — ${subagentTask.description}`);
      this.emit({ type: 'worker_update', worker });
    }

    // SDK v0.2.47: Subagent task notification — completion/status update for a tracked task
    // tool_use_id added in v0.2.47 for start→completion correlation
    if (msg.type === 'system' && (msg as any).subtype === 'task_notification') {
      const event = msg as any;
      const taskId = event.task_id as string;
      const toolUseId = event.tool_use_id as string | undefined;
      const status = event.status as string;
      const message = event.message as string | undefined;

      // Update tracked subagent task — match by taskId first, fallback to toolUseId
      const tracked = worker.subagentTasks.find(t => t.taskId === taskId)
        || (toolUseId ? worker.subagentTasks.find(t => t.toolUseId === toolUseId) : undefined);
      if (tracked) {
        tracked.status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : tracked.status;
        tracked.completedAt = Date.now();
        if (message) tracked.message = message;
      }

      const label = tracked
        ? `Subagent ${status}: ${tracked.description.slice(0, 50)}`
        : `Subagent ${status}: ${taskId.slice(0, 12)}`;
      this.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent task ${status}: ${taskId}${toolUseId ? ` (tool_use_id=${toolUseId.slice(0, 12)})` : ''}${message ? ` — ${message}` : ''}`);
      this.emit({ type: 'worker_update', worker });
    }

    // SDK v0.2.51+: Subagent task progress — cumulative metrics for background subagents
    if (msg.type === 'system' && (msg as any).subtype === 'task_progress') {
      const event = msg as any;
      const taskId = event.task_id as string;
      const toolUseId = event.tool_use_id as string | undefined;

      // Update tracked subagent task with progress data
      const tracked = worker.subagentTasks.find(t => t.taskId === taskId)
        || (toolUseId ? worker.subagentTasks.find(t => t.toolUseId === toolUseId) : undefined);
      if (tracked) {
        tracked.progress = {
          toolCount: event.tool_count ?? 0,
          durationMs: event.duration_ms ?? 0,
          agentName: event.agent_name ?? null,
          cumulativeUsage: event.cumulative_usage ?? null,
        };
      }
      this.emit({ type: 'worker_update', worker });
    }

    if (msg.type === 'assistant') {
      // Surface rate_limit errors on assistant messages
      if ((msg as any).error === 'rate_limit') {
        worker.currentAction = 'Rate limited — retrying...';
        console.log(`[Worker ${worker.id}] Assistant rate_limit error — SDK retrying automatically`);
      }

      // Extract text from assistant message
      const content = (msg as any).message?.content || [];
      for (const block of content) {
        if (block.type === 'text') {
          const text = block.text.trim();
          if (text) {
            // Add to unified timeline
            this.addChatMessage(worker, { type: 'text', content: text, timestamp: Date.now() });

            // Phase detection: text block signals reasoning
            // If active phase has tool calls, close it and start new
            if (worker.phaseText && worker.phaseToolCount > 0) {
              this.closePhase(worker);
            }
            // Start new phase (or update if consecutive text blocks)
            worker.phaseText = text;
            worker.phaseStart = Date.now();
            worker.phaseToolCount = 0;
            worker.phaseTools = [];
          }
          const lines = block.text.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              worker.output.push(line);
              // Keep last 100 lines
              if (worker.output.length > 100) {
                worker.output.shift();
              }
              this.emit({ type: 'output', workerId: worker.id, line });
            }
          }
        }

        // Detect tool use for phase tracking
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const input = block.input || {};

          // Add to unified timeline
          this.addChatMessage(worker, { type: 'tool_use', name: toolName, input, timestamp: Date.now() });

          // Track tool calls (keep last 200)
          worker.toolCalls.push({
            name: toolName,
            timestamp: Date.now(),
            input: input,
          });
          if (worker.toolCalls.length > 200) {
            worker.toolCalls.shift();
          }

          // Track MCP tool calls for server sync
          if (toolName.startsWith('mcp__')) {
            const parts = toolName.split('__');
            const server = parts[1] || 'unknown';
            const tool = parts.slice(2).join('__') || toolName;
            if (!worker.pendingMcpCalls) worker.pendingMcpCalls = [];
            worker.pendingMcpCalls.push({
              server,
              tool,
              ts: Date.now(),
              ok: true,
            });
          }

          // Check for repetitive tool calls (infinite loop detection)
          const repetitionCheck = this.detectRepetitiveToolCalls(worker);
          if (repetitionCheck.isRepetitive) {
            console.log(`[Worker ${worker.id}] 🛑 ${repetitionCheck.reason}`);
            this.addMilestone(worker, { type: 'status', label: `🛑 ${repetitionCheck.reason}`, ts: Date.now() });
            worker.error = repetitionCheck.reason;
            this.abort(worker.id).catch(err =>
              console.error(`[Worker ${worker.id}] Failed to abort:`, err)
            );
            return;
          }

          // Increment phase tool count
          worker.phaseToolCount++;

          // Track notable tools in phaseTools (cap 5)
          if (['Edit', 'Write', 'Bash'].includes(toolName) && worker.phaseTools.length < 5) {
            if (toolName === 'Edit' || toolName === 'Write') {
              const filePath = input.file_path as string;
              const shortPath = filePath ? filePath.split('/').pop() || filePath : toolName;
              worker.phaseTools.push(`${toolName}: ${shortPath}`);
            } else if (toolName === 'Bash') {
              const cmd = (input.command as string) || '';
              worker.phaseTools.push(cmd.slice(0, 40));
            }
          }

          // Fire checkpoint milestones for meaningful first-time events
          if (toolName === 'Read') {
            this.addCheckpoint(worker, CheckpointEvent.FIRST_READ);
          } else if (toolName === 'Edit' || toolName === 'Write') {
            this.addCheckpoint(worker, CheckpointEvent.FIRST_EDIT);
          }

          // Emit action milestones for notable tool calls (Edit, Write, Bash)
          if (toolName === 'Edit' || toolName === 'Write') {
            const filePath = input.file_path as string;
            const shortPath = filePath ? filePath.split('/').pop() || filePath : 'file';
            this.addMilestone(worker, { type: 'action', label: `${toolName === 'Edit' ? 'Edited' : 'Wrote'} ${shortPath}`, ts: Date.now() });
          } else if (toolName === 'Bash') {
            const cmd = (input.command as string) || '';
            // Only emit for notable bash commands, skip trivial ones
            if (cmd.includes('git commit') || cmd.includes('npm') || cmd.includes('bun') || cmd.includes('test') || cmd.includes('build')) {
              this.addMilestone(worker, { type: 'action', label: `Ran: ${cmd.slice(0, 50)}`, ts: Date.now() });
            }
          }

          // Update currentAction (still useful for live display)
          if (toolName === 'Read') {
            worker.currentAction = `Reading ${input.file_path}`;
          } else if (toolName === 'Edit') {
            worker.currentAction = `Editing ${input.file_path}`;
          } else if (toolName === 'Write') {
            worker.currentAction = `Writing ${input.file_path}`;
          } else if (toolName === 'Bash') {
            const cmd = input.command || '';
            worker.currentAction = `Running: ${(cmd as string).slice(0, 40)}...`;

            // Detect git commits — standalone status milestone
            if ((cmd as string).includes('git commit')) {
              const heredocMatch = (cmd as string).match(/cat\s*<<\s*['"]?EOF['"]?\n([\s\S]*?)\nEOF/);
              const simpleMatch = (cmd as string).match(/-m\s+["']([^"']+)["']/);
              const message = heredocMatch
                ? heredocMatch[1].split('\n')[0].trim()
                : simpleMatch ? simpleMatch[1] : 'commit';
              worker.commits.push({ sha: 'pending', message });
              if (worker.commits.length > 50) {
                worker.commits.shift();
              }
              this.addMilestone(worker, { type: 'status', label: `Commit: ${message}`, ts: Date.now() });
              this.addCheckpoint(worker, CheckpointEvent.FIRST_COMMIT);
            }
          } else if (toolName === 'Glob' || toolName === 'Grep') {
            worker.currentAction = `Searching...`;
          } else if (toolName === 'AskUserQuestion') {
            // Agent is asking a question — standalone status milestone + waiting state
            const questions = input.questions as Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }> | undefined;
            const firstQuestion = questions?.[0];
            const toolUseId = block.id as string | undefined;
            const questionText = firstQuestion?.question || 'Awaiting input';
            console.log(`[Worker ${worker.id}] AskUserQuestion detected — toolUseId=${toolUseId}, question="${questionText.slice(0, 60)}"`);
            worker.waitingFor = {
              type: 'question',
              prompt: questionText,
              options: firstQuestion?.options,
              toolUseId,
            };
            worker.currentAction = firstQuestion?.header || 'Question';
            this.addMilestone(worker, { type: 'status', label: `Question: ${firstQuestion?.header || 'Awaiting input'}`, ts: Date.now() });

            if (this.config.inputAsRetry !== false) {
              // inputAsRetry mode: snapshot state, sync notification, then abort.
              // The ralph-loop retry system will create a follow-up task with the user's answer.
              console.log(`[Worker ${worker.id}] inputAsRetry: aborting session — question="${questionText.slice(0, 60)}"`);
              worker.error = `needs_input: ${questionText}`;
              // Sync waiting_input to server (triggers Pushover notification) before marking failed
              this.buildd.updateWorker(worker.id, {
                status: 'waiting_input',
                currentAction: worker.currentAction,
                waitingFor: {
                  type: 'question',
                  prompt: questionText,
                  options: firstQuestion?.options,
                },
              }).catch(() => {});
              storeSaveWorker(worker);
              // Abort the subprocess — the post-loop cleanup will detect worker.error
              // and mark the worker as failed with the needs_input context.
              const session = this.sessions.get(worker.id);
              if (session) {
                session.abortController.abort();
              }
            } else {
              // Default mode: block and wait for user input via the debug UI
              worker.status = 'waiting';
              this.buildd.updateWorker(worker.id, {
                status: 'waiting_input',
                currentAction: worker.currentAction,
                waitingFor: {
                  type: 'question',
                  prompt: questionText,
                  options: firstQuestion?.options,
                },
              }).catch(() => {});
              storeSaveWorker(worker);
            }
          }
        }
      }
    }

    if (msg.type === 'result') {
      // Close any open phase on result
      if (worker.phaseText && worker.phaseToolCount > 0) {
        this.closePhase(worker);
      }
      const result = msg as any;
      if (result.subtype === 'error_max_budget_usd') {
        this.addMilestone(worker, { type: 'status', label: `Budget limit exceeded ($${result.total_cost_usd?.toFixed(2) || '?'})`, ts: Date.now() });
        sessionLog(worker.id, 'error', 'result_budget_exceeded', `cost=$${result.total_cost_usd?.toFixed(2) || '?'}`, worker.taskId);
      } else if (result.subtype !== 'success') {
        this.addMilestone(worker, { type: 'status', label: `Error: ${result.subtype}`, ts: Date.now() });
        sessionLog(worker.id, 'error', 'result_error', `subtype=${result.subtype} stopReason=${result.stop_reason}`, worker.taskId);
      }

      // Capture SDK result metadata for server sync
      worker.resultMeta = {
        stopReason: result.stop_reason ?? null,
        terminalReason: result.terminal_reason ?? null,
        durationMs: result.duration_ms ?? 0,
        durationApiMs: result.duration_api_ms ?? 0,
        numTurns: result.num_turns ?? 0,
        modelUsage: result.usage?.byModel ?? {},
        ...(result.permission_denials?.length > 0 && {
          permissionDenials: result.permission_denials.map((d: any) => ({
            tool: d.tool_name || d.tool || 'unknown',
            reason: d.reason || d.message || '',
          })),
        }),
      };
    }

    this.emit({ type: 'worker_update', worker });
  }

  private addChatMessage(worker: LocalWorker, msg: ChatMessage) {
    worker.messages.push(msg);
    // Keep last 200 messages
    if (worker.messages.length > 200) {
      worker.messages.shift();
    }
  }

  // Detect if agent is stuck in an infinite loop of repeated tool calls
  private detectRepetitiveToolCalls(worker: LocalWorker): { isRepetitive: boolean; reason?: string } {
    const recentCalls = worker.toolCalls.slice(-MAX_SIMILAR_TOOL_CALLS);
    if (recentCalls.length < MAX_IDENTICAL_TOOL_CALLS) {
      return { isRepetitive: false };
    }

    // Check for identical consecutive tool calls (same tool + same input)
    const lastCalls = recentCalls.slice(-MAX_IDENTICAL_TOOL_CALLS);

    // For Read operations, normalize the key to exclude offset/limit since reading
    // different sections of the same file is legitimate behavior
    const normalizeCallKey = (tc: { name: string; input?: Record<string, unknown> }) => {
      if (tc.name === 'Read') {
        // For Read, include offset+limit in the key so different sections are distinct
        // If offset/limit differ, these are different reads
        return JSON.stringify({
          name: tc.name,
          file_path: tc.input?.file_path,
          offset: tc.input?.offset,
          limit: tc.input?.limit,
        });
      }
      return JSON.stringify({ name: tc.name, input: tc.input });
    };

    const lastCallKey = normalizeCallKey(lastCalls[0]);
    const allIdentical = lastCalls.every(tc => normalizeCallKey(tc) === lastCallKey);

    if (allIdentical) {
      return {
        isRepetitive: true,
        reason: `Agent stuck: made ${MAX_IDENTICAL_TOOL_CALLS} identical ${lastCalls[0].name} calls`,
      };
    }

    // Check for similar consecutive tool calls (same tool, similar key parameters)
    // This catches cases like repeated git commits with slightly different messages
    if (recentCalls.length >= MAX_SIMILAR_TOOL_CALLS) {
      const toolName = recentCalls[0].name;
      const allSameTool = recentCalls.every(tc => tc.name === toolName);
      if (allSameTool && toolName === 'Bash') {
        // For Bash, check if the command pattern is similar
        const commands = recentCalls.map(tc => (tc.input?.command as string) || '');
        const patterns = commands.map(cmd => {
          // Normalize command to detect patterns (remove variable parts)
          return cmd
            .replace(/"[^"]*"/g, '""')  // Normalize quoted strings
            .replace(/'[^']*'/g, "''")  // Normalize single-quoted strings
            .slice(0, 50);  // Compare first 50 chars
        });
        const firstPattern = patterns[0];
        const allSimilar = patterns.every(p => p === firstPattern);
        if (allSimilar) {
          return {
            isRepetitive: true,
            reason: `Agent stuck: made ${MAX_SIMILAR_TOOL_CALLS} similar Bash commands starting with "${firstPattern.slice(0, 30)}..."`,
          };
        }
      }
    }

    return { isRepetitive: false };
  }

  // Close the current reasoning phase as a milestone
  private closePhase(worker: LocalWorker) {
    if (!worker.phaseText || worker.phaseToolCount === 0) return;
    const milestone: Milestone = {
      type: 'phase',
      label: extractPhaseLabel(worker.phaseText),
      toolCount: worker.phaseToolCount,
      ts: worker.phaseStart || Date.now(),
    };
    this.addMilestone(worker, milestone);
    worker.phaseText = null;
    worker.phaseStart = null;
    worker.phaseToolCount = 0;
    worker.phaseTools = [];
  }

  private addMilestone(worker: LocalWorker, milestone: Milestone) {
    worker.milestones.push(milestone);
    // Keep last 50 milestones; prioritize phases/checkpoints over actions when trimming
    if (worker.milestones.length > 50) {
      const actionIdx = worker.milestones.findIndex(m => m.type === 'action');
      if (actionIdx >= 0) {
        worker.milestones.splice(actionIdx, 1);
      } else {
        worker.milestones.shift();
      }
    }
    this.emit({ type: 'milestone', workerId: worker.id, milestone });

    // Sync this worker immediately so web dashboard sees milestones right away
    if (worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting') {
      this.workerSync.syncWorkerToServer(worker).catch(() => {});
    }
  }

  // Fire a meaningful checkpoint milestone (each event fires at most once per worker)
  private addCheckpoint(worker: LocalWorker, event: CheckpointEventType) {
    if (!worker.checkpointEvents) worker.checkpointEvents = new Set<CheckpointEventType>();
    if (worker.checkpointEvents.has(event)) return;
    worker.checkpointEvents.add(event);
    this.addMilestone(worker, {
      type: 'checkpoint',
      event,
      label: CHECKPOINT_LABELS[event],
      ts: Date.now(),
    });
  }

  async abort(workerId: string, reason?: string) {
    return this.recoveryManager.abort(workerId, reason);
  }

  getSessionLogs(workerId: string, maxLines = 100) {
    return readSessionLogs(workerId, maxLines);
  }

  async rollback(workerId: string, checkpointUuid: string, dryRun = false): Promise<{ success: boolean; error?: string; filesChanged?: number; insertions?: number; deletions?: number }> {
    return this.recoveryManager.rollback(workerId, checkpointUuid, dryRun);
  }

  async retry(workerId: string) {
    return this.recoveryManager.retry(workerId);
  }

  async recover(workerId: string, mode: 'diagnose' | 'complete' | 'restart') {
    return this.recoveryManager.recover(workerId, mode);
  }

  async markDone(workerId: string) {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'done';
      worker.currentAction = 'Marked done';
      await this.buildd.updateWorker(workerId, { status: 'completed' });
      this.emit({ type: 'worker_update', worker });
    }
  }

  async sendMessage(workerId: string, message: string): Promise<boolean> {
    let worker = this.workers.get(workerId);

    // If evicted from memory, try loading from disk (24h TTL) for resume
    if (!worker) {
      const diskWorker = storeLoadWorker(workerId);
      if (diskWorker && (diskWorker.status === 'done' || diskWorker.status === 'error')) {
        this.workers.set(workerId, diskWorker);
        worker = diskWorker;
        console.log(`[Worker ${workerId}] Restored from disk for follow-up (status: ${diskWorker.status})`);
      }
    }

    if (!worker) {
      return false;
    }

    const session = this.sessions.get(workerId);

    // If worker is done, errored, stale, or waiting with no session — restart with a new session.
    // Handle both cases: session already cleaned up (!session) or still lingering
    // during the completion window (race between status='done' and finally-block cleanup).
    // 'waiting' without a session happens when AskUserQuestion causes the SDK to send a result
    // (ending the for-await loop) but the worker stays in waiting status — the finally block
    // cleans up the session, so the user's late answer needs a fresh resume.
    if (worker.status === 'done' || worker.status === 'error' || (worker.status === 'stale' && !session) || (worker.status === 'waiting' && !session)) {
      // If old session is still lingering (race condition), clean it up first
      if (session) {
        session.abortController.abort();
        session.inputStream.end();
        this.sessions.delete(workerId);
      }
      console.log(`Restarting session for worker ${workerId} with follow-up message`);

      // Update worker status (clear any previous error)
      worker.status = 'working';
      worker.error = undefined;
      worker.currentAction = 'Processing follow-up...';
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      worker.completedAt = undefined;
      this.addChatMessage(worker, { type: 'user', content: message, timestamp: Date.now() });
      this.addMilestone(worker, { type: 'status', label: `User: ${message.slice(0, 30)}...`, ts: Date.now() });
      this.emit({ type: 'worker_update', worker });
      storeSaveWorker(worker);

      // Update server
      await this.buildd.updateWorker(worker.id, { status: 'running', currentAction: 'Processing follow-up...' });

      // Get workspace path
      const workspacePath = this.resolver.resolve({
        id: worker.workspaceId,
        name: worker.workspaceName,
        repo: undefined,
      });

      if (!workspacePath) {
        console.error(`Cannot resolve workspace for worker: ${worker.id}`);
        worker.status = 'error';
        worker.error = 'Cannot resolve workspace path - check PROJECTS_ROOT or set a path override';
        worker.currentAction = 'Workspace not found';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        this.emit({ type: 'worker_update', worker });
        await this.buildd.updateWorker(worker.id, { status: 'failed', error: worker.error });
        return false;
      }

      // Use worktree path for resume if available (session was created in worktree)
      const sessionCwd = worker.worktreePath && existsSync(worker.worktreePath)
        ? worker.worktreePath
        : workspacePath;

      // Resume session with automatic fallback: SDK resume → reconstructed context
      this.recoveryManager.resumeSession(worker, sessionCwd, message).catch(err => {
        console.error(`[Worker ${worker.id}] Resume failed:`, err);
        if (worker.status === 'working') {
          worker.status = 'error';
          worker.error = err instanceof Error ? err.message : 'Follow-up session failed';
          worker.currentAction = 'Follow-up failed';
          worker.hasNewActivity = true;
          worker.completedAt = Date.now();
          this.emit({ type: 'worker_update', worker });
        }
      });

      return true;
    }

    // Normal case - active session (also handle 'waiting' and 'stale' status)
    if (!session || !['working', 'waiting', 'stale'].includes(worker.status)) {
      return false;
    }

    // Permission request: route to resolvePermission
    if (worker.status === 'waiting' && worker.waitingFor?.type === 'permission') {
      const decision = message === 'Deny' ? 'deny'
        : message === 'Always allow' ? 'allow_always'
        : 'allow';  // "Allow once" or any other text
      return this.resolvePermission(workerId, decision);
    }

    try {
      // Build the response message with proper tool_use linkage
      const parentToolUseId = worker.waitingFor?.toolUseId;
      const sessionId = worker.sessionId;
      if (parentToolUseId) {
        console.log(`[Worker ${worker.id}] Responding to tool_use ${parentToolUseId} with sessionId=${sessionId}`);
      }
      session.inputStream.enqueue(buildUserMessage(message, {
        parentToolUseId,
        sessionId,
      }));
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      // Clear waiting/stale state
      const wasWaiting = worker.status === 'waiting';
      if (worker.status === 'waiting') {
        worker.status = 'working';
        worker.waitingFor = undefined;
        worker.currentAction = 'Processing response...';
      } else if (worker.status === 'stale') {
        worker.status = 'working';
        worker.currentAction = 'Processing message...';
      }
      this.addChatMessage(worker, { type: 'user', content: message, timestamp: Date.now() });
      this.addMilestone(worker, { type: 'status', label: `User: ${message.slice(0, 30)}...`, ts: Date.now() });
      this.emit({ type: 'worker_update', worker });
      // Immediately sync cleared waiting state to server
      if (wasWaiting) {
        this.buildd.updateWorker(worker.id, {
          status: 'running',
          currentAction: 'Processing response...',
          waitingFor: null,
        }).catch(() => {});
      }
      return true;
    } catch (err) {
      console.error('Failed to send message:', err);
      return false;
    }
  }

  destroy() {
    // Persist all current workers before shutdown (graceful save)
    for (const worker of this.workers.values()) {
      try {
        storeSaveWorker(worker);
      } catch (err) {
        console.error(`[WorkerStore] Failed to save worker ${worker.id} on destroy:`, err);
      }
    }

    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
    }
    if (this.diskPersistInterval) {
      clearInterval(this.diskPersistInterval);
    }
    if (this.envScanInterval) {
      clearInterval(this.envScanInterval);
    }
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
    }
    if (this.claimPollInterval) {
      clearInterval(this.claimPollInterval);
    }
    // Unsubscribe from all Pusher channels and disconnect
    this.pusherManager.destroy();
    // Abort all active sessions and clean up worktrees
    for (const [workerId, session] of this.sessions.entries()) {
      session.abortController.abort();
      session.inputStream.end();

      // Synchronously clean up worktrees on destroy
      const worker = this.workers.get(workerId);
      if (worker?.worktreePath) {
        try {
          const cp = require('child_process');
          cp.execSync(`git worktree remove --force "${worker.worktreePath}"`, {
            cwd: session.repoPath,
            timeout: 5000,
          });
        } catch {
          try {
            const fs = require('fs');
            fs.rmSync(worker.worktreePath, { recursive: true, force: true });
          } catch {}
        }
      }
    }
    this.sessions.clear();
  }
}
