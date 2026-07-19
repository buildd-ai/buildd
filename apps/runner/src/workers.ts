import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, LocalUIConfig, BuilddTask, WorkerCommand, ChatMessage, TeamState, Checkpoint, SubagentTask, CheckpointEventType } from './types';
import { createBackend, ClaudeBackend, inferSandboxMode } from './backends/index.js';
import { CheckpointEvent, CHECKPOINT_LABELS } from './types';
import { BuilddClient } from './buildd';
import { createWorkspaceResolver, type WorkspaceResolver } from './workspace';
import { type SkillBundle, resolveOutputFormat, RUNNER_HEARTBEAT_INTERVAL_MS } from '@buildd/shared';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { materializeCodexAuth, writeCodexMcpConfig, cleanupCodexAuth, materializeStableCodexHome, seedCodexAuthIfMissing, ensureStableCodexHome, teardownStableCodexHome, readCodexAuthJson, writeCodexApiKeyToHome, checkCodexCredentialExpiry, stableCodexHomePath } from './codex-auth.js';
import { materializeClaudeConfigDir, cleanupClaudeConfigDir } from './claude-auth.js';
import { syncSkillToLocal } from './skills.js';
import { syncRoleToLocal, resolveRoleEnv, getRoleDir, overlayRoleFiles, type RoleConfig } from './roles.js';
import {
  buildCodexInstructionDoc,
  writeCodexAgentsMd,
  restoreCodexAgentsMd,
  DONE_SENTINEL,
  type AgentsMdWriteResult,
} from './codex-instructions.js';
import { setupWorktree, cleanupWorktree, collectGitStats } from './git-operations';
import { buildRetryContinuitySection } from './worktree-utils';
import { PusherManager } from './pusher-manager';
import { authContextOf, classifyClaimError, isAuthError, ContextBreaker } from './claim-breaker';
import { createKnowledgeIngestPoller, type KnowledgeIngestPoller } from './knowledge-ingest';
import { CredentialCache, authBackoffMs } from './credential-cache';
import { saveWorker as storeSaveWorker, loadAllWorkers, loadWorker as storeLoadWorker, deleteWorker as storeDeleteWorker } from './worker-store';
import { scanEnvironment, checkMcpPreFlight } from './env-scan';
import { runProvisionGate } from './env-verify';
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
import { resolveClaudeBinaryPath } from './sdk-binary-path';
import { HookFactory } from './hook-factory';
import { scanToolResult, clearWorkerThrottle } from './error-trace-scanner';
import { RecoveryManager } from './recovery';
import { applyCommandLifecycle, emptyCommandLifecycle } from './command-lifecycle';
import { WorkerSync, extractPhaseLabel, isEphemeralTestBranch } from './worker-sync';
// Re-export for backwards compatibility (tests import from './workers')
export { isEphemeralTestBranch };

type EventHandler = (event: any) => void;
type CommandHandler = (workerId: string, command: WorkerCommand) => void;

// RUNNER_POLL_MIN and RUNNER_HEARTBEAT_INTERVAL_MS come from @buildd/shared so
// the server-side liveness thresholds always use the same value as the runner.

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
  backend?: ClaudeBackend;  // Stored for queryInstance access after runStreamed() starts
}

// Constants for repetition detection
const MAX_IDENTICAL_TOOL_CALLS = 5;   // Nudge at 5 identical calls; abort at 2×
const MAX_SIMILAR_TOOL_CALLS = 15;    // Nudge at 15 similar non-benign Bash calls; abort at 2×

// Bash command tokens that are safe exploration — never count toward the repetition check
const BENIGN_BASH_FIRST_TOKENS = new Set([
  'cd', 'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'echo',
]);
// git subcommands that are read-only — safe under "git <sub>" or "cd ... && git <sub>"
const BENIGN_GIT_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'branch', 'checkout', 'fetch', 'rev-parse', 'cat-file',
]);

// Strip a leading "cd <path> &&" or "cd <path>;" prefix so we can inspect the real command
function stripCdPrefix(cmd: string): string {
  const m = cmd.match(/^cd\s+\S+\s*(?:&&|;)\s*([\s\S]*)/);
  return m ? m[1].trimStart() : cmd.trimStart();
}

function isBenignBashCommand(cmd: string): boolean {
  const effective = stripCdPrefix(cmd);
  const tokens = effective.split(/\s+/);
  const first = tokens[0];
  if (!first) return false;
  if (BENIGN_BASH_FIRST_TOKENS.has(first)) return true;
  if (first === 'git') {
    const sub = tokens[1];
    return sub !== undefined && BENIGN_GIT_SUBCOMMANDS.has(sub);
  }
  return false;
}

// Check if Claude Code credentials exist (OAuth or API key)
// We don't validate - just check if credentials exist
/**
 * Pick the server-managed credentials (delivered inline on the claim response)
 * that the worker should use.
 *
 * Regression guard for the prod outage where Claude-backend tasks failed with
 * `401 Invalid authentication credentials`: these credentials MUST be captured
 * whenever the claim response carries them, independent of whether the runner
 * has any local credentials. A stale/invalid local credential (an expired
 * `~/.claude.json` oauthAccount, a leftover `.credentials.json`, etc.) makes
 * `hasClaudeCredentials()` return true even when those creds no longer work, so
 * gating capture on `!hasCredentials` silently dropped the valid server token.
 *
 * Final precedence (explicitly-set env var wins) is enforced downstream at
 * injection time via the `!cleanEnv.X` guards; this only decides what to carry.
 */
export function selectServerCredentials(claimed: {
  serverApiKey?: string;
  serverOauthToken?: string;
}): { serverApiKey?: string; serverOauthToken?: string } {
  return {
    serverApiKey: claimed.serverApiKey || undefined,
    serverOauthToken: claimed.serverOauthToken || undefined,
  };
}

// An MCP connector resolved server-side at claim time (credentials already
// decrypted). `transport` selects the SDK entry shape; `http` carries url/headers,
// `stdio` carries command/args/env. Mirrors the claim route's ResolvedMcpConnector.
// When `assertionMode` is true, the runner performs mint + exchange before connecting.
export interface ResolvedMcpConnector {
  id?: string;
  name: string;
  transport?: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  // assertion-mode fields (assertionMode=true → runner performs mint+exchange before connecting)
  assertionMode?: true;
  mintApiUrl?: string;
  audience?: string;
  tokenEndpoint?: string;
}

type SdkMcpServerEntry =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/**
 * Map claim-time connector entries to the SDK `mcpServers` record shape, keyed by
 * connector name. Handles both transports; entries missing their required fields
 * for the declared transport are skipped (never merged half-formed). Pure — unit
 * tested in apps/runner/__tests__/unit/mcp-connectors.test.ts.
 */
export function buildMcpServerEntries(
  connectors: ResolvedMcpConnector[] | undefined,
): Record<string, SdkMcpServerEntry> {
  const out: Record<string, SdkMcpServerEntry> = {};
  if (!connectors) return out;
  for (const c of connectors) {
    if (!c?.name) continue;
    // Assertion-mode connectors require async mint+exchange — skip here; handled separately.
    if (c.assertionMode) continue;
    // Default to http for back-compat with older claim payloads that omit transport.
    const transport = c.transport ?? 'http';
    if (transport === 'stdio') {
      if (!c.command) continue;
      out[c.name] = {
        type: 'stdio',
        command: c.command,
        ...(c.args && c.args.length > 0 ? { args: c.args } : {}),
        ...(c.env && Object.keys(c.env).length > 0 ? { env: c.env } : {}),
      };
    } else {
      if (!c.url) continue;
      out[c.name] = {
        type: 'http',
        url: c.url,
        ...(c.headers && Object.keys(c.headers).length > 0 ? { headers: c.headers } : {}),
      };
    }
  }
  return out;
}

// Re-export for backward compat + direct use in this module.
export { exchangeAssertionConnector } from './assertion-exchange.js';
import { exchangeAssertionConnector } from './assertion-exchange.js';

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

