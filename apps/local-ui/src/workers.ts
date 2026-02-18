import { query, type SDKMessage, type SDKUserMessage, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, LocalUIConfig, BuilddTask, WorkerCommand, ChatMessage, TeamState, Checkpoint, SubagentTask, CheckpointEventType } from './types';
import { CheckpointEvent, CHECKPOINT_LABELS } from './types';
import { BuilddClient } from './buildd';
import { createWorkspaceResolver, type WorkspaceResolver } from './workspace';
import { DANGEROUS_PATTERNS, SENSITIVE_PATHS, type SkillBundle, type SkillInstallPayload, type SkillInstallResult, validateInstallerCommand } from '@buildd/shared';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { syncSkillToLocal } from './skills.js';
import Pusher from 'pusher-js';
import { saveWorker as storeSaveWorker, loadAllWorkers, deleteWorker as storeDeleteWorker } from './worker-store';
import { scanEnvironment } from './env-scan';
import { sessionLog, cleanupOldLogs, readSessionLogs } from './session-logger';
import type { WorkerEnvironment } from '@buildd/shared';

type EventHandler = (event: any) => void;
type CommandHandler = (workerId: string, command: WorkerCommand) => void;

// Extract a short label from reasoning text: first sentence, up to period/newline/120 chars
function extractPhaseLabel(text: string): string {
  // Take first line or sentence
  const firstLine = text.split('\n')[0].trim();
  // Find first sentence boundary
  const periodIdx = firstLine.indexOf('. ');
  const label = periodIdx > 0 && periodIdx < 120
    ? firstLine.slice(0, periodIdx)
    : firstLine.slice(0, 120);
  return label + (firstLine.length > 120 && periodIdx < 0 ? '...' : '');
}

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
  private pusher?: Pusher;
  private pusherChannels = new Map<string, any>();
  private hasCredentials: boolean = false;
  private acceptRemoteTasks: boolean = true;
  private workspaceChannels = new Map<string, any>();
  private workspaceAllowlistCache = new Map<string, string[] | undefined>();
  private cleanupInterval?: Timer;
  private heartbeatInterval?: Timer;
  private evictionInterval?: Timer;
  private diskPersistInterval?: Timer;
  private viewerToken?: string;
  private dirtyWorkers = new Set<string>();
  private dirtyForDisk = new Set<string>();
  private environment?: WorkerEnvironment;
  private envScanInterval?: Timer;

  constructor(config: LocalUIConfig, resolver?: WorkspaceResolver) {
    this.config = config;
    this.buildd = new BuilddClient(config);
    this.resolver = resolver || createWorkspaceResolver(config.projectsRoot);
    this.acceptRemoteTasks = config.acceptRemoteTasks !== false;

    // Check for stale workers every 30s
    this.staleCheckInterval = setInterval(() => this.checkStale(), 30_000);

    // Sync dirty worker state to server every 10s (immediate sync for critical changes via markDirty)
    this.syncInterval = setInterval(() => this.syncToServer(), 10_000);

    // Run cleanup every 30 minutes (includes session logs)
    this.cleanupInterval = setInterval(() => { this.runCleanup(); cleanupOldLogs(); }, 30 * 60 * 1000);

    // Evict completed workers from memory every 5 minutes to prevent unbounded growth
    this.evictionInterval = setInterval(() => this.evictCompletedWorkers(), 5 * 60 * 1000);

    // Persist dirty worker state to disk every 5s
    this.diskPersistInterval = setInterval(() => this.persistDirtyWorkers(), 5_000);

    // Restore workers from disk on startup
    this.restoreWorkersFromDisk();

    // Scan environment on startup (sync — runs once, fast enough for init)
    try {
      this.environment = scanEnvironment();
      console.log(`Environment scan: ${this.environment.tools.length} tools, ${this.environment.envKeys.length} env keys, ${this.environment.mcp.length} MCP servers`);
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
    }

    // Initialize Pusher if configured
    if (config.pusherKey && config.pusherCluster) {
      this.pusher = new Pusher(config.pusherKey, {
        cluster: config.pusherCluster,
      });
      console.log('Pusher connected for command relay');

      // On reconnect, send immediate heartbeat to catch any tasks missed during disconnect
      this.pusher.connection.bind('state_change', (states: { previous: string; current: string }) => {
        if (states.current === 'connected' && states.previous !== 'initialized') {
          console.log(`Pusher reconnected (was ${states.previous}), sending immediate heartbeat`);
          this.sendHeartbeat();
        }
      });

      // Subscribe to workspace channels for task assignments if enabled
      if (this.acceptRemoteTasks) {
        this.subscribeToWorkspaceChannels();
      }
    }

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
    if (enabled && this.pusher) {
      this.subscribeToWorkspaceChannels();
    } else if (!enabled) {
      this.unsubscribeFromWorkspaceChannels();
    }
    console.log(`Accept remote tasks: ${enabled}`);
  }

  // Restore workers from disk on startup
  private restoreWorkersFromDisk() {
    try {
      const restored = loadAllWorkers();
      for (const worker of restored) {
        // Workers with active status can't be resumed (no SDK session/inputStream)
        if (worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting') {
          worker.status = 'error';
          worker.error = 'Process restarted';
          worker.completedAt = worker.completedAt || Date.now();
          worker.currentAction = 'Process restarted';
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
        this.workers.set(worker.id, worker);
      }
      if (restored.length > 0) {
        console.log(`[WorkerStore] Restored ${restored.length} worker(s) from disk`);
      }
    } catch (err) {
      console.error('[WorkerStore] Failed to restore workers from disk:', err);
    }
  }

  // Persist workers that have been marked dirty since last interval
  private persistDirtyWorkers() {
    if (this.dirtyForDisk.size === 0) return;
    const toSave = new Set(this.dirtyForDisk);
    this.dirtyForDisk.clear();
    for (const workerId of toSave) {
      const worker = this.workers.get(workerId);
      if (worker) {
        try {
          storeSaveWorker(worker);
        } catch (err) {
          console.error(`[WorkerStore] Failed to persist worker ${workerId}:`, err);
        }
      }
    }
  }

  // Subscribe to workspace channels for task assignments
  private async subscribeToWorkspaceChannels() {
    if (!this.pusher) return;

    try {
      // Get workspaces to determine channel names
      const workspaces = await this.buildd.listWorkspaces();
      if (workspaces.length === 0) {
        console.log('No workspaces found, skipping workspace channel subscription');
        return;
      }

      // Subscribe to each workspace for task:assigned events
      for (const ws of workspaces) {
        const channelName = `workspace-${ws.id}`;
        if (!this.workspaceChannels.has(channelName)) {
          const channel = this.pusher.subscribe(channelName);
          channel.bind('task:assigned', (data: { task: BuilddTask; targetLocalUiUrl?: string | null }) => {
            this.handleTaskAssignment(data);
          });
          channel.bind('skill:install', (data: SkillInstallPayload) => {
            if (data.targetLocalUiUrl && this.config.localUiUrl && data.targetLocalUiUrl !== this.config.localUiUrl) {
              return; // Not for us
            }
            this.handleSkillInstall(data, ws.id);
          });
          this.workspaceChannels.set(channelName, channel);
          // Cache workspace allowlist
          try {
            const wsConfig = await this.buildd.getWorkspaceConfig(ws.id);
            this.workspaceAllowlistCache.set(ws.id, (wsConfig.gitConfig as any)?.skillInstallerAllowlist);
          } catch {
            // Non-fatal — will use default allowlist
          }
          console.log(`Subscribed to ${channelName} for task assignments`);
        }
      }
    } catch (err) {
      console.error('Failed to subscribe to workspace channels:', err);
    }
  }

  private unsubscribeFromWorkspaceChannels() {
    // Unsubscribe from workspace channels
    for (const [channelName, channel] of this.workspaceChannels) {
      channel.unbind('task:assigned');
      channel.unbind('skill:install');
      this.pusher?.unsubscribe(channelName);
    }
    this.workspaceChannels.clear();
    this.workspaceAllowlistCache.clear();
  }

  // Handle incoming task assignment
  private async handleTaskAssignment(data: { task: BuilddTask; targetLocalUiUrl?: string | null }) {
    if (!this.acceptRemoteTasks) {
      console.log('Remote task assignment ignored (acceptRemoteTasks is disabled)');
      return;
    }

    const { task, targetLocalUiUrl } = data;

    // Check if this assignment is targeted at this local-ui instance
    // If targetLocalUiUrl is set, only accept if it matches our URL
    // If targetLocalUiUrl is null/undefined, any local-ui can accept (broadcast)
    if (targetLocalUiUrl && this.config.localUiUrl && targetLocalUiUrl !== this.config.localUiUrl) {
      console.log(`Task ${task.id} assigned to different local-ui: ${targetLocalUiUrl}`);
      return;
    }

    // Check if we have capacity
    const activeWorkers = Array.from(this.workers.values()).filter(
      w => w.status === 'working' || w.status === 'stale'
    );
    if (activeWorkers.length >= this.config.maxConcurrent) {
      console.log(`Cannot accept task ${task.id}: at max capacity (${activeWorkers.length}/${this.config.maxConcurrent})`);
      return;
    }

    console.log(`Received task assignment: ${task.title} (${task.id})`);
    this.emit({ type: 'task_assigned', task });

    // Auto-claim and start the task
    try {
      const worker = await this.claimAndStart(task);
      if (worker) {
        console.log(`Successfully started assigned task: ${task.title}`);
      }
    } catch (err) {
      console.error(`Failed to start assigned task ${task.id}:`, err);
    }
  }

  // Handle remote skill installation
  private async handleSkillInstall(payload: SkillInstallPayload, workspaceId: string) {
    const { requestId, skillSlug } = payload;
    console.log(`[SkillInstall] Received install request: ${skillSlug} (${requestId})`);

    // Content push path
    if (payload.bundle) {
      try {
        await syncSkillToLocal(payload.bundle);
        console.log(`[SkillInstall] Content push succeeded: ${skillSlug}`);
        await this.reportInstallResult(workspaceId, requestId, skillSlug, true, 'content_push');
      } catch (err) {
        console.error(`[SkillInstall] Content push failed: ${skillSlug}`, err);
        await this.reportInstallResult(workspaceId, requestId, skillSlug, false, 'content_push', undefined, String(err));
      }
      return;
    }

    // Command execution path
    if (payload.installerCommand) {
      const validation = validateInstallerCommand(payload.installerCommand, {
        workspaceAllowlist: this.workspaceAllowlistCache.get(workspaceId),
        localAllowlist: this.config.skillInstallerAllowlist,
        rejectAll: this.config.rejectRemoteInstallers,
      });
      if (!validation.allowed) {
        console.log(`[SkillInstall] Command rejected: ${validation.reason}`);
        await this.reportInstallResult(workspaceId, requestId, skillSlug, false, 'installer_command', undefined, validation.reason);
        return;
      }

      const { execSync } = await import('child_process');
      try {
        const output = execSync(payload.installerCommand, {
          cwd: homedir(),
          timeout: 120_000,
          encoding: 'utf-8',
        });
        console.log(`[SkillInstall] Command succeeded: ${skillSlug}`);
        await this.reportInstallResult(workspaceId, requestId, skillSlug, true, 'installer_command', output?.slice(0, 2000));
      } catch (err: any) {
        console.error(`[SkillInstall] Command failed: ${skillSlug}`, err.message);
        await this.reportInstallResult(workspaceId, requestId, skillSlug, false, 'installer_command', err.stdout?.slice(0, 1000), err.message?.slice(0, 1000));
      }
    }
  }

  private async reportInstallResult(
    workspaceId: string,
    requestId: string,
    skillSlug: string,
    success: boolean,
    method: 'content_push' | 'installer_command',
    output?: string,
    error?: string,
  ) {
    const result: SkillInstallResult = {
      requestId,
      skillSlug,
      localUiUrl: this.config.localUiUrl,
      success,
      method,
      output,
      error,
      timestamp: Date.now(),
    };
    try {
      await this.buildd.reportSkillInstallResult(workspaceId, result);
    } catch (err) {
      console.error(`[SkillInstall] Failed to report result:`, err);
    }
  }

  // Check if credentials exist
  getAuthStatus(): { hasCredentials: boolean } {
    return { hasCredentials: this.hasCredentials };
  }

  getViewerToken(): string | undefined {
    return this.viewerToken;
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

  // Subscribe to Pusher channel for worker commands
  private subscribeToWorker(workerId: string) {
    if (!this.pusher || this.pusherChannels.has(workerId)) return;

    const channel = this.pusher.subscribe(`worker-${workerId}`);
    channel.bind('worker:command', (data: WorkerCommand) => {
      console.log(`Command received for worker ${workerId}:`, data);
      this.handleCommand(workerId, data);
    });
    this.pusherChannels.set(workerId, channel);
  }

  private unsubscribeFromWorker(workerId: string) {
    const channel = this.pusherChannels.get(workerId);
    if (channel) {
      this.pusher?.unsubscribe(`worker-${workerId}`);
      this.pusherChannels.delete(workerId);
    }
  }

  private async handleCommand(workerId: string, command: WorkerCommand) {
    this.emitCommand(workerId, command);

    switch (command.action) {
      case 'pause':
        // TODO: Implement pause (would need SDK support)
        console.log(`Pause requested for worker ${workerId}`);
        break;
      case 'resume':
        console.log(`Resume requested for worker ${workerId}`);
        break;
      case 'abort':
        await this.abort(workerId);
        break;
      case 'message':
        if (command.text) {
          await this.sendMessage(workerId, command.text);
        }
        break;
      case 'rollback':
        if (command.checkpointUuid) {
          await this.rollback(workerId, command.checkpointUuid);
        }
        break;
    }
  }

  // Sync a single worker's state to server
  private async syncWorkerToServer(worker: LocalWorker) {
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

      const update: Parameters<BuilddClient['updateWorker']>[1] = {
        status: worker.status === 'waiting' ? 'waiting_input' : 'running',
        currentAction: worker.currentAction,
        milestones,
        localUiUrl: this.config.localUiUrl,
      };
      if (worker.status === 'waiting' && worker.waitingFor) {
        update.waitingFor = {
          type: worker.waitingFor.type,
          prompt: worker.waitingFor.prompt,
          options: worker.waitingFor.options?.map((o: any) => typeof o === 'string' ? o : o.label),
        };
      }
      const response = await this.buildd.updateWorker(worker.id, update);

      // Process any pending instructions from sync response
      if (response?.instructions) {
        let parsed: { type?: string; message?: string } | null = null;
        try {
          parsed = JSON.parse(response.instructions);
        } catch {
          // Not JSON - plain instruction
        }

        if (parsed?.type === 'request_plan') {
          // Inject planning prompt — agent will use native EnterPlanMode/ExitPlanMode flow
          const planMessage = `**PLAN REQUESTED:** Please pause implementation and propose a plan for review. Use EnterPlanMode to investigate the codebase and plan your approach, then use ExitPlanMode to submit the plan for approval. ${parsed.message || ''}`;
          await this.sendMessage(worker.id, planMessage);
        } else if (response.instructions) {
          // Regular instruction - inject as message
          await this.sendMessage(worker.id, response.instructions);
        }
      }
    } catch (err) {
      // Silently ignore sync errors
    }
  }

  // Mark a worker as needing sync on next interval
  private markDirty(workerId: string) {
    this.dirtyWorkers.add(workerId);
  }

  // Sync only dirty worker states to server
  private async syncToServer() {
    if (this.dirtyWorkers.size === 0) return;
    const toSync = new Set(this.dirtyWorkers);
    this.dirtyWorkers.clear();
    try {
      for (const workerId of toSync) {
        const worker = this.workers.get(workerId);
        if (worker && (worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting')) {
          await this.syncWorkerToServer(worker);
        }
      }
    } catch {
      // Silently ignore sync errors - server may be temporarily unreachable
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

  // Send heartbeat to server announcing this local-ui instance is alive and ready
  private async sendHeartbeat() {
    if (!this.config.localUiUrl) return;
    try {
      const activeCount = Array.from(this.workers.values()).filter(
        w => w.status === 'working' || w.status === 'waiting'
      ).length;
      const { viewerToken, pendingTaskCount } = await this.buildd.sendHeartbeat(this.config.localUiUrl, activeCount, this.environment);
      if (viewerToken) {
        this.viewerToken = viewerToken;
      }
      // If server reports pending tasks and we have capacity, try to claim them
      if (pendingTaskCount && pendingTaskCount > 0 && this.acceptRemoteTasks) {
        const activeWorkers = Array.from(this.workers.values()).filter(
          w => w.status === 'working' || w.status === 'stale'
        );
        if (activeWorkers.length < this.config.maxConcurrent) {
          console.log(`Heartbeat: ${pendingTaskCount} pending task(s) available, attempting claim...`);
          this.claimPendingTasks().catch(err => {
            console.error('Failed to claim tasks from heartbeat:', err);
          });
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
    } catch {
      // Non-fatal - cleanup is best-effort
    }
  }

  // Evict completed/failed workers from in-memory Map after 10 minutes
  // to prevent unbounded memory growth during long-running sessions
  private evictCompletedWorkers() {
    const RETENTION_MS = 10 * 60 * 1000;
    const now = Date.now();
    for (const [id, worker] of this.workers.entries()) {
      if (
        (worker.status === 'done' || worker.status === 'error') &&
        now - worker.lastActivity > RETENTION_MS
      ) {
        this.workers.delete(id);
        this.sessions.delete(id);
        storeDeleteWorker(id);
      }
    }
  }

  private checkStale() {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (worker.status === 'working' && now - worker.lastActivity > 300_000) {
        worker.status = 'stale';
        this.emit({ type: 'worker_update', worker });
      }
    }
  }

  getWorkers(): LocalWorker[] {
    return Array.from(this.workers.values());
  }

  getWorker(id: string): LocalWorker | undefined {
    return this.workers.get(id);
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

    const activeWorkers = Array.from(this.workers.values()).filter(
      w => w.status === 'working' || w.status === 'stale'
    );
    const slots = this.config.maxConcurrent - activeWorkers.length;
    if (slots <= 0) return [];

    try {
      const claimed = await this.buildd.claimTask(slots, undefined, this.config.localUiUrl);
      if (claimed.length === 0) return [];

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
          continue;
        }

        const worker = await this.startFromClaim(claimedWorker, task, workspacePath);
        if (worker) started.push(worker);
      }
      return started;
    } catch (err) {
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
      console.error(`Cannot resolve workspace for task: ${task.title}`);
      return null;
    }

    // Claim from buildd (pass taskId for targeted claiming)
    const claimed = await this.buildd.claimTask(1, task.workspaceId, this.config.localUiUrl, task.id);
    if (claimed.length === 0) {
      console.log('No tasks claimed');
      return null;
    }

    const claimedWorker = claimed[0];

    // Prefer claim response task data (full) over Pusher event task data (minimal payload)
    const fullTask = claimedWorker.task || task;

    return this.startFromClaim(claimedWorker, fullTask, workspacePath);
  }

  private async startFromClaim(
    claimedWorker: { id: string; branch?: string; task?: BuilddTask },
    fullTask: BuilddTask,
    workspacePath: string,
  ): Promise<LocalWorker | null> {

    // Create local worker
    const worker: LocalWorker = {
      id: claimedWorker.id,
      taskId: fullTask.id,
      taskTitle: fullTask.title,
      taskDescription: fullTask.description,
      workspaceId: fullTask.workspaceId,
      workspaceName: fullTask.workspace?.name || 'unknown',
      branch: claimedWorker.branch,
      status: 'working',
      hasNewActivity: false,
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
      phaseText: null,
      phaseStart: null,
      phaseToolCount: 0,
      phaseTools: [],
    };

    this.workers.set(worker.id, worker);
    this.emit({ type: 'worker_update', worker });

    // Immediately persist new worker to disk
    storeSaveWorker(worker);

    // Subscribe to Pusher for commands
    this.subscribeToWorker(worker.id);

    // Register localUiUrl with server
    if (this.config.localUiUrl) {
      this.buildd.updateWorker(worker.id, {
        localUiUrl: this.config.localUiUrl,
        status: 'running',
      }).catch(err => console.error('Failed to register localUiUrl:', err));
    }

    // Set up git worktree for isolation (if branching strategy is not 'none')
    const gitConfig = fullTask.workspace?.gitConfig;
    const branchingStrategy = gitConfig?.branchingStrategy || 'feature';
    const defaultBranch = gitConfig?.defaultBranch || 'main';

    let sessionCwd = workspacePath;
    if (branchingStrategy !== 'none' && claimedWorker.branch) {
      worker.currentAction = 'Setting up worktree...';
      this.emit({ type: 'worker_update', worker });

      const worktreePath = await this.setupWorktree(
        workspacePath,
        claimedWorker.branch,
        defaultBranch,
        worker.id,
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
        this.cleanupWorktree(workspacePath, worker.worktreePath, worker.id).catch(() => {});
      }
    });

    return worker;
  }

  // Create a PreToolUse hook that blocks dangerous commands but explicitly allows safe ones.
  // Under `acceptEdits` mode, Bash commands stall waiting for approval (no approval UI exists).
  // This hook returns `allow` for non-dangerous Bash commands so agents don't silently stall.
  private createPermissionHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};

      const toolName = (input as any).tool_name;
      const toolInput = (input as any).tool_input as Record<string, unknown>;

      // Block dangerous bash commands
      if (toolName === 'Bash') {
        const command = (toolInput.command as string) || '';
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(command)) {
            console.log(`[Worker ${worker.id}] Blocked dangerous command: ${command.slice(0, 80)}`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Dangerous command blocked by safety policy',
              },
            };
          }
        }

        // Explicitly allow safe bash commands (prevents acceptEdits stall)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            permissionDecisionReason: 'Allowed by buildd permission hook',
          },
        };
      }

      // Block writes to sensitive paths
      if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
        const filePath = (toolInput.file_path as string) || (toolInput.filePath as string) || '';
        for (const pattern of SENSITIVE_PATHS) {
          if (pattern.test(filePath)) {
            console.log(`[Worker ${worker.id}] Blocked sensitive path write: ${filePath}`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: `Cannot write to sensitive path: ${filePath}`,
              },
            };
          }
        }
      }

      // Allow all other tools by default (prevents acceptEdits stall —
      // no terminal exists for interactive approval)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          permissionDecisionReason: 'Allowed by buildd permission hook',
        },
      };
    };
  }

  // Create a PostToolUse hook that captures team events (TeamCreate, SendMessage, Task).
  // Purely observational — returns {} and never blocks or modifies tool execution.
  private createTeamTrackingHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PostToolUse') return {};

      const toolName = (input as any).tool_name;
      const toolInput = (input as any).tool_input as Record<string, unknown>;

      if (toolName === 'TeamCreate') {
        const teamName = (toolInput.team_name as string) || 'unnamed';
        worker.teamState = {
          teamName,
          members: [],
          messages: [],
          createdAt: Date.now(),
        };
        this.addMilestone(worker, { type: 'status', label: `Team created: ${teamName}`, ts: Date.now() });
        console.log(`[Worker ${worker.id}] Team created: ${teamName}`);
      }

      if (toolName === 'SendMessage' && worker.teamState) {
        const msg = {
          from: (toolInput.sender as string) || 'leader',
          to: (toolInput.recipient as string) || (toolInput.type === 'broadcast' ? 'broadcast' : 'unknown'),
          content: (toolInput.content as string) || '',
          summary: (toolInput.summary as string) || undefined,
          timestamp: Date.now(),
        };
        worker.teamState.messages.push(msg);
        // Cap at 200 messages
        if (worker.teamState.messages.length > 200) {
          worker.teamState.messages.shift();
        }
        // Only emit milestone for broadcasts (avoid noise from DMs)
        if (toolInput.type === 'broadcast') {
          this.addMilestone(worker, { type: 'status', label: `Broadcast: ${msg.summary || msg.content.slice(0, 40)}`, ts: Date.now() });
        }
      }

      if (toolName === 'Task' && worker.teamState) {
        const agentName = (toolInput.name as string) || (toolInput.description as string) || 'subagent';
        const agentType = (toolInput.subagent_type as string) || undefined;
        worker.teamState.members.push({
          name: agentName,
          role: agentType,
          status: 'active',
          spawnedAt: Date.now(),
        });
        this.addMilestone(worker, { type: 'status', label: `Subagent: ${agentName}`, ts: Date.now() });
        console.log(`[Worker ${worker.id}] Subagent spawned: ${agentName}`);
      }

      return {};
    };
  }

  // Create a TeammateIdle hook that updates team member status when a teammate goes idle.
  // Purely observational — emits events for dashboard/Pusher visibility.
  private createTeammateIdleHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'TeammateIdle') return {};

      const teammateName = (input as any).teammate_name as string;
      const teamName = (input as any).team_name as string;

      // Update team member status if we're tracking team state
      if (worker.teamState) {
        const member = worker.teamState.members.find(m => m.name === teammateName);
        if (member) {
          member.status = 'idle';
        }
      }

      this.addMilestone(worker, { type: 'status', label: `Teammate idle: ${teammateName}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Teammate idle: ${teammateName} (team: ${teamName})`);

      return {};
    };
  }

  // Create a PermissionRequest hook that captures permission dialog events for analytics.
  // Purely observational — emits event with tool_name, tool_input, and permission_suggestions.
  private createPermissionRequestHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PermissionRequest') return {};

      const toolName = (input as any).tool_name as string;
      const toolInput = (input as any).tool_input as Record<string, unknown>;
      const permissionSuggestions = (input as any).permission_suggestions as unknown[] | undefined;

      console.log(`[Worker ${worker.id}] Permission requested: ${toolName}`);

      return {};
    };
  }

  // Create a TaskCompleted hook that logs task completions within agent teams.
  // Emits milestones and updates team state for dashboard visibility.
  private createTaskCompletedHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'TaskCompleted') return {};

      const taskId = (input as any).task_id as string;
      const taskSubject = (input as any).task_subject as string;
      const teammateName = (input as any).teammate_name as string | undefined;
      const teamName = (input as any).team_name as string | undefined;

      // Update team member status if completed by a known teammate
      if (worker.teamState && teammateName) {
        const member = worker.teamState.members.find(m => m.name === teammateName);
        if (member) {
          member.status = 'done';
        }
      }

      const label = teammateName
        ? `Task done (${teammateName}): ${taskSubject.slice(0, 50)}`
        : `Task done: ${taskSubject.slice(0, 50)}`;
      this.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Task completed: ${taskSubject} (teammate: ${teammateName || 'leader'}, team: ${teamName || 'none'})`);

      return {};
    };
  }

  // Create a SubagentStart hook that tracks subagent spawning.
  // Updates team state and emits milestones for dashboard visibility.
  private createSubagentStartHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'SubagentStart') return {};

      const agentId = (input as any).agent_id as string;
      const agentType = (input as any).agent_type as string;

      // Update team member status if we're tracking team state
      if (worker.teamState) {
        const member = worker.teamState.members.find(m => m.name === agentId);
        if (member) {
          member.status = 'active';
        }
      }

      this.addMilestone(worker, { type: 'status', label: `Subagent started: ${agentType}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent started: ${agentType} (id: ${agentId})`);

      return {};
    };
  }

  // Create a SubagentStop hook that tracks subagent completion.
  // Updates team state and emits milestones for dashboard visibility.
  private createSubagentStopHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'SubagentStop') return {};

      const stopHookActive = (input as any).stop_hook_active as boolean;

      this.addMilestone(worker, { type: 'status', label: 'Subagent stopped', ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent stopped (stop_hook_active: ${stopHookActive})`);

      return {};
    };
  }

  // Create a Notification hook that captures agent status messages.
  // Emits milestones for dashboard visibility and logs the notification.
  private createNotificationHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'Notification') return {};

      const message = (input as any).message as string;
      const title = (input as any).title as string | undefined;

      const label = title
        ? `${title}: ${message.slice(0, 60)}`
        : message.slice(0, 80);
      this.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Notification: ${title ? `[${title}] ` : ''}${message}`);

      return {};
    };
  }

  // Create a PreCompact hook that archives the full transcript before context compaction.
  // This preserves worker reasoning history that would otherwise be lost during compaction.
  private createPreCompactHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreCompact') return {};

      const transcriptPath = (input as any).transcript_path as string | undefined;
      const trigger = (input as any).trigger as 'manual' | 'auto' | undefined;

      if (!transcriptPath) return {};

      try {
        const transcript = readFileSync(transcriptPath, 'utf-8');
        this.addMilestone(worker, { type: 'status', label: `Transcript archived (${trigger || 'auto'} compaction)`, ts: Date.now() });
        this.emit({
          type: 'transcript_archived',
          worker,
          data: {
            trigger: trigger || 'auto',
            transcriptPath,
            transcript,
          },
        });
        console.log(`[Worker ${worker.id}] Transcript archived before ${trigger || 'auto'} compaction (${transcript.length} chars)`);
      } catch {
        // Transcript file may not exist or be unreadable — non-fatal
      }
      return {};
    };
  }

  // Resolve whether to use bypassPermissions mode.
  // Priority: workspace gitConfig (if admin_confirmed) > local config > default (false)
  private resolveBypassPermissions(workspaceConfig: { gitConfig?: any; configStatus?: string }): boolean {
    const isAdminConfirmed = workspaceConfig.configStatus === 'admin_confirmed';
    const wsBypass = workspaceConfig.gitConfig?.bypassPermissions;

    // Workspace-level setting takes priority if admin confirmed
    if (isAdminConfirmed && typeof wsBypass === 'boolean') {
      return wsBypass;
    }

    // Fall back to local-ui config
    if (typeof this.config.bypassPermissions === 'boolean') {
      return this.config.bypassPermissions;
    }

    // Default: false
    return false;
  }

  // Resolve maxBudgetUsd for SDK cost control.
  // Priority: workspace gitConfig (if admin_confirmed) > local config > undefined (no limit)
  private resolveMaxBudgetUsd(workspaceConfig: { gitConfig?: any; configStatus?: string }): number | undefined {
    const isAdminConfirmed = workspaceConfig.configStatus === 'admin_confirmed';
    const wsBudget = workspaceConfig.gitConfig?.maxBudgetUsd;

    // Workspace-level setting takes priority if admin confirmed
    if (isAdminConfirmed && typeof wsBudget === 'number' && wsBudget > 0) {
      return wsBudget;
    }

    // Fall back to local-ui config
    if (typeof this.config.maxBudgetUsd === 'number' && this.config.maxBudgetUsd > 0) {
      return this.config.maxBudgetUsd;
    }

    return undefined;
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
    this.sessions.set(worker.id, { inputStream, abortController, cwd, repoPath });

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

      // Fetch workspace memory context in parallel: full digest + task-specific matches
      const [compactResult, taskSearchResults] = await Promise.all([
        this.buildd.getCompactObservations(task.workspaceId),
        this.buildd.searchObservations(task.workspaceId, task.title, 5),
      ]);

      // Build prompt with workspace context
      const promptParts: string[] = [];

      // Add admin-defined agent instructions (if configured)
      if (isConfigured && gitConfig?.agentInstructions) {
        promptParts.push(`## Workspace Instructions\n${gitConfig.agentInstructions}`);
      }

      // Add git workflow context (if configured and not 'none' strategy)
      // 'none' strategy means defer entirely to CLAUDE.md / project conventions
      if (isConfigured && gitConfig && gitConfig.branchingStrategy !== 'none') {
        const gitContext: string[] = ['## Git Workflow'];
        gitContext.push(`- Default branch: ${gitConfig.defaultBranch}`);

        if (gitConfig.branchPrefix) {
          gitContext.push(`- Branch naming: ${gitConfig.branchPrefix}<task-name>`);
        } else if (gitConfig.useBuildBranch) {
          gitContext.push(`- Branch naming: buildd/<task-id>-<task-name>`);
        }

        // Tell the worker their branch is already set up (worktree mode)
        if (worker.worktreePath) {
          gitContext.push(`- Your branch \`${worker.branch}\` is already checked out with latest code from \`origin/${gitConfig.defaultBranch}\``);
          gitContext.push(`- You are working in an isolated worktree — commit and push directly, do NOT switch branches`);
        }

        if (gitConfig.requiresPR) {
          gitContext.push(`- Changes require PR to ${gitConfig.targetBranch || gitConfig.defaultBranch}`);
          if (gitConfig.autoCreatePR) {
            gitContext.push(`- Create PR when done`);
          }
        }

        if (gitConfig.commitStyle === 'conventional') {
          gitContext.push(`- Use conventional commits (feat:, fix:, chore:, etc.)`);
        }

        promptParts.push(gitContext.join('\n'));
      }

      // Add rich workspace memory context
      const MAX_MEMORY_BYTES = 4096;
      if (compactResult.count > 0 || taskSearchResults.length > 0) {
        const memoryContext: string[] = ['## Workspace Memory'];

        // Inject compact workspace digest (capped to prevent prompt bloat)
        if (compactResult.markdown) {
          let digest = compactResult.markdown;
          if (digest.length > MAX_MEMORY_BYTES) {
            digest = digest.slice(0, MAX_MEMORY_BYTES) + '\n\n*(truncated — use `buildd_search_memory` for more)*';
          }
          memoryContext.push(digest);
        }

        // Fetch full content for task-specific matches and add as subsection
        if (taskSearchResults.length > 0) {
          const fullObservations = await this.buildd.getBatchObservations(
            task.workspaceId,
            taskSearchResults.map(r => r.id),
          );
          if (fullObservations.length > 0) {
            memoryContext.push('### Relevant to This Task');
            for (const obs of fullObservations) {
              const truncContent = obs.content.length > 300
                ? obs.content.slice(0, 300) + '...'
                : obs.content;
              memoryContext.push(`- **[${obs.type}] ${obs.title}**: ${truncContent}`);
            }
          }
        }

        memoryContext.push('\nUse `buildd_search_memory` for more context and `buildd_save_memory` to record learnings.');
        promptParts.push(memoryContext.join('\n'));
      }

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

      // Also handle skillRef (single skill reference from task context)
      const skillRef = (task.context as any)?.skillRef as { skillId: string; slug: string; contentHash: string } | undefined;
      if (skillRef && !skillSlugs.includes(skillRef.slug)) {
        skillSlugs.push(skillRef.slug);
      }

      // Add task description
      // Clean up description: strip anything after "---" separator which might be polluted context from previous runs
      let taskDescription = task.description || task.title;
      const separatorIndex = taskDescription.indexOf('\n---');
      if (separatorIndex > 0) {
        taskDescription = taskDescription.substring(0, separatorIndex).trim();
      }
      promptParts.push(`## Task\n${taskDescription}`);

      // Add communication instruction (Layer 2: keep session alive via AskUserQuestion)
      promptParts.push(`## Communication\nWhen presenting options, recommendations, or asking the user how to proceed, use the AskUserQuestion tool instead of ending with a text question. This keeps context alive for follow-up work.`);

      // Add task metadata
      promptParts.push(`---\nTask ID: ${task.id}\nWorkspace: ${worker.workspaceName}`);

      const promptText = promptParts.join('\n\n');

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

      // Enable Agent Teams (SDK handles TeamCreate, SendMessage, TaskCreate/Update/List)
      cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

      // Determine whether to load CLAUDE.md
      // Default to true if not configured, respect admin setting if configured
      const useClaudeMd = !isConfigured || gitConfig?.useClaudeMd !== false;

      // Resolve permission mode
      const bypassPermissions = this.resolveBypassPermissions(workspaceConfig);
      const permissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions' = task.mode === 'planning'
        ? 'plan'
        : bypassPermissions ? 'bypassPermissions' : 'acceptEdits';

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
      let agents: Record<string, { description: string; prompt: string; tools: string[]; model: string }> | undefined;
      if (useSkillAgents && skillBundles && skillBundles.length > 0) {
        agents = {};
        for (const bundle of skillBundles) {
          agents[bundle.slug] = {
            description: bundle.description || bundle.name,
            prompt: bundle.content,
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
            model: 'inherit',
          };
        }
      }

      // Build plugins and sandbox config from workspace config
      const pluginPaths: string[] = gitConfig?.pluginPaths || [];
      const plugins = pluginPaths.map((p: string) => ({ type: 'local' as const, path: p }));
      const sandboxConfig = gitConfig?.sandbox?.enabled ? gitConfig.sandbox : undefined;

      // Resolve max budget for SDK-level cost control
      const maxBudgetUsd = this.resolveMaxBudgetUsd(workspaceConfig);

      // Build query options
      const queryOptions: Parameters<typeof query>[0]['options'] = {
        sessionId: worker.id,
        cwd,
        model: this.config.model,
        abortController,
        env: cleanEnv,
        settingSources: useClaudeMd ? ['user', 'project'] : ['user'],  // Load user skills + optionally CLAUDE.md
        permissionMode,
        systemPrompt,
        enableFileCheckpointing: true,
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        ...(agents ? { agents } : {}),
        ...(plugins.length > 0 ? { plugins } : {}),
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
      };

      // Attach Buildd MCP server so workers can list/update/create tasks
      const mcpServerPath = join(__dirname, '../../mcp-server/src/index.ts');
      queryOptions.mcpServers = {
        buildd: {
          command: 'bun',
          args: ['run', mcpServerPath],
          env: {
            BUILDD_SERVER: this.config.builddServer,
            BUILDD_API_KEY: this.config.apiKey,
            BUILDD_WORKSPACE_ID: task.workspaceId,
            BUILDD_WORKER_ID: worker.id,
          },
        },
      };

      // Attach permission hook (blocks dangerous commands, allows safe bash),
      // team tracking hook (captures TeamCreate, SendMessage, Task events),
      // and agent team lifecycle hooks (TeammateIdle, TaskCompleted, SubagentStart, SubagentStop).
      queryOptions.hooks = {
        PreToolUse: [{ hooks: [this.createPermissionHook(worker)] }],
        PostToolUse: [{ hooks: [this.createTeamTrackingHook(worker)] }],
        Notification: [{ hooks: [this.createNotificationHook(worker)] }],
        PreCompact: [{ hooks: [this.createPreCompactHook(worker)] }],
        PermissionRequest: [{ hooks: [this.createPermissionRequestHook(worker)] }],
        TeammateIdle: [{ hooks: [this.createTeammateIdleHook(worker)] }],
        TaskCompleted: [{ hooks: [this.createTaskCompletedHook(worker)] }],
        SubagentStart: [{ hooks: [this.createSubagentStartHook(worker)] }],
        SubagentStop: [{ hooks: [this.createSubagentStopHook(worker)] }],
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

      // Stream responses
      let resultSubtype: string | undefined;
      let structuredOutput: Record<string, unknown> | undefined;
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

        // Break on result - the query is complete
        if (msg.type === 'result') {
          break;
        }
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
        const gitStats = await this.collectGitStats(worker.id, worker.branch);
        worker.status = 'error';
        worker.error = 'Budget limit exceeded';
        worker.currentAction = 'Budget exceeded';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: 'Budget limit exceeded (maxBudgetUsd)',
          milestones: worker.milestones,
          ...gitStats,
        });
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
      } else {
        // Actually completed - collect git stats before reporting
        sessionLog(worker.id, 'info', 'session_complete', `resultSubtype=${resultSubtype}`, worker.taskId);
        const gitStats = await this.collectGitStats(worker.id, worker.branch);
        this.addMilestone(worker, { type: 'status', label: 'Task completed', ts: Date.now() });
        this.addCheckpoint(worker, CheckpointEvent.TASK_COMPLETED);
        worker.status = 'done';
        worker.currentAction = 'Completed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
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
        });
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);

        // Capture summary observation (non-fatal)
        try {
          const summary = this.buildSessionSummary(worker);
          const files = this.extractFilesFromToolCalls(worker.toolCalls);

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
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error
        }).catch(err => console.error(`[Worker ${worker.id}] Failed to sync error status:`, err));
      }
      this.emit({ type: 'worker_update', worker });
      storeSaveWorker(worker);
    } finally {
      // Clean up session
      const session = this.sessions.get(worker.id);
      if (session) {
        session.inputStream.end();

        // Clean up worktree if used (after session is fully done)
        if (worker.worktreePath) {
          await this.cleanupWorktree(session.repoPath, worker.worktreePath, worker.id).catch(err => {
            console.error(`[Worker ${worker.id}] Worktree cleanup failed:`, err);
          });
        }

        this.sessions.delete(worker.id);
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

    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      worker.sessionId = msg.session_id;
      this.addCheckpoint(worker, CheckpointEvent.SESSION_STARTED);
      // Immediately persist sessionId (critical for resume)
      storeSaveWorker(worker);
    }

    // Surface rate limit events from SDK (v0.2.45+)
    if (msg.type === 'system' && (msg as any).subtype === 'rate_limit') {
      const event = msg as any;
      const retryMs = event.retry_after_ms;
      const utilization = event.utilization;
      const label = retryMs
        ? `Rate limited — retrying in ${Math.ceil(retryMs / 1000)}s`
        : utilization
          ? `Rate limit: ${Math.round(utilization * 100)}% utilized`
          : 'Rate limited';
      worker.currentAction = label;
      this.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Rate limit event: ${label}`);
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
      const subagentTask: SubagentTask = {
        taskId: event.task_id,
        toolUseId: event.tool_use_id,
        description: event.description || '',
        taskType: event.task_type || 'unknown',
        startedAt: Date.now(),
        status: 'running',
      };
      worker.subagentTasks.push(subagentTask);
      // Keep last 100 subagent tasks
      if (worker.subagentTasks.length > 100) {
        worker.subagentTasks.shift();
      }
      this.addMilestone(worker, { type: 'status', label: `Subagent started: ${subagentTask.description.slice(0, 50)}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent task started: ${subagentTask.taskId} (${subagentTask.taskType}) — ${subagentTask.description}`);
      this.emit({ type: 'worker_update', worker });
    }

    // SDK v0.2.45: Subagent task notification — completion/status update for a tracked task
    if (msg.type === 'system' && (msg as any).subtype === 'task_notification') {
      const event = msg as any;
      const taskId = event.task_id as string;
      const status = event.status as string;
      const message = event.message as string | undefined;

      // Update tracked subagent task
      const tracked = worker.subagentTasks.find(t => t.taskId === taskId);
      if (tracked) {
        tracked.status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : tracked.status;
        tracked.completedAt = Date.now();
        if (message) tracked.message = message;
      }

      const label = tracked
        ? `Subagent ${status}: ${tracked.description.slice(0, 50)}`
        : `Subagent ${status}: ${taskId.slice(0, 12)}`;
      this.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent task ${status}: ${taskId}${message ? ` — ${message}` : ''}`);
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
            console.log(`[Worker ${worker.id}] AskUserQuestion detected — toolUseId=${toolUseId}, question="${firstQuestion?.question?.slice(0, 60)}"`);
            worker.status = 'waiting';
            worker.waitingFor = {
              type: 'question',
              prompt: firstQuestion?.question || 'Awaiting input',
              options: firstQuestion?.options,
              toolUseId,
            };
            worker.currentAction = firstQuestion?.header || 'Question';
            this.addMilestone(worker, { type: 'status', label: `Question: ${firstQuestion?.header || 'Awaiting input'}`, ts: Date.now() });
            // Immediately sync waiting state to server and disk
            this.buildd.updateWorker(worker.id, {
              status: 'waiting_input',
              currentAction: worker.currentAction,
              waitingFor: {
                type: 'question',
                prompt: firstQuestion?.question || 'Awaiting input',
                options: firstQuestion?.options?.map((o: any) => typeof o === 'string' ? o : o.label),
              },
            }).catch(() => {});
            storeSaveWorker(worker);
          } else if (toolName === 'EnterPlanMode') {
            // Auto-approve entering plan mode — respond immediately so the SDK doesn't stall
            const enterPlanToolUseId = block.id as string | undefined;
            console.log(`[Worker ${worker.id}] EnterPlanMode detected — auto-approving, toolUseId=${enterPlanToolUseId}`);
            sessionLog(worker.id, 'info', 'enter_plan_mode', `toolUseId=${enterPlanToolUseId}`, worker.taskId);
            worker.currentAction = 'Planning...';
            this.addMilestone(worker, { type: 'status', label: 'Entering plan mode', ts: Date.now() });
            // Enqueue approval response so the SDK can proceed
            const session = this.sessions.get(worker.id);
            if (session && enterPlanToolUseId) {
              session.inputStream.enqueue(buildUserMessage('Approved — enter plan mode.', {
                parentToolUseId: enterPlanToolUseId,
                sessionId: worker.sessionId,
              }));
            }
          } else if (toolName === 'ExitPlanMode') {
            // Extract plan content from recent text messages before ExitPlanMode
            // Plans can span multiple text blocks, so grab the last few and join them
            const textMessages = worker.messages.filter(m => m.type === 'text');
            // Take last 3 text messages to capture multi-block plans
            const planParts = textMessages.slice(-3).map(m => m.content).filter(Boolean);
            worker.planContent = planParts.join('\n\n') || '';
            console.log(`[Worker ${worker.id}] ExitPlanMode — planContent length: ${worker.planContent.length} chars`);
            const planToolUseId = block.id as string | undefined;
            console.log(`[Worker ${worker.id}] ExitPlanMode detected — toolUseId=${planToolUseId}`);
            sessionLog(worker.id, 'info', 'exit_plan_mode', `planLength=${worker.planContent.length} toolUseId=${planToolUseId}`, worker.taskId);
            this.addCheckpoint(worker, CheckpointEvent.PLAN_SUBMITTED);
            worker.status = 'waiting';
            worker.waitingFor = {
              type: 'plan_approval',
              prompt: 'Agent has proposed a plan. Review the plan above, then approve or request changes.',
              options: [
                { label: 'Approve & implement', description: 'Let the agent proceed with the plan' },
                { label: 'Request changes', description: 'Ask the agent to revise its approach' },
              ],
              toolUseId: planToolUseId,
            };
            worker.currentAction = 'Awaiting plan approval';
            worker.hasNewActivity = true;
            worker.lastActivity = Date.now();
            this.addMilestone(worker, { type: 'status', label: 'Plan ready for review', ts: Date.now() });
            this.emit({ type: 'worker_update', worker });
            this.buildd.updateWorker(worker.id, {
              status: 'waiting_input',
              currentAction: worker.currentAction,
              waitingFor: {
                type: 'plan_approval',
                prompt: worker.waitingFor.prompt,
                options: ['Approve & implement', 'Request changes'],
              },
            }).catch(() => {});
            storeSaveWorker(worker);
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
    // Keep last 30 milestones
    if (worker.milestones.length > 30) {
      worker.milestones.shift();
    }
    this.emit({ type: 'milestone', workerId: worker.id, milestone });

    // Sync this worker immediately so web dashboard sees milestones right away
    if (worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting') {
      this.syncWorkerToServer(worker).catch(() => {});
    }
  }

  // Fire a meaningful checkpoint milestone (each event fires at most once per worker)
  private addCheckpoint(worker: LocalWorker, event: CheckpointEventType) {
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
    const session = this.sessions.get(workerId);
    if (session) {
      // Abort the query and end the input stream
      session.abortController.abort();
      session.inputStream.end();
      this.sessions.delete(workerId);
    }

    // Unsubscribe from Pusher
    this.unsubscribeFromWorker(workerId);

    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'error';
      // Preserve existing error (e.g., from infinite loop detection) or use provided reason
      worker.error = worker.error || reason || 'Aborted by user';
      worker.currentAction = 'Aborted';
      // This may return 409 if already completed on server - that's ok
      try {
        await this.buildd.updateWorker(workerId, { status: 'failed', error: worker.error });
      } catch {
        // Ignore - worker may already be done on server
      }
      this.emit({ type: 'worker_update', worker });
    }
  }

  getSessionLogs(workerId: string, maxLines = 100) {
    return readSessionLogs(workerId, maxLines);
  }

  async rollback(workerId: string, checkpointUuid: string, dryRun = false): Promise<{ success: boolean; error?: string; filesChanged?: number; insertions?: number; deletions?: number }> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return { success: false, error: 'Worker not found' };
    }

    const session = this.sessions.get(workerId);
    if (!session?.queryInstance) {
      return { success: false, error: 'No active session — rollback requires a running or recently completed query' };
    }

    // Verify checkpoint exists
    const checkpoint = worker.checkpoints.find(cp => cp.uuid === checkpointUuid);
    if (!checkpoint) {
      return { success: false, error: 'Checkpoint not found' };
    }

    try {
      console.log(`[Worker ${workerId}] ${dryRun ? 'Dry-run' : 'Rolling back'} to checkpoint ${checkpointUuid.slice(0, 12)} (${checkpoint.files.length} files)`);
      const result = await session.queryInstance.rewindFiles(checkpointUuid, { dryRun });

      if (!result.canRewind) {
        return { success: false, error: result.error || 'Cannot rewind to this checkpoint' };
      }

      if (!dryRun) {
        this.addMilestone(worker, {
          type: 'status',
          label: `Rollback: ${result.filesChanged || 0} files reverted`,
          ts: Date.now(),
        });
        // Remove checkpoints after the rolled-back one (they're now invalid)
        const cpIndex = worker.checkpoints.findIndex(cp => cp.uuid === checkpointUuid);
        if (cpIndex >= 0) {
          worker.checkpoints = worker.checkpoints.slice(0, cpIndex + 1);
        }
        worker.hasNewActivity = true;
        this.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
      }

      return {
        success: true,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Worker ${workerId}] Rollback failed:`, errMsg);
      return { success: false, error: errMsg };
    }
  }

  async retry(workerId: string) {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Abort current session if any
    const session = this.sessions.get(workerId);
    if (session) {
      session.abortController.abort();
      session.inputStream.end();
      this.sessions.delete(workerId);
    }

    // Reset worker state
    worker.status = 'working';
    worker.error = undefined;
    worker.currentAction = 'Retrying...';
    worker.hasNewActivity = true;
    worker.lastActivity = Date.now();
    worker.completedAt = undefined;
    worker.checkpoints = [];  // Clear checkpoints — new session generates fresh ones
    this.addMilestone(worker, { type: 'status', label: 'Retry requested', ts: Date.now() });
    this.emit({ type: 'worker_update', worker });
    storeSaveWorker(worker);

    await this.buildd.updateWorker(worker.id, { status: 'running', currentAction: 'Retrying...' });

    // Resolve workspace
    const workspacePath = this.resolver.resolve({
      id: worker.workspaceId,
      name: worker.workspaceName,
      repo: undefined,
    });

    if (!workspacePath) {
      worker.status = 'error';
      worker.error = 'Cannot resolve workspace path - check PROJECTS_ROOT or set a path override';
      worker.currentAction = 'Workspace not found';
      worker.hasNewActivity = true;
      worker.completedAt = Date.now();
      this.emit({ type: 'worker_update', worker });
      await this.buildd.updateWorker(worker.id, { status: 'failed', error: worker.error });
      return;
    }

    // Build context-preserving description (same as follow-up but with retry framing)
    const contextParts: string[] = [];
    if (worker.taskDescription) {
      contextParts.push(`## Original Task\n${worker.taskDescription}`);
    }

    // Include what was done so far
    if (worker.milestones.length > 0) {
      const milestoneLabels = worker.milestones
        .filter(m => !['Task completed', 'Retry requested'].includes(m.label))
        .map(m => m.type === 'phase' ? `- ${m.label} (${m.toolCount} tools)` : `- ${m.label}`);
      if (milestoneLabels.length > 0) {
        contextParts.push(`## Work Done Before Retry\n${milestoneLabels.join('\n')}`);
      }
    }

    contextParts.push('## Instructions\nThe previous session stalled. Please continue the task from where it left off.');

    const task = {
      id: worker.taskId,
      title: worker.taskTitle,
      description: contextParts.join('\n\n'),
      workspaceId: worker.workspaceId,
      workspace: { name: worker.workspaceName },
      status: 'assigned',
      priority: 1,
    };

    this.startSession(worker, workspacePath, task as any).catch(err => {
      console.error(`[Worker ${worker.id}] Retry session error:`, err);
      if (worker.status === 'working') {
        worker.status = 'error';
        worker.error = err instanceof Error ? err.message : 'Retry session failed';
        worker.currentAction = 'Retry failed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        this.emit({ type: 'worker_update', worker });
      }
    });
  }

  async retryWithPlan(workerId: string) {
    const worker = this.workers.get(workerId);
    if (!worker || !worker.planContent) return;

    sessionLog(worker.id, 'info', 'retry_with_plan', `planLength=${worker.planContent.length}`, worker.taskId);

    // Abort current session if any
    const session = this.sessions.get(workerId);
    if (session) {
      session.abortController.abort();
      session.inputStream.end();
      this.sessions.delete(workerId);
    }

    // Reset worker state
    worker.status = 'working';
    worker.error = undefined;
    worker.currentAction = 'Re-executing plan...';
    worker.hasNewActivity = true;
    worker.lastActivity = Date.now();
    worker.completedAt = undefined;
    this.addMilestone(worker, { type: 'status', label: 'Retrying with saved plan', ts: Date.now() });
    this.emit({ type: 'worker_update', worker });
    storeSaveWorker(worker);

    await this.buildd.updateWorker(worker.id, { status: 'running', currentAction: 'Re-executing plan...' });

    const workspacePath = this.resolver.resolve({
      id: worker.workspaceId,
      name: worker.workspaceName,
      repo: undefined,
    });

    if (!workspacePath) {
      worker.status = 'error';
      worker.error = 'Cannot resolve workspace path';
      worker.currentAction = 'Workspace not found';
      worker.hasNewActivity = true;
      worker.completedAt = Date.now();
      this.emit({ type: 'worker_update', worker });
      await this.buildd.updateWorker(worker.id, { status: 'failed', error: worker.error });
      return;
    }

    const task: BuilddTask = {
      id: worker.taskId,
      title: worker.taskTitle,
      description: `Execute this plan:\n\n${worker.planContent}`,
      workspaceId: worker.workspaceId,
      workspace: { name: worker.workspaceName },
      status: 'assigned',
      priority: 1,
      mode: 'execution',
    };

    this.startSession(worker, workspacePath, task).catch(err => {
      const errMsg = err instanceof Error ? err.message : 'Plan retry failed';
      console.error(`[Worker ${worker.id}] Plan retry failed:`, err);
      sessionLog(worker.id, 'error', 'plan_retry_failed', errMsg, worker.taskId);
      if (worker.status === 'working') {
        worker.status = 'error';
        worker.error = errMsg;
        worker.currentAction = 'Plan retry failed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        this.emit({ type: 'worker_update', worker });
      }
    });
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
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    const session = this.sessions.get(workerId);

    // If worker is done, errored, or stale — restart with a new session.
    // Handle both cases: session already cleaned up (!session) or still lingering
    // during the completion window (race between status='done' and finally-block cleanup).
    if (worker.status === 'done' || worker.status === 'error' || (worker.status === 'stale' && !session)) {
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

      // Layer 1: Try resuming the SDK session (preserves full context from disk)
      if (worker.sessionId) {
        console.log(`[Worker ${worker.id}] Resuming session ${worker.sessionId} with follow-up`);

        // For resume, the prompt is just the follow-up message — the SDK loads full history
        const task = {
          id: worker.taskId,
          title: worker.taskTitle,
          description: message,
          workspaceId: worker.workspaceId,
          workspace: { name: worker.workspaceName },
          status: 'assigned',
          priority: 1,
        };

        this.startSession(worker, workspacePath, task as any, worker.sessionId).catch(err => {
          console.error(`[Worker ${worker.id}] Resume failed, falling back to reconstruction:`, err);

          // Fallback: restart with text-reconstructed context
          this.restartWithReconstructedContext(worker, workspacePath!, message).catch(err2 => {
            console.error(`[Worker ${worker.id}] Fallback session error:`, err2);
            if (worker.status === 'working') {
              worker.status = 'error';
              worker.error = err2 instanceof Error ? err2.message : 'Follow-up session failed';
              worker.currentAction = 'Follow-up failed';
              worker.hasNewActivity = true;
              worker.completedAt = Date.now();
              this.emit({ type: 'worker_update', worker });
            }
          });
        });

        return true;
      }

      // Layer 3 fallback: No sessionId available, use text reconstruction
      console.log(`[Worker ${worker.id}] No sessionId — using reconstructed context`);
      this.restartWithReconstructedContext(worker, workspacePath, message).catch(err => {
        console.error(`[Worker ${worker.id}] Follow-up session error:`, err);
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

    // Plan approval: kill current session and start fresh with plan as prompt
    if (worker.status === 'waiting' && worker.waitingFor?.type === 'plan_approval') {
      const isApproval = message === 'Approve & implement';

      if (isApproval) {
        // Use planContent, fall back to last text message if somehow empty
        const planText = worker.planContent || worker.messages.filter(m => m.type === 'text').slice(-1)[0]?.content || '';
        if (!planText) {
          console.error(`[Worker ${worker.id}] Plan approval but no plan content found — falling through to enqueue`);
          sessionLog(worker.id, 'warn', 'plan_approval_empty', 'No plan content found, falling through to enqueue', worker.taskId);
          // Fall through to normal enqueue so the message at least reaches the agent
        } else {
          // Kill current session
          session.abortController.abort();
          session.inputStream.end();
          this.sessions.delete(workerId);

          // Build execution task with plan as description
          const executionPrompt = `Execute this plan:\n\n${planText}`;
          const task: BuilddTask = {
            id: worker.taskId,
            title: worker.taskTitle,
            description: executionPrompt,
            workspaceId: worker.workspaceId,
            workspace: { name: worker.workspaceName },
            status: 'assigned',
            priority: 1,
            mode: 'execution',
          };

          // Reset worker state
          worker.status = 'working';
          worker.waitingFor = undefined;
          worker.planContent = undefined;
          worker.currentAction = 'Executing plan...';
          worker.hasNewActivity = true;
          worker.lastActivity = Date.now();
          this.addMilestone(worker, { type: 'status', label: 'Plan approved — executing with fresh context', ts: Date.now() });
          sessionLog(worker.id, 'info', 'plan_approved', `planLength=${planText.length}`, worker.taskId);
          this.addChatMessage(worker, { type: 'user', content: message, timestamp: Date.now() });
          this.emit({ type: 'worker_update', worker });

          // Start fresh session (no resumeSessionId = clean context)
          // Must await to ensure session is registered before returning
          const workspacePath = this.resolver.resolve({
            id: worker.workspaceId,
            name: worker.workspaceName,
            repo: undefined,
          });
          if (workspacePath) {
            this.startSession(worker, workspacePath, task).catch(err => {
              const errMsg = err instanceof Error ? err.message : 'Plan execution failed';
              console.error(`[Worker ${worker.id}] Fresh plan execution failed:`, err);
              sessionLog(worker.id, 'error', 'plan_execution_failed', errMsg, worker.taskId);
              worker.status = 'error';
              worker.error = errMsg;
              worker.currentAction = 'Execution failed';
              worker.hasNewActivity = true;
              worker.completedAt = Date.now();
              this.emit({ type: 'worker_update', worker });
            });
          }

          // Sync to server
          this.buildd.updateWorker(worker.id, {
            status: 'running',
            currentAction: 'Executing plan...',
            waitingFor: null,
          }).catch(() => {});

          return true;
        }
      }
      // "Request changes", custom text, or empty plan — falls through to normal enqueue
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

  // Layer 3 fallback: Restart session with text-reconstructed context
  // Used when resume fails (corrupted session, disk cleanup) or no sessionId available
  private async restartWithReconstructedContext(worker: LocalWorker, workspacePath: string, message: string) {
    const contextParts: string[] = [];

    // Preamble: instruct agent not to re-explore
    contextParts.push(`## IMPORTANT: Continuing a previous conversation\nYou already analyzed this codebase in a previous session. Do NOT re-read files or re-explore the codebase unless the user asks about something new. Act directly on your previous analysis summarized below.`);

    // Add original task description
    if (worker.taskDescription) {
      contextParts.push(`## Original Task\n${worker.taskDescription}`);
    }

    // Extract files explored/modified from tool calls
    const filesExplored = new Set<string>();
    const filesModified = new Set<string>();
    for (const tc of worker.toolCalls) {
      const filePath = tc.input?.file_path as string;
      if (tc.name === 'Read' && filePath) {
        filesExplored.add(filePath);
      } else if ((tc.name === 'Edit' || tc.name === 'Write') && filePath) {
        filesModified.add(filePath);
      }
    }

    // Collapsed files context (grouped, not one-per-line)
    if (filesExplored.size > 0 || filesModified.size > 0) {
      const filesContext: string[] = ['## Files Context'];
      if (filesExplored.size > 0) {
        filesContext.push(`Files explored: ${Array.from(filesExplored).slice(-20).join(', ')}`);
      }
      if (filesModified.size > 0) {
        filesContext.push(`Files modified: ${Array.from(filesModified).join(', ')}`);
      }
      contextParts.push(filesContext.join('\n'));
    }

    // Build conversation history with collapsed tool calls
    const recentMessages = worker.messages.slice(-30);
    if (recentMessages.length > 0) {
      const historyLines: string[] = ['## Previous Conversation'];

      // Extract the last agent text response separately
      let lastAgentResponse: string | null = null;
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        if (recentMessages[i].type === 'text') {
          lastAgentResponse = recentMessages[i].content!;
          break;
        }
      }

      for (const msg of recentMessages) {
        if (msg.type === 'text') {
          // Skip the last response here — we add it separately below
          if (msg.content === lastAgentResponse) continue;
          historyLines.push(`**Agent:** ${msg.content}`);
        } else if (msg.type === 'user') {
          historyLines.push(`**User:** ${msg.content}`);
        }
        // Tool calls are omitted — file context above covers them
      }
      contextParts.push(historyLines.join('\n'));

      // Add the last agent response as a distinct section (this is what the user is replying to)
      if (lastAgentResponse) {
        contextParts.push(`## Your Last Response\n${lastAgentResponse}`);
      }
    }

    // Add milestones as work summary
    if (worker.milestones.length > 0) {
      const milestoneLabels = worker.milestones
        .filter(m => m.label !== 'Task completed')
        .map(m => m.type === 'phase' ? `- ${m.label} (${m.toolCount} tools)` : `- ${m.label}`);
      if (milestoneLabels.length > 0) {
        contextParts.push(`## Work Completed\n${milestoneLabels.join('\n')}`);
      }
    }

    // Add follow-up message
    contextParts.push(`## Follow-up Request\n${message}`);

    const contextDescription = contextParts.join('\n\n');

    const task = {
      id: worker.taskId,
      title: worker.taskTitle,
      description: contextDescription,
      workspaceId: worker.workspaceId,
      workspace: { name: worker.workspaceName },
      status: 'assigned',
      priority: 1,
    };

    await this.startSession(worker, workspacePath, task as any);
  }

  private buildSessionSummary(worker: LocalWorker): string {
    const parts: string[] = [];

    // Commits first (most useful for future workers)
    if (worker.commits.length > 0) {
      const commitMsgs = worker.commits.map(c => c.message).slice(-5);
      parts.push(`Commits: ${commitMsgs.join('; ')}`);
    }

    // Files modified
    const files = this.extractFilesFromToolCalls(worker.toolCalls);
    if (files.length > 0) {
      parts.push(`Files modified: ${files.slice(0, 10).join(', ')}`);
    }

    // Outcome from last output
    const lastOutput = worker.output.slice(-3).join(' ').trim();
    if (lastOutput) {
      const truncated = lastOutput.length > 300 ? lastOutput.slice(0, 300) + '...' : lastOutput;
      parts.push(`Outcome: ${truncated}`);
    }

    // Milestones (filtered: skip noise like "Reading..." entries)
    const milestones = worker.milestones
      .filter(m => m.label !== 'Task completed')
      .map(m => m.type === 'phase' ? `${m.label} (${m.toolCount} tools)` : m.label);
    if (milestones.length > 0) {
      parts.push(`Milestones: ${milestones.slice(-10).join(', ')}`);
    }

    const summary = parts.join('\n');
    return summary.length > 600 ? summary.slice(0, 600) + '...' : summary;
  }

  private extractFilesFromToolCalls(toolCalls: Array<{ name: string; input?: any }>): string[] {
    const files = new Set<string>();
    for (const tc of toolCalls) {
      if ((tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') && tc.input?.file_path) {
        files.add(tc.input.file_path);
      }
    }
    return Array.from(files).slice(0, 20);
  }

  /**
   * Set up an isolated git worktree for a worker.
   * Fetches latest from remote, creates a worktree branched from the default branch.
   * Returns the worktree path, or null if worktree setup fails (falls back to main repo).
   */
  private async setupWorktree(
    repoPath: string,
    branch: string,
    defaultBranch: string,
    workerId: string,
  ): Promise<string | null> {
    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const execOpts = { cwd: repoPath, timeout: 30000, encoding: 'utf-8' as const };

    // Worktrees live in .buildd-worktrees/ inside the repo
    const worktreeBase = join(repoPath, '.buildd-worktrees');
    const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '_');
    const worktreePath = join(worktreeBase, safeBranch);

    try {
      // Ensure worktree base directory exists
      fs.mkdirSync(worktreeBase, { recursive: true });

      // Add .buildd-worktrees to .git/info/exclude if not already there
      const excludePath = join(repoPath, '.git', 'info', 'exclude');
      if (existsSync(excludePath)) {
        const excludeContent = readFileSync(excludePath, 'utf-8');
        if (!excludeContent.includes('.buildd-worktrees')) {
          fs.appendFileSync(excludePath, '\n.buildd-worktrees\n');
        }
      }

      // Fetch latest from remote
      console.log(`[Worker ${workerId}] Fetching latest from remote...`);
      try {
        execSync('git fetch origin', execOpts);
      } catch (err) {
        console.warn(`[Worker ${workerId}] git fetch failed (continuing with local state):`, err instanceof Error ? err.message : err);
      }

      // Clean up stale worktree at this path if it exists
      if (existsSync(worktreePath)) {
        console.log(`[Worker ${workerId}] Cleaning up stale worktree at ${worktreePath}`);
        try {
          execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
        } catch {
          // Force-remove the directory if git worktree remove fails
          fs.rmSync(worktreePath, { recursive: true, force: true });
          try { execSync('git worktree prune', execOpts); } catch {}
        }
      }

      // Delete the branch if it already exists locally (stale from previous run)
      try {
        execSync(`git branch -D "${branch}"`, execOpts);
      } catch {
        // Branch doesn't exist locally, that's fine
      }

      // Create worktree with new branch from latest remote default branch
      const base = `origin/${defaultBranch}`;
      console.log(`[Worker ${workerId}] Creating worktree: ${worktreePath} (branch: ${branch}, base: ${base})`);
      execSync(`git worktree add -b "${branch}" "${worktreePath}" "${base}"`, execOpts);

      console.log(`[Worker ${workerId}] Worktree ready at ${worktreePath}`);
      return worktreePath;
    } catch (err) {
      console.error(`[Worker ${workerId}] Failed to set up worktree:`, err instanceof Error ? err.message : err);
      // Clean up partial worktree
      try {
        if (existsSync(worktreePath)) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        execSync('git worktree prune', { ...execOpts, timeout: 5000 });
      } catch {}
      return null;
    }
  }

  /**
   * Clean up a git worktree after worker completes.
   * Removes the worktree directory and prunes git worktree metadata.
   */
  private async cleanupWorktree(repoPath: string, worktreePath: string, workerId: string) {
    const { execSync } = await import('child_process');
    const fs = await import('fs');
    const execOpts = { cwd: repoPath, timeout: 10000, encoding: 'utf-8' as const };

    try {
      console.log(`[Worker ${workerId}] Removing worktree: ${worktreePath}`);
      execSync(`git worktree remove --force "${worktreePath}"`, execOpts);
    } catch (err) {
      console.warn(`[Worker ${workerId}] git worktree remove failed, cleaning up manually:`, err instanceof Error ? err.message : err);
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        execSync('git worktree prune', execOpts);
      } catch {}
    }

  }

  /** Collect git stats by running git commands in the worker's cwd */
  private async collectGitStats(workerId: string, branch: string): Promise<{
    commitCount?: number;
    filesChanged?: number;
    linesAdded?: number;
    linesRemoved?: number;
    lastCommitSha?: string;
  }> {
    const session = this.sessions.get(workerId);
    if (!session?.cwd) return {};

    const { execSync } = await import('child_process');
    const opts = { cwd: session.cwd, timeout: 5000, encoding: 'utf-8' as const };
    const stats: Record<string, number | string | undefined> = {};

    try {
      stats.lastCommitSha = execSync('git rev-parse HEAD', opts).trim();
    } catch {}
    try {
      // Count commits on this branch vs default branch
      const defaultBranch = execSync('git rev-parse --abbrev-ref HEAD@{upstream}', opts).trim().replace(/^origin\//, '') || 'main';
      const count = execSync(`git rev-list --count HEAD ^origin/${defaultBranch}`, opts).trim();
      stats.commitCount = parseInt(count, 10) || 0;
    } catch {
      // Fallback: use locally tracked commits
      const worker = this.workers.get(workerId);
      if (worker) stats.commitCount = worker.commits.length;
    }
    try {
      const numstat = execSync('git diff --numstat HEAD~1 2>/dev/null || true', opts).trim();
      if (numstat) {
        let added = 0, removed = 0, files = 0;
        for (const line of numstat.split('\n')) {
          const [a, r] = line.split('\t');
          if (a !== '-') { added += parseInt(a, 10) || 0; removed += parseInt(r, 10) || 0; files++; }
        }
        stats.filesChanged = files;
        stats.linesAdded = added;
        stats.linesRemoved = removed;
      }
    } catch {}

    return stats;
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
    // Unsubscribe from all Pusher channels
    for (const workerId of this.pusherChannels.keys()) {
      this.unsubscribeFromWorker(workerId);
    }
    if (this.pusher) {
      this.pusher.disconnect();
    }
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