// Cache key for the per-team server-managed credential cache. Prefer the
// workspace's teamId (team-wide secrets cover all workspaces) and fall back to
// the workspaceId so a task without team info still gets a stable, scoped key.
export function teamKeyOf(task: Pick<BuilddTask, 'workspaceId' | 'workspace'> | null | undefined): string {
  return task?.workspace?.teamId || task?.workspaceId || 'default';
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
  // One-shot timer that wakes the runner to poll the moment an exhausted OAuth
  // budget resets, instead of waiting up to a full hour for the fallback poll.
  private budgetResumeTimer?: Timer;
  private viewerToken?: string;
  private dirtyWorkers = new Set<string>();
  private dirtyForDisk = new Set<string>();
  // Circuit breaker: pause claims when quota exhausted or repeated rapid failures
  private consecutiveQuickFailures = 0;
  private claimsPaused = false;
  private claimsPausedUntil = 0;
  // Per-auth-context breaker — scoped errors (quota, auth, billing) pause only
  // the affected account or tenant so other contexts keep claiming.
  private contextBreaker = new ContextBreaker();
  // workerId → auth context the worker was started under, for breaker routing on error.
  private workerAuthContexts = new Map<string, string>();
  // workerId → team cache key, so an auth failure can invalidate the right
  // cached server credential.
  private workerTeamKeys = new Map<string, string>();
  // In-memory per-team server-managed credential cache (NEVER persisted). Lets
  // a runner with zero local creds run off server-injected creds between claims.
  private credCache = new CredentialCache();
  // Auth-failure burn-loop guard: consecutive auth failures drive exponential
  // backoff on claims so a runner with no valid cred doesn't claim-then-fail forever.
  private consecutiveAuthFailures = 0;
  private environment?: WorkerEnvironment;
  private envScanInterval?: Timer;
  private hookFactory: HookFactory;
  private recoveryManager: RecoveryManager;
  private workerSync: WorkerSync;
  // Full knowledge-ingest jobs (KM v2 A2) — claimed only when this runner is idle.
  private knowledgeIngestPoller: KnowledgeIngestPoller;
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

    // Runner-executed full knowledge-ingest jobs (KM v2 spec §3.3, A2).
    // Opt-out via KNOWLEDGE_INGEST_JOBS=0; polls only on idle heartbeat ticks.
    this.knowledgeIngestPoller = createKnowledgeIngestPoller({
      builddServer: config.builddServer,
      apiKey: config.apiKey,
      scanRepos: () => this.resolver.scanGitRepos(),
    });

    // Send heartbeat to register availability (immediate + periodic)
    // Heartbeat is now a lightweight ping (no workspace queries server-side)
    if (!config.serverless) {
      // Startup hits (one-time, before the aligned loop kicks in).
      this.sendHeartbeat();
      this.reconcileLocalWorkers().catch(err => {
        console.warn('[Reconcile] Startup reconciliation failed:', err instanceof Error ? err.message : err);
      });

      // Single aligned tick — heartbeat, reconcile, and claim-fallback all
      // fire together so the DB sees one burst per cycle and a long quiet
      // stretch in between (lets Neon suspend). Pusher delivers tasks in
      // realtime; the claim poll here only matters if Pusher silently fails.
      this.heartbeatInterval = setInterval(() => {
        this.sendHeartbeat();
        this.reconcileLocalWorkers().catch(err => {
          console.warn('[Reconcile] Periodic reconciliation failed:', err instanceof Error ? err.message : err);
        });
        const active = Array.from(this.workers.values()).filter(
          w => w.status === 'working' || w.status === 'stale'
        ).length;
        if (active < this.config.maxConcurrent) {
          this.claimPendingTasks().catch(() => {});
        }
        // Idle runners pick up full knowledge-ingest jobs (fire-and-forget;
        // the poller serializes itself and never throws).
        if (active === 0) {
          this.knowledgeIngestPoller.poll().catch(() => {});
        }
      }, RUNNER_HEARTBEAT_INTERVAL_MS);
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

    // Sweep stale worktrees. Each worktree now carries a full node_modules (see
    // setupWorktree / installWorkspaceDeps), so worktrees leaked by crashed or
    // aborted runs are no longer cheap — reclaim them on the cleanup cadence
    // instead of only when `--doctor` is invoked manually. The sweep has its own
    // safety gates (idle > 1h, not owned by a live worker, branch pushed or
    // orphaned), so it never touches an active worktree.
    try {
      const { fixStaleWorktrees } = await import('./doctor');
      const result = fixStaleWorktrees();
      if (result.message && !result.message.startsWith('No stale')) {
        console.log(`[Cleanup] Worktree sweep: ${result.message}`);
      }
    } catch (err) {
      console.warn('[Cleanup] Worktree sweep failed:', err instanceof Error ? err.message : err);
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
        this.workerAuthContexts.delete(id);
        this.workerTeamKeys.delete(id);
        clearWorkerThrottle(id);
        storeDeleteWorker(id);
        // Terminal teardown: now safe to delete the stable Codex home (and its
        // resumable sessions) — the worker is fully purged, no follow-up possible.
        if (worker.taskBackend === 'codex') teardownStableCodexHome(id);
        count++;
      }
    }
    // Remove from disk (workers not in memory)
    for (const worker of loadAllWorkers()) {
      if (worker.status === 'done' || worker.status === 'error') {
        storeDeleteWorker(worker.id);
        if (worker.taskBackend === 'codex') teardownStableCodexHome(worker.id);
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
    // NOTE: we intentionally do NOT gate on `hasCredentials` here. A runner with
    // zero local creds must still poll — server-managed credentials arrive inline
    // on the claim response and bootstrap it. The burn-loop guard below (auth-error
    // backoff via the circuit breaker) is what prevents claim-then-fail-forever
    // when neither local nor valid server creds exist.

    // Circuit breaker: pause claims after repeated rapid failures (e.g., quota
    // exhaustion) or an auth-failure backoff window (no valid credential).
    if (this.claimsPaused) {
      if (Date.now() < this.claimsPausedUntil) return [];
      console.log('[WorkerManager] Circuit breaker reset — resuming claims');
      this.claimsPaused = false;
      this.consecutiveQuickFailures = 0;
      this.consecutiveAuthFailures = 0;
      this.emit({ type: 'circuit_breaker', paused: false, pausedUntil: 0, reason: 'reset' });
    }

    const activeWorkers = Array.from(this.workers.values()).filter(
      w => w.status === 'working' || w.status === 'stale'
    );
    const slots = this.config.maxConcurrent - activeWorkers.length;
    if (slots <= 0) return [];

    try {
      // No specific workspace: this is the autonomous cross-workspace poll. Opt
      // in explicitly so a multi-workspace OAuth token is allowed to claim the
      // next pending task across all accessible workspaces (server ranks/picks),
      // rather than being rejected by the ambiguous-claim guard.
      const { workers: claimed, diagnostics, budgetResetsAt } = await this.buildd.claimTask(slots, undefined, this.config.localUiUrl, undefined, undefined, true, this.environment);

      // Server reports account budget exhausted but still served tenant tasks.
      // Emit an informational event for the UI — no circuit breaker needed since
      // the server filters non-tenant tasks correctly.
      if (budgetResetsAt) {
        const resetMs = new Date(budgetResetsAt).getTime();
        const delayMs = Math.max(0, resetMs - Date.now());
        console.warn(`[WorkerManager] Account OAuth budget exhausted — resets at ${budgetResetsAt} (${Math.round(delayMs / 60_000)} min)`);
        this.emit({ type: 'budget_exhausted', budgetResetsAt, delayMs });
        // Wake up to poll the instant the budget resets. Without this the runner
        // only recovered on its hourly fallback poll (RUNNER_HEARTBEAT_INTERVAL_MS)
        // — the budget-reset re-queue deliberately emits `task:updated`, which the
        // Pusher subscriber ignores, so there is no realtime nudge. That left work
        // stalled for up to an hour after the budget was back (2026-07-11 incident).
        this.scheduleBudgetResume(budgetResetsAt);
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
        } else if (task.roleSlug && !task.workspace?.repo) {
          // No roleConfig from claim (role registered via MCP but not uploaded to R2
          // storage — configStorageKey/configHash absent). Fall back to the locally-
          // synced role directory so service-role workers load the correct .mcp.json,
          // CLAUDE.md, and env-mapping.json instead of the empty workspace directory.
          const localRoleDir = getRoleDir(task.roleSlug as string);
          if (existsSync(localRoleDir)) {
            resolvedPath = localRoleDir;
            console.log(`[Worker ${claimedWorker.id}] Using local role dir as cwd (no roleConfig from claim): ${localRoleDir}`);
          }
        }
        this.workerAuthContexts.set(claimedWorker.id, authContextOf(task));
        const worker = await this.startFromClaim(claimedWorker, task, resolvedPath);
        if (worker) started.push(worker);
      }
      return started;
    } catch (err: any) {
      const errMsg = err?.message || '';
      // Server-side account OAuth budget exhaustion — pause only the account
      // context so tenant tasks can still be claimed on later polls.
      if (errMsg.includes('429') && (errMsg.includes('budget exhausted') || errMsg.includes('Budget exhausted'))) {
        const pauseMs = 60 * 60 * 1000;
        const untilMs = Date.now() + pauseMs;
        this.contextBreaker.pause('account', untilMs);
        console.warn('[WorkerManager] Server: OAuth budget exhausted — pausing account claims ~60 min');
        this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: untilMs, reason: 'Server: OAuth budget exhausted (account)' });
      } else {
        console.error('Failed to claim pending tasks:', err);
      }
      return [];
    }
  }

  /**
   * Schedule a one-shot poll for the moment an exhausted OAuth budget resets.
   *
   * The server clears the exhaustion flag lazily on the next claim, and the
   * budget-reset re-queue emits `task:updated` (not `task:assigned`) to avoid a
   * realtime re-fire storm — so nothing wakes the runner at reset time. This
   * timer closes that gap: it fires just after `budgetResetsAt`, at which point
   * the claim clears the flag and picks up the tasks that were held.
   *
   * Idempotent (reschedules on each report) and self-healing: if the budget is
   * somehow still blocked when it fires, the server returns `budgetResetsAt`
   * again and this reschedules.
   */
  private scheduleBudgetResume(budgetResetsAt: string) {
    const resetMs = new Date(budgetResetsAt).getTime();
    if (Number.isNaN(resetMs)) return;
    // Small buffer so we land after the reset boundary the server checks.
    const delayMs = Math.max(0, resetMs - Date.now()) + 5_000;
    // Guard against a bad/implausible reset time scheduling a useless far-future
    // timer; the hourly fallback poll still covers anything beyond this.
    const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
    if (delayMs > MAX_DELAY_MS) return;
    if (this.budgetResumeTimer) clearTimeout(this.budgetResumeTimer);
    this.budgetResumeTimer = setTimeout(() => {
      this.budgetResumeTimer = undefined;
      const active = Array.from(this.workers.values()).filter(
        w => w.status === 'working' || w.status === 'stale'
      ).length;
      if (active < this.config.maxConcurrent) {
        console.log('[WorkerManager] Budget reset reached — polling for held tasks');
        this.claimPendingTasks().catch(() => {});
      }
    }, delayMs);
    // Don't let this timer alone keep the process alive.
    (this.budgetResumeTimer as any)?.unref?.();
  }

  /**
   * Burn-loop guard for an auth failure on a spawned worker.
   *
   * A runner with neither local nor valid server credentials would otherwise
   * claim-then-fail forever. On an auth failure we:
   *   1. Invalidate the cached server credential for the worker's team, so a
   *      rotated/fixed credential is picked up promptly on the next claim
   *      rather than serving the cached-bad one.
   *   2. Pause the affected auth context via the per-context breaker (the
   *      account/tenant that failed), so other contexts keep claiming.
   *   3. Pause global claims with exponential backoff keyed to the count of
   *      consecutive auth failures, so polling backs off instead of hammering.
   *
   * Resumes after the backoff window (or when a credential change resets the
   * counter via a successful claim/completion).
   */
  private handleAuthFailure(workerId: string): void {
    const teamKey = this.workerTeamKeys.get(workerId);
    if (teamKey) {
      this.credCache.invalidate(teamKey);
      console.warn(`[WorkerManager] Auth failure — invalidated cached server credential for team ${teamKey}`);
    }

    // Pause the affected auth context so sibling contexts keep claiming.
    const ctx = this.workerAuthContexts.get(workerId) ?? 'account';

    this.consecutiveAuthFailures++;
    const backoff = authBackoffMs(this.consecutiveAuthFailures);
    const until = Date.now() + backoff;
    this.contextBreaker.pause(ctx, until);

    // Also trip the global breaker: a runner with no valid credential at all
    // would keep claiming cross-context tasks and failing them identically.
    this.claimsPaused = true;
    this.claimsPausedUntil = Math.max(this.claimsPausedUntil, until);
    console.warn(`[WorkerManager] Circuit breaker: auth failure #${this.consecutiveAuthFailures} (context ${ctx}) — pausing claims ${Math.round(backoff / 1000)}s until ${new Date(until).toISOString()}`);
    this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: until, reason: `Auth failure #${this.consecutiveAuthFailures} (${ctx})` });
  }

  async claimAndStart(task: BuilddTask): Promise<LocalWorker | null> {
    // Scoped breaker: if this task's auth context is paused (e.g. account OAuth
    // quota exhausted), skip without re-claiming — tenant tasks can still run.
    const ctx = authContextOf(task);
    if (this.contextBreaker.isPaused(ctx)) {
      const until = this.contextBreaker.pausedUntil(ctx);
      console.log(`[WorkerManager] Context ${ctx} paused (until ${until ? new Date(until).toISOString() : 'unknown'}) — skipping Pusher assignment for task ${task.id}`);
      claimLog({ event: 'claim_empty', slotsRequested: 1, workersClaimed: 0, taskId: task.id, diagnosticReason: 'context_paused' });
      return null;
    }

    // Warn if no credentials found (but let SDK handle actual auth)
    if (!this.hasCredentials && !this.config.serverless) {
      console.warn('No Claude credentials found - task may fail. Run `claude login` to authenticate.');
    }

    // Claim from buildd first (pass taskId for targeted claiming). The claim
    // response carries the FULL task — including workspace.repo/name — whereas
    // the Pusher assignment payload is minimal and frequently omits
    // workspace.repo. Resolving from the minimal payload makes the resolver
    // fabricate a bogus 'project/unknown' directory (no origin/<branch>), so
    // worktree setup fails with "invalid reference: origin/<branch>". Resolve
    // from the full task instead — matching the polling path (claimPendingTasks).
    const { workers: claimed, diagnostics } = await this.buildd.claimTask(1, task.workspaceId, this.config.localUiUrl, task.id, undefined, false, this.environment);
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

    // Resolve workspace path from the FULL claimed task (see note above).
    const workspacePath = this.resolver.resolve({
      id: fullTask.workspaceId,
      name: fullTask.workspace?.name || 'unknown',
      repo: fullTask.workspace?.repo,
    });

    if (!workspacePath) {
      console.error(`Cannot resolve workspace for task: ${fullTask.title} (${fullTask.id}) — will skip on future retries`);
      this.pusherManager.markUnresolvable(task.id);
      // Fail the claimed worker on the server so it doesn't stay "running" forever
      this.buildd.updateWorker(claimedWorker.id, {
        status: 'failed',
        error: `Cannot resolve workspace "${fullTask.workspace?.name || 'unknown'}" (repo: ${fullTask.workspace?.repo || 'none'})`,
      }).catch(() => {});
      return null;
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
    } else if (fullTask.roleSlug && !fullTask.workspace?.repo) {
      // No roleConfig from claim (role registered via MCP but not uploaded to R2
      // storage — configStorageKey/configHash absent). Fall back to the locally-
      // synced role directory so service-role workers load the correct .mcp.json,
      // CLAUDE.md, and env-mapping.json instead of the empty workspace directory.
      const localRoleDir = getRoleDir(fullTask.roleSlug as string);
      if (existsSync(localRoleDir)) {
        resolvedPath = localRoleDir;
        console.log(`[Worker ${claimedWorker.id}] Using local role dir as cwd (no roleConfig from claim): ${localRoleDir}`);
      }
    }
    this.workerAuthContexts.set(claimedWorker.id, authContextOf(fullTask));
    return this.startFromClaim(claimedWorker, fullTask, resolvedPath);
  }

  private async startFromClaim(
    claimedWorker: { id: string; branch?: string; task?: BuilddTask; serverApiKey?: string; serverOauthToken?: string; claudeAccessToken?: string; claudeTokenExpiresAt?: string | null; mcpConnectors?: ResolvedMcpConnector[]; codexCredential?: { accessToken: string; refreshToken: string; accountId: string; expiresAt: Date | null }; roleConfig?: RoleConfig },
    fullTask: BuilddTask,
    workspacePath: string,
  ): Promise<LocalWorker | null> {

    // Refresh the runner heartbeat record immediately so the stale-workers cron
    // can't flag this worker dead due to a pre-existing stale/absent heartbeat.
    // Fire-and-forget — non-fatal if it fails.
    this.sendHeartbeat();

    // Use server-managed secrets (delivered inline during claim).
    //
    // These are ALWAYS captured when present — we must NOT gate them behind
    // `!this.hasCredentials`. A leftover/stale local credential (e.g. an
    // expired `~/.claude.json` oauthAccount or a `.credentials.json` from a
    // previous login) makes `hasClaudeCredentials()` return true even when
    // those creds are invalid; gating here silently dropped the valid
    // server-managed OAuth token and the worker spawned with broken local
    // auth, failing with `401 Invalid authentication credentials`.
    //
    // Precedence is enforced safely at injection time: the server-managed
    // values only fill an env var that isn't already explicitly set, so a
    // genuinely-configured ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN still
    // wins. Capturing them unconditionally just guarantees a working fallback.
    const fromClaim = selectServerCredentials(claimedWorker);
    const teamKey = teamKeyOf(fullTask);
    this.workerTeamKeys.set(claimedWorker.id, teamKey);

    // Populate/refresh the in-memory per-team cred cache from this claim's
    // payload (the common path — no extra endpoint needed).
    this.credCache.set(teamKey, {
      oauthToken: fromClaim.serverOauthToken,
      apiKey: fromClaim.serverApiKey,
    });

    // Prefer the freshly-delivered claim credential; otherwise fall back to a
    // fresh cached entry for this team (e.g. the server didn't re-inject on this
    // particular claim but a valid one was delivered recently).
    let serverApiKey = fromClaim.serverApiKey;
    let serverOauthToken = fromClaim.serverOauthToken;
    if (!serverApiKey && !serverOauthToken) {
      const cached = this.credCache.get(teamKey);
      if (cached) {
        serverApiKey = cached.apiKey;
        serverOauthToken = cached.oauthToken;
        console.log(`[Worker ${claimedWorker.id}] Using cached server-managed credential for team ${teamKey}`);
      }
    }
    if (serverApiKey) {
      console.log(`[Worker ${claimedWorker.id}] Using server-managed API key`);
    }
    if (serverOauthToken) {
      console.log(`[Worker ${claimedWorker.id}] Using server-managed OAuth token`);
    }

    // Sequential enforcement for Codex: at most 1 active Codex worker per workspace.
    // Codex uses a shared 5-hour plan window, so concurrent runs exhaust it quickly.
    if (fullTask.backend === 'codex') {
      const activeCodexWorker = Array.from(this.workers.values()).find(w =>
        w.workspaceId === fullTask.workspaceId &&
        w.taskBackend === 'codex' &&
        (w.status === 'working' || w.status === 'stale') &&
        w.id !== claimedWorker.id,
      );
      if (activeCodexWorker) {
        console.log(`[Worker ${claimedWorker.id}] Codex sequential enforcement: workspace ${fullTask.workspaceId} already has active codex worker ${activeCodexWorker.id} — deferring`);
        this.buildd.updateWorker(claimedWorker.id, {
          status: 'failed',
          error: `Deferred: another Codex worker (${activeCodexWorker.id}) is already active in this workspace`,
        }).catch(() => {});
        return null;
      }
    }

    // Create local worker
    const worker: LocalWorker = {
      id: claimedWorker.id,
      taskId: fullTask.id,
      taskTitle: fullTask.title,
      taskDescription: fullTask.description,
      taskMode: fullTask.mode,
      taskBackend: fullTask.backend || 'claude',
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
    if (claimedWorker.claudeAccessToken) {
      worker.claudeAccessToken = claimedWorker.claudeAccessToken;
      worker.claudeTokenExpiresAt = claimedWorker.claudeTokenExpiresAt
        ? new Date(claimedWorker.claudeTokenExpiresAt)
        : null;
      console.log(`[Worker ${claimedWorker.id}] Received managed Claude access token`);
    }

    if (claimedWorker.mcpConnectors && claimedWorker.mcpConnectors.length > 0) {
      (worker as any).mcpConnectors = claimedWorker.mcpConnectors;
      console.log(`[Worker ${claimedWorker.id}] Received ${claimedWorker.mcpConnectors.length} MCP connector(s): ${claimedWorker.mcpConnectors.map(c => c.name).join(', ')}`);
    }
    if (claimedWorker.codexCredential) {
      worker.codexCredential = claimedWorker.codexCredential;
      console.log(`[Worker ${claimedWorker.id}] Received Codex credential for accountId=${claimedWorker.codexCredential.accountId}`);
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

    // NOTE: the provision gate (env-verify) runs inside startSession, once the
    // worker env (cleanEnv, with server creds + connector + role secrets injected)
    // is fully assembled — so env.required is checked against the values the agent
    // will actually see, not raw process.env. It still runs before the budget loop.

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

    if (pending.resolvePayloadType === 'canUseTool') {
      // canUseTool callback path: resolve with PermissionResult (not hookSpecificOutput)
      if (decision === 'allow') {
        pending.resolve({ behavior: 'allow' });
      } else if (decision === 'allow_always') {
        pending.resolve({ behavior: 'allow', updatedPermissions: pending.suggestions });
      } else {
        pending.resolve({ behavior: 'deny', message: 'Denied by user via runner' });
      }
    } else {
      // PermissionRequest hook path: resolve with hookSpecificOutput
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

    // Declared before try so the finally block can always clean up the correct
    // temp dir, even if the session is superseded by a newer generation.
    let codexHome: string | undefined;
    // Per-worker CLAUDE_CONFIG_DIR for managed claude_credential tokens.
    // Cleaned up in finally — never persist between runs (access_token is refreshed at claim time).
    let claudeConfigDir: string | undefined;
    // Codex AGENTS.md handle (Phase 2A): records whether we created or appended
    // to an AGENTS.md in the repo cwd so the finally block can restore/remove it
    // and avoid dirtying the repo.
    let codexAgentsMd: AgentsMdWriteResult | undefined;

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

      const isCodexTask = (task.backend || 'claude') === 'codex';

      // Phase 1C / R5 + B (seed-if-missing): Codex tasks use a STABLE per-worker
      // CODEX_HOME (keyed by worker id) so `sessions/` rollouts survive restarts.
      //
      // Auth seeding follows OpenAI's CI/CD guidance:
      //   "Seed auth.json only if missing; if you rewrite from the original secret
      //    every run you throw away the refreshed tokens."
      // - API key credential: inject as OPENAI_API_KEY; stable home holds config.toml only.
      // - OAuth credential: seed auth.json ONLY when missing (preserves CLI-refreshed tokens).
      // - No server credential: fall back to operator's local CODEX_HOME/auth.json.
      //
      // The home is torn down ONLY on true terminal teardown (purge past follow-up TTL)
      // — never in the finally block (would destroy resumable sessions).
      //
      // For non-Codex tasks that still carry a codexCredential (legacy/transient),
      // keep the temp-dir behavior (cleaned up in finally via `codexHome`).
      if (isCodexTask) {
        let _ch: string;
        if (worker.codexCredential?.credentialType === 'api_key' && worker.codexCredential.apiKey) {
          // A: API key credential — inject as env var. Stable home still needed for
          // config.toml (MCP servers, reasoning effort) but auth.json is not used.
          const { codexHome: home } = ensureStableCodexHome(worker.id);
          _ch = home;
          // Write api_key into auth.json so resolveAuth picks it up (codex-backend.ts
          // reads CODEX_HOME/auth.json; api_key there maps to OPENAI_API_KEY internally).
          writeCodexApiKeyToHome(_ch, worker.codexCredential.apiKey);
          console.log(`[Worker ${worker.id}] Injecting Codex API key credential`);
        } else if (worker.codexCredential?.credentialType === 'oauth') {
          // B (seed-if-missing): only write auth.json the first time. If auth.json
          // already exists (from a prior run), the CLI may have refreshed the tokens
          // — don't overwrite with the potentially staler stored snapshot.
          const { codexHome: home } = seedCodexAuthIfMissing(worker.id, worker.codexCredential);
          _ch = home;
        } else {
          _ch = ensureStableCodexHome(worker.id).codexHome;
        }
        // No server-injected credential: fall back to the operator's local Codex
        // auth (CODEX_HOME/auth.json on the runner host) if present, seeding it into
        // the stable home so resolveAuth/codex can authenticate. This matches the
        // claim route, which already advertises CODEX_HOME as a local-auth capability
        // — without this, a runner with only local OAuth creds passes the claim gate
        // but dies at the spawn guard below.
        if (!worker.codexCredential) {
          const localHome = process.env.CODEX_HOME;
          if (localHome && localHome !== _ch) {
            const localAuth = join(localHome, 'auth.json');
            if (existsSync(localAuth) && !existsSync(join(_ch, 'auth.json'))) {
              copyFileSync(localAuth, join(_ch, 'auth.json'));
            }
          }
        }
        cleanEnv.CODEX_HOME = _ch;
        const session = this.sessions.get(worker.id);
        if (session) (session as any).codexHome = _ch;

        // Codex reads MCP servers from CODEX_HOME/config.toml, not from Claude's
        // queryOptions. Rewrite it each run with the bearer token supplied via env
        // so it never lands in config.toml. Does not touch `sessions/`.
        cleanEnv.BUILDD_MCP_BEARER_TOKEN = this.config.apiKey;
        // Phase 3C: map buildd's configuredEffort → config.toml model_reasoning_effort
        // (ThreadOptions has no reasoning-effort field). task.context.effort wins
        // over the workspace gitConfig.effort, mirroring the Claude path below.
        const codexEffort = ((task.context as any)?.effort ?? gitConfig?.effort) as
          | 'low' | 'medium' | 'high' | 'max' | undefined;
        // Inject additional workspace/role MCP servers from .mcp.json so Codex workers
        // can reach them (e.g. Cue). The Claude path gets these via settingSources +
        // overlayRoleFiles; Codex reads only config.toml so they'd be silently dropped
        // without this. Bearer tokens are put in env vars (MCP_BEARER_<SLUG>), never
        // written into config.toml, mirroring BUILDD_MCP_BEARER_TOKEN above.
        // NOTE: mcpJsonPath is resolved here from startSession's own `cwd` — it is NOT
        // in scope from the caller, so referencing the caller's local would throw
        // "mcpJsonPath is not defined" (only the Codex path reads it, so the Claude
        // path never tripped this).
        const mcpJsonPath = join(cwd, '.mcp.json');
        const codexAdditionalServers: Array<{ name: string; url: string; bearerTokenEnvVar: string }> = [];
        if (existsSync(mcpJsonPath)) {
          try {
            const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as {
              mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
            };
            for (const [name, serverCfg] of Object.entries(mcpJson.mcpServers || {})) {
              if (name === 'buildd' || !serverCfg?.url) continue;
              const envVarName = `MCP_BEARER_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
              const authHeader = serverCfg.headers?.Authorization || serverCfg.headers?.authorization;
              if (authHeader) {
                const match = authHeader.match(/\$\{([^}]+)\}/);
                if (match) {
                  const sourceVar = match[1];
                  const tokenValue = cleanEnv[sourceVar];
                  if (tokenValue) cleanEnv[envVarName] = tokenValue;
                }
              }
              codexAdditionalServers.push({ name, url: serverCfg.url, bearerTokenEnvVar: envVarName });
            }
            if (codexAdditionalServers.length > 0) {
              console.log(`[Worker ${worker.id}] Injecting ${codexAdditionalServers.length} additional MCP server(s) into Codex config: ${codexAdditionalServers.map(s => s.name).join(', ')}`);
            }
          } catch (err) {
            console.warn(`[Worker ${worker.id}] Failed to parse .mcp.json for Codex MCP injection:`, err);
          }
        }
        writeCodexMcpConfig(_ch, {
          builddServer: this.config.builddServer,
          workspaceId: task.workspaceId,
          workerId: worker.id,
          bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
          ...(codexEffort ? { effort: codexEffort } : {}),
          ...(codexAdditionalServers.length > 0 ? { additionalMcpServers: codexAdditionalServers } : {}),
        });
        // NOTE: deliberately NOT assigning the local `codexHome` var here — that
        // var drives the finally-block teardown, which must not delete a stable
        // home (would destroy resumable sessions).
      } else if (worker.codexCredential) {
        // Non-Codex task with a Codex credential: transient temp home, cleaned up.
        const { codexHome: _ch } = materializeCodexAuth(worker.id, worker.codexCredential);
        codexHome = _ch;
        cleanEnv.CODEX_HOME = codexHome;
        const session = this.sessions.get(worker.id);
        if (session) (session as any).codexHome = codexHome;
      }

      // Claude credential isolation: when the claim supplied a managed access_token
      // (from claude_credential purpose), create a per-worker CLAUDE_CONFIG_DIR and
      // write credentials.json with ONLY the access_token (no refresh_token).
      // This prevents the SDK from calling the Anthropic refresh endpoint in-session,
      // eliminating the token family revocation cascade from concurrent workers.
      if (worker.claudeAccessToken) {
        const { claudeConfigDir: _cd } = materializeClaudeConfigDir(
          worker.id,
          worker.claudeAccessToken,
          worker.claudeTokenExpiresAt ?? null,
        );
        claudeConfigDir = _cd;
        cleanEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
        // Remove any injected CLAUDE_CODE_OAUTH_TOKEN — the credentials file takes precedence.
        delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
        console.log(`[Worker ${worker.id}] Using managed Claude access token via isolated CLAUDE_CONFIG_DIR`);
      }

      // Preflight C: fast-fail (<1s) before spawning Codex if the stored credential
      // is known-expired. The claim route (criterion D) already attempts a refresh
      // and clears the credential on unrecoverable failure — this is a second guard
      // for the window between claim and spawn (clock skew, race, long queue wait).
      if (isCodexTask && worker.codexCredential) {
        const expiryError = checkCodexCredentialExpiry(worker.codexCredential);
        if (expiryError) {
          throw new Error(
            `Codex credential expired: ${expiryError}. Reconnect your ChatGPT / OpenAI account in Settings → Credentials.`,
          );
        }
      }

      // Preflight: fail fast with a clear message if no Codex auth is available.
      // worker.codexCredential is set whenever a server credential row exists (even
      // if expired — the CLI refreshes it). Otherwise accept a local fallback that
      // resolveAuth can actually use: the runner's OPENAI_API_KEY (API-key auth) or a
      // local CODEX_HOME/auth.json (OAuth) seeded into the stable home above. This
      // mirrors the claim route's local-auth capability check.
      const codexAuthAvailable =
        Boolean(worker.codexCredential) ||
        Boolean(cleanEnv.OPENAI_API_KEY) ||
        (Boolean(cleanEnv.CODEX_HOME) && existsSync(join(cleanEnv.CODEX_HOME, 'auth.json')));
      if (isCodexTask && !codexAuthAvailable) {
        throw new Error(
          'No Codex credential configured. Connect a ChatGPT / OpenAI account in Settings → Credentials before running Codex tasks.',
        );
      }

      // Enable Agent Teams (SDK handles TeamCreate, SendMessage, TaskCreate/Update/List)
      cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

      // Resolve role env vars (secret labels → actual values)
      if (worker.roleConfig) {
        try {
          const roleEnv = await resolveRoleEnv(
            getRoleDir(worker.roleConfig.slug),
            process.env as Record<string, string>,
          );
          Object.assign(cleanEnv, roleEnv);
          console.log(`[Worker ${worker.id}] Resolved ${Object.keys(roleEnv).length} role env var(s) for ${worker.roleConfig.slug}`);
        } catch (err) {
          console.error(`[Worker ${worker.id}] Failed to resolve role env:`, err);
        }
      }

      // Provision gate — prove the environment is runnable BEFORE the budget loop.
      // cleanEnv is now fully assembled (server creds + connector + role secrets),
      // so env.required is validated against exactly what the agent will see, not
      // raw process.env. Enforcement is opt-in (only a declared .buildd/env.yaml
      // blocks); `install` is skipped because setupWorktree already ran the runner's
      // tolerant install. On a real block we throw — matching the codex-credential
      // guard above, so the outer catch marks the worker failed with this reason and
      // cleans up, with zero agent budget spent. A gate that itself errors fails
      // open. See docs/design/reliable-env-provisioning.md.
      try {
        // Base commit of the freshly-created worktree (== the branch's base at
        // gate time, before the agent modifies anything). Lets the gate reuse a
        // cached pass across tasks off the same base on this runner. Fail-open.
        let baseCommit: string | undefined;
        try {
          const cp = await import('child_process');
          const { promisify } = await import('util');
          const { stdout } = await promisify(cp.execFile)('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf-8' });
          baseCommit = stdout.trim() || undefined;
        } catch { /* no commit → gate runs fresh (no caching) */ }

        const gate = await runProvisionGate({ root: cwd, env: cleanEnv, skipPhases: ['install'], commit: baseCommit });
        if (gate.enforced) {
          for (const s of gate.steps) {
            console.log(`[Worker ${worker.id}] provision ${s.status} [${s.phase}] ${s.label} — ${s.message}`);
          }
          if (!gate.ok) {
            this.addMilestone(worker, { type: 'status', label: 'Provision failed', ts: Date.now() });
            // Attach the stable failure classification so the outer catch can
            // surface it as structured resultMeta (server/organizer act on the code).
            const provErr = new Error(gate.reason ?? 'Provision failed') as Error & { provisionFailure?: unknown };
            provErr.provisionFailure = gate.failure;
            throw provErr;
          }
          console.log(`[Worker ${worker.id}] Environment verified${gate.cached ? ' (cached)' : ''}`);
          this.addMilestone(worker, { type: 'status', label: gate.cached ? 'Environment verified (cached)' : 'Environment verified', ts: Date.now() });
        }
      } catch (gateErr) {
        const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
        if (msg.startsWith('Provision failed')) throw gateErr; // real block → outer catch reports it
        // Gate internals errored (not a policy block) — never wedge a task; log and proceed.
        console.warn(`[Worker ${worker.id}] Provision gate errored (proceeding): ${msg}`);
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

      // Inject retry-continuity prompt section when a usable resumeBranch is set.
      // If the prior attempt's branch was gone/diverged on remote, setupWorktree
      // has already cleared the resume fields from task.context (fresh start), so
      // this returns null and no "prior attempt" instructions are appended.
      // `defaultBranch` is derived here (not in this method's scope previously —
      // referencing it threw a ReferenceError on every resume).
      const retryContinuitySection = buildRetryContinuitySection({
        resumeBranch: (task.context as any)?.resumeBranch,
        lastCommitSha: (task.context as any)?.lastCommitSha,
        failureContext: (task.context as any)?.failureContext,
        defaultBranch: gitConfig?.defaultBranch || 'main',
      });
      if (retryContinuitySection) {
        systemPrompt.append = (systemPrompt.append ?? '') + retryContinuitySection;
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

      // Resolve SDK native binary explicitly — Bun's isolated linker layout
      // breaks the SDK's own resolver. See ./sdk-binary-path.ts.
      const pathToClaudeCodeExecutable = resolveClaudeBinaryPath();

      // Build query options
      const outputFormat = resolveOutputFormat(task);
      const queryOptions: Parameters<typeof query>[0]['options'] = {
        sessionId: worker.id,
        cwd,
        model: this.config.model,
        ...(fallbackModel ? { fallbackModel } : {}),
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
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
        // Structured output: planning tasks always get the planning schema (so the
        // plan returns as validated structured_output, not free-form text); an
        // explicit task.outputSchema wins. See @buildd/shared planning contract.
        ...(outputFormat ? { outputFormat } : {}),
        stderr: (data: string) => {
          console.log(`[Worker ${worker.id}] stderr: ${data}`);
        },
        // Resume previous session if provided (loads full conversation history from disk).
        // Claude-only: the Codex backend resumes via runStreamed's resumeThreadId
        // (R5), not this query option. resumeSessionId carries the Codex thread id
        // for Codex tasks, so don't feed it to Claude's resume there.
        ...(resumeSessionId && (task.backend || 'claude') !== 'codex' ? { resume: resumeSessionId } : {}),
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

      // Merge team MCP connectors resolved at claim time (role opt-in ∩ workspace-
      // enabled). Credentials were decrypted server-side; both http (url/headers)
      // and stdio (command/args/env) transports are supported. `buildd` is reserved.
      const claimConnectors = (worker as any).mcpConnectors as ResolvedMcpConnector[] | undefined;
      if (claimConnectors && claimConnectors.length > 0) {
        // Non-assertion connectors: build entries synchronously (credentials already decrypted).
        const entries = buildMcpServerEntries(claimConnectors);
        for (const [name, cfg] of Object.entries(entries)) {
          if (name === 'buildd') continue; // never override the buildd coordination server
          queryOptions.mcpServers[name] = cfg;
        }

        // Assertion-mode connectors: mint assertion → exchange at RS → mount with Bearer token.
        // Performed async here so the MCP entry has a real access token before the SDK starts.
        const assertionConns = claimConnectors.filter(c => c.assertionMode === true);
        for (const c of assertionConns) {
          if (c.name === 'buildd' || !c.url || !c.mintApiUrl || !c.tokenEndpoint) continue;
          try {
            const { accessToken, expiresAt } = await exchangeAssertionConnector(
              { mintApiUrl: c.mintApiUrl, tokenEndpoint: c.tokenEndpoint },
              this.config.apiKey,
              worker.id,
              worker.taskId,
            );
            queryOptions.mcpServers[c.name] = {
              type: 'http',
              url: c.url,
              headers: { Authorization: `Bearer ${accessToken}` },
            };
            // Cache token + metadata for mid-task re-auth (§F.2).
            worker.assertionTokenCache ??= new Map();
            worker.assertionConnectors ??= [];
            worker.assertionTokenCache.set(c.name, { accessToken, expiresAt });
            if (!worker.assertionConnectors.find(a => a.name === c.name)) {
              worker.assertionConnectors.push({ name: c.name, mintApiUrl: c.mintApiUrl, tokenEndpoint: c.tokenEndpoint });
            }
            console.log(`[Worker ${worker.id}] Assertion exchange succeeded for connector ${c.name} (expires ${new Date(expiresAt).toISOString()})`);
          } catch (err) {
            // Exchange failed — connector cannot be mounted. Log and continue (don't abort the task).
            console.error(`[Worker ${worker.id}] Assertion exchange failed for connector ${c.name}:`, err);
          }
        }

        const totalMounted = Object.keys(queryOptions.mcpServers).length - 1; // subtract 'buildd'
        console.log(`[Worker ${worker.id}] Merged ${totalMounted} MCP connector(s) into query options`);
      }

      // Attach permission hook (blocks dangerous commands, allows safe bash),
      // team tracking hook (captures TeamCreate, SendMessage, Task events),
      // and agent team lifecycle hooks (TeammateIdle, TaskCompleted, SubagentStart, SubagentStop).
      queryOptions.hooks = {
        PreToolUse: [{ hooks: [this.hookFactory.createPermissionHook(worker, { inputPolicy })] }],
        PostToolUse: [{ hooks: [this.hookFactory.createTeamTrackingHook(worker)] }],
        PostToolUseFailure: [{ hooks: [this.hookFactory.createMcpFailureHook(worker, queryOptions.mcpServers, this.config.apiKey)] }],
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

      // canUseTool: forward background agent permission prompts to the user instead of
      // auto-denying (SDK v0.3.186). agentID and requestId (v0.3.199) identify the
      // specific subagent and request for multi-agent routing.
      queryOptions.canUseTool = this.hookFactory.createCanUseToolCallback(worker, bypassPermissions);

      // Phase 2A — Codex role/skills/context via AGENTS.md.
      //
      // Claude receives its persona via systemPrompt.append, skills via the
      // Skill() allowlist, and CLAUDE.md via settingSources. Codex's ThreadOptions
      // has none of these (no instructions/system-prompt option in codex-sdk@0.44.0),
      // and there is no Skill tool. We therefore compose a single instruction
      // document — role persona + INLINED skill content + (optionally) project
      // CLAUDE.md + the <promise>DONE</promise> completion convention — and deliver
      // it through Codex's native AGENTS.md, which it re-reads from cwd on every
      // turn (durable across PR2's multi-turn review/nudge/steering loop, unlike a
      // first-turn-only prompt preamble). The DONE instruction is what lets PR2's
      // review-loop exit gate actually fire for Codex (R1). Must run before
      // promptArg is built so the prompt pointer below is included.
      if (isCodexTask) {
        try {
          // Role persona = the role's CLAUDE.md (the same text Claude loads from
          // the role dir via settingSources). Builder roles don't overlay it into
          // the repo, so read it straight from the synced role dir.
          let rolePersona: string | undefined;
          if (worker.roleConfig) {
            const rolePersonaPath = join(getRoleDir(worker.roleConfig.slug), 'CLAUDE.md');
            if (existsSync(rolePersonaPath)) {
              rolePersona = readFileSync(rolePersonaPath, 'utf-8');
            }
          }

          // Project instructions: include repo CLAUDE.md content when the workspace
          // opts into CLAUDE.md (mirrors Claude's settingSources project). We read
          // CLAUDE.md only — not a pre-existing AGENTS.md, which writeCodexAgentsMd
          // appends to (reading it back would duplicate content into our section).
          let projectInstructions: string | undefined;
          if (useClaudeMd) {
            const claudeMdPath = join(cwd, 'CLAUDE.md');
            if (existsSync(claudeMdPath)) {
              projectInstructions = readFileSync(claudeMdPath, 'utf-8');
            }
          }

          const instructionBody = buildCodexInstructionDoc({
            rolePersona,
            skillBundles: (skillBundles || []).map(b => ({ slug: b.slug, name: b.name, content: b.content })),
            projectInstructions,
          });

          codexAgentsMd = await writeCodexAgentsMd(cwd, instructionBody);
          console.log(`[Worker ${worker.id}] Wrote Codex AGENTS.md (${codexAgentsMd.existed ? 'appended to existing' : 'created'}) at ${codexAgentsMd.path}`);

          // Short pointer in the prompt so the very first turn is anchored to the
          // file even before the model decides to read it. AGENTS.md carries the
          // durable detail; this is just a nudge.
          promptText = `Read AGENTS.md in the working directory for your role, applicable skills, and completion criteria (emit ${DONE_SENTINEL} when fully done).\n\n${promptText}`;
        } catch (err) {
          console.error(`[Worker ${worker.id}] Failed to write Codex AGENTS.md:`, err);
        }
      }

      // Build prompt: use AsyncIterable<SDKUserMessage> when images are attached,
      // so image content blocks are included in the initial message to the agent.
      const promptArg: string | AsyncIterable<SDKUserMessage> = imageBlocks.length > 0
        ? (async function* () {
            yield buildUserMessage([
              { type: 'text', text: promptText },
              ...imageBlocks,
            ]);
          })()
        : promptText;

      // Infer sandboxMode from task.kind when not explicitly set
      const taskSandboxMode = (task.context as any)?.sandboxMode as 'read-only' | 'workspace-write' | undefined
        || inferSandboxMode(task.kind);

      // Select agent backend (claude default, codex if task.backend === 'codex')
      const taskBackend = (task.backend || 'claude') as 'claude' | 'codex';

      const backend = createBackend(taskBackend, taskBackend === 'claude' ? {
        options: queryOptions as Record<string, unknown>,
        inputStream,
        onInit: (qi: ReturnType<typeof query>) => {
          // Wire up queryInstance for rewindFiles() and model capability discovery
          const session = this.sessions.get(worker.id);
          if (session) {
            session.queryInstance = qi;
            session.backend = backend as ClaudeBackend;
          }
          discoverModelCapabilities(qi, worker, {
            effort: configuredEffort,
            thinking: configuredThinking,
            extendedContext,
          }, this.config.model, (e: any) => this.emit(e));
        },
      } : {
        // Codex branch: wire the shared MessageStream so review/nudge/steering
        // enqueues drive multi-turn runs on a persistent Codex thread (Phase 1B),
        // mirroring how the Claude branch consumes `inputStream` via streamInput.
        inputStream,
      });

      // Stream responses with ralph loop (prompt-based self-review)
      let resultSubtype: string | undefined;
      let structuredOutput: Record<string, unknown> | undefined;
      const taskTitle = worker.taskTitle || 'Untitled task';
      const ralphTaskDescription = worker.taskDescription || (task as any).description || '';
      const maxReviewIterations = (task.context as any)?.maxReviewIterations ?? 2;
      let reviewIteration = 0;
      let outputReqNudgeCount = 0;
      const maxOutputReqNudges = 2;

      // Codex rejects Claude model ids ("claude-* not supported with a ChatGPT
      // account"). The runner's configured model is Claude by default, so for Codex
      // tasks strip a Claude model id and let Codex use the account default (or a
      // genuine codex model id passes through). Claude tasks are unaffected.
      const backendModel = isCodexTask && /^claude/i.test(this.config.model || '')
        ? undefined
        : this.config.model;

      for await (const event of backend.runStreamed({
        prompt: promptArg as string | AsyncIterable<unknown>,
        sessionId: worker.id,
        cwd,
        ...(backendModel ? { model: backendModel } : {}),
        ...(maxTurns ? { maxTurns } : {}),
        sandboxMode: taskSandboxMode,
        env: cleanEnv,
        // R3: the Claude backend bakes abortController into its query options;
        // the Codex backend reads this signal to break its turn loop (no SDK
        // interrupt exists — breaking the event for-await kills `codex exec`).
        signal: abortController.signal,
        // R5: a Codex follow-up resumes the prior thread by id. resumeSessionId
        // carries worker.codexThreadId for Codex tasks (set by resumeSession).
        ...(resumeSessionId && taskBackend === 'codex' ? { resumeThreadId: resumeSessionId } : {}),
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        ...(task.outputSchema ? { outputSchema: task.outputSchema as Record<string, unknown> } : {}),
        onProgress: async (msg: unknown) => {
          const sdkMsg = msg as any;
          // Capture result metadata for post-loop handling
          if (sdkMsg.type === 'result') {
            resultSubtype = sdkMsg.subtype;
            console.log(`[Worker ${worker.id}] SDK result: subtype=${sdkMsg.subtype}, worker.status=${worker.status}`);
            if (worker.status === 'waiting') {
              console.log(`[Worker ${worker.id}] ⚠️ Result received while still waiting — toolUseId=${worker.waitingFor?.toolUseId}`);
            }
            if (sdkMsg.structured_output && typeof sdkMsg.structured_output === 'object') {
              structuredOutput = sdkMsg.structured_output;
            }
          }
          await this.handleMessage(worker, sdkMsg as SDKMessage);
        },
      })) {
        if (event.type === 'error') {
          throw new Error(event.error);
        }

        if (event.type === 'turn_complete') {
          // Sync structured output from BackendEvent (Codex path — Claude uses onProgress)
          if (event.structuredOutput && typeof event.structuredOutput === 'object') {
            structuredOutput = event.structuredOutput as Record<string, unknown>;
          }

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
              const sessionRef = this.sessions.get(worker.id);
              if (sessionRef) {
                const nudge = outputReq === 'pr_required'
                  ? 'You are not done yet — this task requires a pull request. Create one using `buildd` action: create_pr, then call complete_task.'
                  : 'You are not done yet — this task requires a deliverable. Create a PR (create_pr) or artifact (create_artifact), then call complete_task.';
                console.log(`[Worker ${worker.id}] Output requirement not met (${outputReq}) — nudging agent`);
                sessionLog(worker.id, 'info', 'output_requirement_nudge', outputReq, worker.taskId);
                this.addMilestone(worker, { type: 'status', label: `Output requirement nudge: ${outputReq}`, ts: Date.now() });
                worker.currentAction = `Creating ${outputReq === 'pr_required' ? 'PR' : 'deliverable'}...`;
                this.emit({ type: 'worker_update', worker });
                sessionRef.inputStream.enqueue(buildUserMessage(nudge, { sessionId: worker.id }));
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

          const sessionRef = this.sessions.get(worker.id);
          if (sessionRef) {
            sessionRef.inputStream.enqueue(buildUserMessage(reviewPrompt, { sessionId: worker.id }));
          }
          continue; // Don't break — keep streaming the agent's response
        }

        if (event.type === 'progress' && event.message) {
          const lines = event.message.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              worker.output.push(line);
              if (worker.output.length > 100) worker.output.shift();
              this.emit({ type: 'output', workerId: worker.id, line });
            }
          }
          worker.currentAction = event.message.slice(0, 120);
          worker.hasNewActivity = true;
          this.emit({ type: 'worker_update', worker });
        }

        // event.type === 'complete': backend loop ended naturally — break out
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
        // Re-send waitingFor so the dashboard can render the answer UI even
        // if the earlier sync got 409'd. Server preserves it on failed state.
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error,
          milestones: worker.milestones,
          ...(worker.waitingFor ? { waitingFor: worker.waitingFor as any } : {}),
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
      const authFailed = isAuthError(earlyOutput);

      if (authFailed) {
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
        // Burn-loop guard (cache invalidation + exponential backoff) is applied
        // by the circuit-breaker block below, which classifies worker.error.
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
        // A clean completion proves the credential works — reset the auth-failure
        // backoff so claims resume at full cadence.
        this.consecutiveAuthFailures = 0;
        const gitStats = await collectGitStats(this.sessions.get(worker.id)?.cwd, worker.id, worker.commits.length);

        // B (write-back): After a successful OAuth Codex session, the CLI may have
        // silently refreshed the tokens. Read the auth.json we left in place
        // (seed-if-missing means it was never rewritten from the stale snapshot) and
        // POST the current tokens back so the credential store stays fresh.
        // Best-effort — never throws, never logs token values.
        if (isCodexTask && worker.codexCredential?.credentialType === 'oauth') {
          try {
            const currentAuth = readCodexAuthJson(worker.id);
            if (currentAuth?.access_token && currentAuth?.refresh_token) {
              await this.buildd.writeBackCodexAuth(task.workspaceId, {
                accessToken: currentAuth.access_token,
                refreshToken: currentAuth.refresh_token,
                ...(currentAuth.account_id ? { accountId: currentAuth.account_id } : {}),
              });
              console.log(`[Worker ${worker.id}] Codex OAuth tokens written back to credential store`);
            }
          } catch (err) {
            console.warn(`[Worker ${worker.id}] Codex write-back warning (non-fatal): ${err instanceof Error ? err.message : 'unknown'}`);
          }
        }

        this.addMilestone(worker, { type: 'status', label: 'Task completed', ts: Date.now() });
        this.addCheckpoint(worker, CheckpointEvent.TASK_COMPLETED);
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
        // Set 'done' only after the server update so any poll of local status
        // reflects the server's task state (prevents getMission race in E2E tests).
        worker.status = 'done';
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
        // OAuth seat session caps ("You've hit your session limit") are a usage
        // exhaustion just like a dollar budget — flag them so the server fails
        // the task over (Codex) / holds it until reset instead of hard-failing.
        const isBudgetError = errLower.includes('budget') || errLower.includes('out of extra usage') ||
          errLower.includes('max budget') || errLower.includes('session limit') || errLower.includes('hit your session');
        // A provision-gate block carries a stable failure classification — surface
        // it as structured resultMeta so the server/organizer can act on the code
        // (escalate a missing secret vs. retry a flaky readiness) rather than
        // regex-matching the free-text error.
        const provisionFailure = (error as { provisionFailure?: unknown })?.provisionFailure;
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error,
          ...(isBudgetError && { budgetExhausted: true }),
          ...(provisionFailure ? { resultMeta: { provisionFailure } } : {}),
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

        // Clean up Codex auth temp dir (written before backend spawn).
        // Use the local var (not session.codexHome) so cleanup runs correctly
        // even when the session was superseded by a newer generation.
        if (codexHome) {
          cleanupCodexAuth(worker.id, codexHome);
        }

        // Clean up per-worker Claude config dir (access_token isolation).
        if (claudeConfigDir) {
          cleanupClaudeConfigDir(worker.id, claudeConfigDir);
        }

        // Restore/remove the Codex AGENTS.md we wrote (Phase 2A) so we never
        // leave the repo dirty: delete it if we created it, restore the original
        // verbatim if we appended to a pre-existing one. Best-effort.
        if (codexAgentsMd) {
          await restoreCodexAgentsMd(session.cwd, codexAgentsMd);
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
        const pauseReason = classifyClaimError(err);

        if (isAuthError(err)) {
          // Auth failure burn-loop guard: a runner with neither local nor valid
          // server creds must not claim-then-fail forever. Invalidate the cached
          // (bad) credential for this team so a rotated/fixed one is picked up on
          // the next claim, and pause with EXPONENTIAL backoff (escalating with
          // consecutive auth failures) — both per-context and globally, since a
          // process-wide bad credential fails every context identically. This
          // takes precedence over the flat-pause auth branch in classifyClaimError.
          this.consecutiveQuickFailures = 0;
          this.handleAuthFailure(worker.id);
        } else if (pauseReason) {
          const pauseMs = pauseReason.pauseMs;
          const untilMs = Date.now() + pauseMs;
          if (pauseReason.scope === 'context') {
            const ctx = this.workerAuthContexts.get(worker.id) ?? 'account';
            this.contextBreaker.pause(ctx, untilMs);
            console.warn(`[WorkerManager] ${pauseReason.label} [${ctx}] — pausing ${ctx} claims ~${Math.round(pauseMs / 60_000)} min`);
            sessionLog(worker.id, 'warn', 'circuit_breaker', `${pauseReason.label} [${ctx}]: pausing ~${Math.round(pauseMs / 60_000)} min`, worker.taskId);
            this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: untilMs, reason: `${pauseReason.label} (${ctx})` });
          } else {
            this.claimsPaused = true;
            this.claimsPausedUntil = untilMs;
            this.consecutiveQuickFailures = 0;
            console.warn(`[WorkerManager] ${pauseReason.label} — pausing all claims ~${Math.round(pauseMs / 60_000)} min`);
            sessionLog(worker.id, 'warn', 'circuit_breaker', `${pauseReason.label}: pausing ~${Math.round(pauseMs / 60_000)} min`, worker.taskId);
            this.emit({ type: 'circuit_breaker', paused: true, pausedUntil: untilMs, reason: pauseReason.label });
          }
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
        // A slot freed up — check for pending tasks. Skip in serverless (no
        // claim endpoint/mock can return an unbounded stream of tasks).
        if (!this.config.serverless) {
          this.claimPendingTasks().catch(() => {});
        }
      }
    }
  }

  private async handleMessage(worker: LocalWorker, msg: SDKMessage) {
    worker.lastActivity = Date.now();
    worker.hasNewActivity = true;

    // Recover from stale status when activity resumes
    if (worker.status === 'stale') {
      worker.status = 'working';
    }
    // Clear probe tracking when activity resumes (probe succeeded or agent was active)
    this.probedWorkers.delete(worker.id);

    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      // Codex (R5): the adapter surfaces the Codex thread id as session_id on the
      // synthetic init. Keep it in codexThreadId — NOT sessionId — so the resume
      // branch (recovery.ts) stays unambiguous between Claude and Codex.
      if (worker.taskBackend === 'codex') {
        worker.codexThreadId = msg.session_id;
      } else {
        worker.sessionId = msg.session_id;
      }
      this.addCheckpoint(worker, CheckpointEvent.SESSION_STARTED);
      // Immediately persist the captured id (critical for resume)
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
      // SDK v0.3.202+: agent identity for depth-2+ trees. Fields read defensively
      // (not in the installed SDK's typed surface yet); absent on older CLIs.
      const agentId = event.agent_id ?? event.agentID ?? undefined;
      const parentAgentId = event.parent_agent_id ?? event.parentAgentId ?? undefined;
      const subagentTask: SubagentTask = {
        taskId: event.task_id,
        toolUseId: event.tool_use_id,
        description: event.description || '',
        taskType: event.task_type || 'unknown',
        startedAt: Date.now(),
        status: 'running',
        ...(isBackground ? { isBackground: true } : {}),
        ...(agentId ? { agentId } : {}),
        ...(parentAgentId ? { parentAgentId } : {}),
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
        // Backfill agent identity if task_started didn't carry it (SDK v0.3.202+).
        const agentId = event.agent_id ?? event.agentID;
        const parentAgentId = event.parent_agent_id ?? event.parentAgentId;
        if (agentId && !tracked.agentId) tracked.agentId = agentId;
        if (parentAgentId && !tracked.parentAgentId) tracked.parentAgentId = parentAgentId;
      }
      this.emit({ type: 'worker_update', worker });
    }

    // SDK v0.3.206+: command_lifecycle — terminal state of each queued message
    // (queued/started/completed/cancelled/discarded). Surfaces cancelled/discarded
    // steers (which otherwise vanish silently) as milestones without the agent
    // having to report progress manually. No-op on CLIs that never emit it.
    // Accept both plausible envelopes: a system-message subtype or a top-level
    // frame, since the exact shape isn't in the installed SDK's typed surface.
    if (
      (msg.type === 'system' && (msg as any).subtype === 'command_lifecycle') ||
      (msg as any).type === 'command_lifecycle'
    ) {
      const event = msg as any;
      if (!worker.commandLifecycle) worker.commandLifecycle = emptyCommandLifecycle();
      const result = applyCommandLifecycle(worker.commandLifecycle, {
        uuid: event.uuid ?? event.message_uuid,
        state: event.state,
        status: event.status,
      });
      if (result.changed && result.milestoneLabel) {
        worker.currentAction = result.currentAction ?? worker.currentAction;
        this.addMilestone(worker, { type: 'status', label: result.milestoneLabel, ts: Date.now() });
        sessionLog(worker.id, 'info', 'command_lifecycle', `${result.state}`, worker.taskId);
      }
      if (result.changed) this.emit({ type: 'worker_update', worker });
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
            // R1: track the latest assistant text as worker.lastAssistantMessage.
            // For Claude this is also set authoritatively by the Stop hook
            // (hook-factory.ts), but Codex has no Stop hook — its agent_message
            // text arrives only through this channel-2 adapter path. Without
            // this, the review-loop DONE gate (workers.ts ~1567) and the
            // completion summary (~1758) stay empty for Codex, so every task
            // burns all review iterations and exits with no summary. Setting it
            // per text block (last write wins) is harmless for Claude.
            worker.lastAssistantMessage = text;

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

          // Track tool calls (keep last 200). Persist the tool_use block id
          // (R2) so a later tool_result can be correlated back to its source
          // tool for error-trace scanning (see the `user`/tool_result branch).
          const toolUseId = (block.id as string | undefined) || undefined;
          worker.toolCalls.push({
            name: toolName,
            timestamp: Date.now(),
            input: input,
            ...(toolUseId ? { toolUseId } : {}),
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
          if (repetitionCheck.action === 'nudge') {
            if (!worker.loopNudgeSent) {
              worker.loopNudgeSent = true;
              const sessionRef = this.sessions.get(worker.id);
              if (sessionRef) {
                sessionRef.inputStream.enqueue(
                  buildUserMessage(repetitionCheck.nudgeMessage!, { sessionId: worker.id })
                );
              }
              console.log(`[Worker ${worker.id}] ⚠️ Loop nudge: ${repetitionCheck.nudgeMessage}`);
              this.addMilestone(worker, { type: 'status', label: `⚠️ ${repetitionCheck.nudgeMessage}`, ts: Date.now() });
            }
            // do not abort on nudge
          } else if (repetitionCheck.action === 'abort') {
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
              // Persist waitingFor on the worker so the post-loop cleanup
              // re-sends it with the failed update (defense in depth — if the
              // waiting_input update below races and loses, the cleanup still
              // carries the structured question to the server).
              worker.waitingFor = {
                type: 'question',
                prompt: questionText,
                options: firstQuestion?.options as any,
              };
              // Await the waiting_input sync — fire-and-forget races against
              // the cleanup's status=failed update and the server then 409s
              // this one as "worker already terminated", dropping waitingFor.
              try {
                await this.buildd.updateWorker(worker.id, {
                  status: 'waiting_input',
                  currentAction: worker.currentAction,
                  waitingFor: {
                    type: 'question',
                    prompt: questionText,
                    options: firstQuestion?.options as any,
                  },
                });
              } catch (err) {
                console.warn(`[Worker ${worker.id}] waiting_input sync failed:`, err);
              }
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

    // Tool-result inspection: agent SDK sends tool outputs back to the model
    // as synthetic user messages containing tool_result blocks. Scan each
    // result against the error-pattern list and buffer matches for sync.
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          // Tool result content can be a string or an array of text blocks.
          let text = '';
          if (typeof block.content === 'string') {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            text = block.content
              .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text)
              .join('\n');
          }
          if (!text) continue;

          // Source tool: look up the originating tool_use_id in recent tool calls.
          // Best-effort — if we can't find it, the trace still records useful info.
          const toolUseId = block.tool_use_id as string | undefined;
          let source: string | undefined;
          if (toolUseId) {
            for (let i = worker.toolCalls.length - 1; i >= 0; i--) {
              const tc: any = worker.toolCalls[i];
              if (tc.toolUseId === toolUseId || tc.id === toolUseId) {
                source = tc.name;
                break;
              }
            }
          }

          const traces = scanToolResult(worker.id, text, source);
          if (traces.length > 0) {
            if (!worker.pendingErrorTraces) worker.pendingErrorTraces = [];
            worker.pendingErrorTraces.push(...traces);
            for (const t of traces) {
              console.log(`[Worker ${worker.id}] error-trace match: pattern=${t.pattern} excerpt="${t.excerpt.slice(0, 80)}"`);
            }
          }

          // 401 circuit breaker: detect auth failures from MCP connector tool results.
          // For assertion-mode connectors, re-exchange runs silently via the PostToolUseFailure
          // hook (§F.2 in assertion-grant spec); the breaker fires only when re-exchange has
          // already been exhausted (assertionReAuthFailed flag set by hook-factory).
          // For oauth/static connectors the breaker fires immediately.
          if (
            block.is_error === true &&
            worker.mcpConnectors && worker.mcpConnectors.length > 0 &&
            source?.startsWith('mcp__')
          ) {
            const is401 = /\b(401|unauthorized|authentication.*failed|invalid.*token|token.*expired|access.*denied)\b/i.test(text);
            if (is401) {
              const serverKey = source.split('__')[1];
              const connector = worker.mcpConnectors.find((c: any) =>
                c.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') === serverKey
              );
              if (connector) {
                const isAssertion = worker.assertionConnectors?.some((a: any) => a.name === connector.name);
                const reAuthFailed = worker.assertionReAuthFailed?.has(connector.name);
                // Skip circuit breaker for assertion connectors unless re-exchange has failed.
                if (!isAssertion || reAuthFailed) {
                  console.log(`[Worker ${worker.id}] 401 from connector "${connector.name}" (${connector.id}) — signaling API and aborting`);
                  worker.error = `connector_auth_expired:${connector.id}`;
                  this.buildd.updateWorker(worker.id, {
                    event: 'connector_auth_expired',
                    connectorId: connector.id,
                    connectorUrl: connector.url,
                    status: 'waiting_input',
                  }).catch((err: unknown) => {
                    console.warn(`[Worker ${worker.id}] connector_auth_expired sync failed:`, err);
                  });
                  const session = this.sessions.get(worker.id);
                  if (session) session.abortController.abort();
                }
              }
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

  // Detect if agent is stuck in an infinite loop of repeated tool calls.
  // Returns:
  //   action: 'none'  — no problem detected
  //   action: 'nudge' — threshold hit, send a steering message (do NOT abort)
  //   action: 'abort' — 2× threshold hit, terminate the worker
  private detectRepetitiveToolCalls(worker: LocalWorker): {
    action: 'none' | 'nudge' | 'abort';
    reason?: string;
    nudgeMessage?: string;
  } {
    // Exclude benign Bash commands from all repetition counting.
    // This prevents exploration commands like "cd /repo && git diff ...", "ls", etc.
    // from tripping the guard. Non-Bash tools (Read, Edit, Write, Grep…) are kept.
    const calls = worker.toolCalls.filter(tc => {
      if (tc.name === 'Bash') return !isBenignBashCommand((tc.input?.command as string) || '');
      return true;
    });

    if (calls.length < MAX_IDENTICAL_TOOL_CALLS) {
      return { action: 'none' };
    }

    // ── Identical call check (all non-benign tools) ──────────────────────────
    const normalizeCallKey = (tc: { name: string; input?: Record<string, unknown> }) => {
      if (tc.name === 'Read') {
        // Different offset/limit = distinct reads, so include them in the key
        return JSON.stringify({
          name: tc.name,
          file_path: tc.input?.file_path,
          offset: tc.input?.offset,
          limit: tc.input?.limit,
        });
      }
      return JSON.stringify({ name: tc.name, input: tc.input });
    };

    // Abort at 2× (agent ignored the nudge and kept going)
    if (calls.length >= 2 * MAX_IDENTICAL_TOOL_CALLS) {
      const last2x = calls.slice(-2 * MAX_IDENTICAL_TOOL_CALLS);
      const key = normalizeCallKey(last2x[0]);
      if (last2x.every(tc => normalizeCallKey(tc) === key)) {
        return {
          action: 'abort',
          reason: `Agent stuck: made ${2 * MAX_IDENTICAL_TOOL_CALLS} identical ${last2x[0].name} calls`,
        };
      }
    }

    // Nudge at 1× threshold
    {
      const last1x = calls.slice(-MAX_IDENTICAL_TOOL_CALLS);
      const key = normalizeCallKey(last1x[0]);
      if (last1x.every(tc => normalizeCallKey(tc) === key)) {
        return {
          action: 'nudge',
          nudgeMessage: `You've repeated the same ${last1x[0].name} call ${MAX_IDENTICAL_TOOL_CALLS} times — vary your approach or signal completion.`,
        };
      }
    }

    // ── Similar Bash check (non-benign Bash only, full command comparison) ───
    // Quote-normalise the full command — no 50-char truncation, so commands that
    // share a long cd-prefix but differ in their actual argument are distinct.
    const nonBenignBash = calls.filter(tc => tc.name === 'Bash');

    if (nonBenignBash.length >= MAX_SIMILAR_TOOL_CALLS) {
      const normalizeCmd = (cmd: string) =>
        cmd.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");

      // Abort at 2×
      if (nonBenignBash.length >= 2 * MAX_SIMILAR_TOOL_CALLS) {
        const last2x = nonBenignBash.slice(-2 * MAX_SIMILAR_TOOL_CALLS);
        const firstPattern = normalizeCmd((last2x[0].input?.command as string) || '');
        if (last2x.every(tc => normalizeCmd((tc.input?.command as string) || '') === firstPattern)) {
          return {
            action: 'abort',
            reason: `Agent stuck: made ${2 * MAX_SIMILAR_TOOL_CALLS} similar Bash commands starting with "${firstPattern.slice(0, 30)}..."`,
          };
        }
      }

      // Nudge at 1×
      const last1x = nonBenignBash.slice(-MAX_SIMILAR_TOOL_CALLS);
      const firstPattern = normalizeCmd((last1x[0].input?.command as string) || '');
      if (last1x.every(tc => normalizeCmd((tc.input?.command as string) || '') === firstPattern)) {
        return {
          action: 'nudge',
          nudgeMessage: `You've repeated a near-identical Bash command ${MAX_SIMILAR_TOOL_CALLS} times — vary your approach or signal completion.`,
        };
      }
    }

    return { action: 'none' };
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
    if (this.budgetResumeTimer) {
      clearTimeout(this.budgetResumeTimer);
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
