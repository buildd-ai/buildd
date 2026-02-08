import { query, type SDKMessage, type SDKUserMessage, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, LocalUIConfig, BuilddTask, WorkerCommand, ChatMessage } from './types';
import { BuilddClient } from './buildd';
import { createWorkspaceResolver, type WorkspaceResolver } from './workspace';
import { DANGEROUS_PATTERNS, SENSITIVE_PATHS } from '@buildd/shared';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Pusher from 'pusher-js';

type EventHandler = (event: any) => void;
type CommandHandler = (workerId: string, command: WorkerCommand) => void;

// Async message stream for multi-turn conversations
class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;

  enqueue(message: SDKUserMessage) {
    if (this.done) return;
    if (this.resolvers.length > 0) {
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
function buildUserMessage(content: string | Array<{ type: string; text?: string; source?: any }>): SDKUserMessage {
  const messageContent = typeof content === 'string'
    ? [{ type: 'text' as const, text: content }]
    : content;

  return {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: messageContent as any,
    },
    parent_tool_use_id: null,
  };
}

// Worker session state
interface WorkerSession {
  inputStream: MessageStream;
  abortController: AbortController;
  cwd: string;
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
  private cleanupInterval?: Timer;
  private heartbeatInterval?: Timer;
  private evictionInterval?: Timer;
  private viewerToken?: string;
  private dirtyWorkers = new Set<string>();

  constructor(config: LocalUIConfig, resolver?: WorkspaceResolver) {
    this.config = config;
    this.buildd = new BuilddClient(config);
    this.resolver = resolver || createWorkspaceResolver(config.projectsRoot);
    this.acceptRemoteTasks = config.acceptRemoteTasks !== false;

    // Check for stale workers every 30s
    this.staleCheckInterval = setInterval(() => this.checkStale(), 30_000);

    // Sync dirty worker state to server every 10s (immediate sync for critical changes via markDirty)
    this.syncInterval = setInterval(() => this.syncToServer(), 10_000);

    // Run cleanup every 30 minutes
    this.cleanupInterval = setInterval(() => this.runCleanup(), 30 * 60 * 1000);

    // Evict completed workers from memory every 5 minutes to prevent unbounded growth
    this.evictionInterval = setInterval(() => this.evictCompletedWorkers(), 5 * 60 * 1000);

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

      // Subscribe to workspace channels for task assignments if enabled
      if (this.acceptRemoteTasks) {
        this.subscribeToWorkspaceChannels();
      }
    }

    // Check if credentials exist (don't validate, SDK handles auth)
    this.hasCredentials = hasClaudeCredentials();
    if (this.hasCredentials) {
      console.log('Claude Code: credentials found');
    } else {
      console.warn('Claude Code: no credentials - run `claude login` or set ANTHROPIC_API_KEY');
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
          this.workspaceChannels.set(channelName, channel);
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
      this.pusher?.unsubscribe(channelName);
    }
    this.workspaceChannels.clear();
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
    }
  }

  // Sync a single worker's state to server
  private async syncWorkerToServer(worker: LocalWorker) {
    try {
      const update: Parameters<BuilddClient['updateWorker']>[1] = {
        status: worker.status === 'waiting' ? 'waiting_input' : 'running',
        currentAction: worker.currentAction,
        milestones: worker.milestones.map(m => ({ label: m.label, timestamp: m.timestamp || Date.now() })),
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
    // Auto-mark workers dirty for server sync when their state changes
    if (event.type === 'worker_update' && event.worker?.id) {
      this.dirtyWorkers.add(event.worker.id);
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
      const { viewerToken } = await this.buildd.sendHeartbeat(this.config.localUiUrl, activeCount);
      if (viewerToken) {
        this.viewerToken = viewerToken;
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
      }
    }
  }

  private checkStale() {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (worker.status === 'working' && now - worker.lastActivity > 120_000) {
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

  async claimAndStart(task: BuilddTask): Promise<LocalWorker | null> {
    // Warn if no credentials found (but let SDK handle actual auth)
    if (!this.hasCredentials) {
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

    // Create local worker
    const worker: LocalWorker = {
      id: claimedWorker.id,
      taskId: task.id,
      taskTitle: task.title,
      taskDescription: task.description,
      workspaceId: task.workspaceId,
      workspaceName: task.workspace?.name || 'unknown',
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
    };

    this.workers.set(worker.id, worker);
    this.emit({ type: 'worker_update', worker });

    // Subscribe to Pusher for commands
    this.subscribeToWorker(worker.id);

    // Register localUiUrl with server
    if (this.config.localUiUrl) {
      this.buildd.updateWorker(worker.id, {
        localUiUrl: this.config.localUiUrl,
        status: 'running',
      }).catch(err => console.error('Failed to register localUiUrl:', err));
    }

    // Start SDK session (async, runs in background)
    this.startSession(worker, workspacePath, task).catch(err => {
      console.error(`[Worker ${worker.id}] Session error:`, err);
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

  private async startSession(worker: LocalWorker, cwd: string, task: BuilddTask, resumeSessionId?: string) {
    const inputStream = new MessageStream();
    const abortController = new AbortController();

    // Store session state for sendMessage and abort
    this.sessions.set(worker.id, { inputStream, abortController, cwd });

    try {
      // Fetch workspace git config from server
      const workspaceConfig = await this.buildd.getWorkspaceConfig(task.workspaceId);
      const gitConfig = workspaceConfig.gitConfig;
      const isConfigured = workspaceConfig.configStatus === 'admin_confirmed';

      // Build message content with text and images
      const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];

      // Add text description
      content.push({ type: 'text', text: task.description || task.title });

      // Add image attachments if present (from task.context.attachments)
      const ctx = task.context as { attachments?: Array<{ filename: string; mimeType: string; data: string }> } | undefined;
      if (ctx?.attachments && Array.isArray(ctx.attachments)) {
        for (const att of ctx.attachments) {
          if (att.data && att.mimeType) {
            // Extract base64 data from data URL (data:image/png;base64,...)
            const base64Match = att.data.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: base64Match[1],
                  data: base64Match[2],
                },
              });
              this.addMilestone(worker, `Image: ${att.filename}`);
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

      // Determine whether to load CLAUDE.md
      // Default to true if not configured, respect admin setting if configured
      const useClaudeMd = !isConfigured || gitConfig?.useClaudeMd !== false;

      // Resolve permission mode
      const bypassPermissions = this.resolveBypassPermissions(workspaceConfig);
      const permissionMode: 'acceptEdits' | 'bypassPermissions' = bypassPermissions
        ? 'bypassPermissions'
        : 'acceptEdits';

      // Build query options
      const queryOptions: Parameters<typeof query>[0]['options'] = {
        cwd,
        model: this.config.model,
        abortController,
        env: cleanEnv,
        settingSources: useClaudeMd ? ['project'] : [],  // Conditionally load CLAUDE.md
        permissionMode,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
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

      // Attach permission hook (blocks dangerous commands, allows safe bash)
      queryOptions.hooks = {
        PreToolUse: [{ hooks: [this.createPermissionHook(worker)] }],
      };

      // Start query with full options
      const queryInstance = query({
        prompt: promptText,
        options: queryOptions,
      });

      // Connect input stream for multi-turn conversations (AskUserQuestion pauses here until user responds)
      queryInstance.streamInput(inputStream);

      // Stream responses
      for await (const msg of queryInstance) {
        this.handleMessage(worker, msg);

        // Break on result - the query is complete
        if (msg.type === 'result') {
          break;
        }
      }

      // Note: Image attachments temporarily disabled - need to handle via follow-up message
      if (ctx?.attachments && ctx.attachments.length > 0) {
        console.log(`[Worker ${worker.id}] Warning: ${ctx.attachments.length} image attachments not sent (TODO)`);
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
        worker.status = 'error';
        worker.error = 'Agent authentication failed';
        worker.currentAction = 'Auth failed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, { status: 'failed', error: 'Agent authentication failed - check API key' });
        this.emit({ type: 'worker_update', worker });
      } else {
        // Actually completed - collect git stats before reporting
        const gitStats = await this.collectGitStats(worker.id, worker.branch);
        this.addMilestone(worker, 'Task completed');
        worker.status = 'done';
        worker.currentAction = 'Completed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'completed',
          ...gitStats,
        });
        this.emit({ type: 'worker_update', worker });

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

      if (isAbortError) {
        // Clean abort - already handled by abort() method which set worker.error
        console.log(`[Worker ${worker.id}] Session aborted: ${worker.error || 'Unknown reason'}`);
        worker.status = 'error';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error || 'Session aborted'
        }).catch(err => console.error(`[Worker ${worker.id}] Failed to sync abort status:`, err));
      } else {
        // Unexpected error
        console.error(`Worker ${worker.id} error:`, error);
        worker.status = 'error';
        worker.error = error instanceof Error ? error.message : 'Unknown error';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        await this.buildd.updateWorker(worker.id, {
          status: 'failed',
          error: worker.error
        }).catch(err => console.error(`[Worker ${worker.id}] Failed to sync error status:`, err));
      }
      this.emit({ type: 'worker_update', worker });
    } finally {
      // Clean up session
      const session = this.sessions.get(worker.id);
      if (session) {
        session.inputStream.end();
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
      this.addMilestone(worker, 'Session started');
    }

    if (msg.type === 'assistant') {
      // Extract text from assistant message
      const content = (msg as any).message?.content || [];
      for (const block of content) {
        if (block.type === 'text') {
          const text = block.text.trim();
          if (text) {
            // Add to unified timeline
            this.addChatMessage(worker, { type: 'text', content: text, timestamp: Date.now() });
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

        // Detect tool use for milestones and tracking
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
            this.addMilestone(worker, `🛑 ${repetitionCheck.reason}`);
            worker.error = repetitionCheck.reason;
            // Abort the session gracefully
            this.abort(worker.id).catch(err =>
              console.error(`[Worker ${worker.id}] Failed to abort:`, err)
            );
            return;
          }

          if (toolName === 'Read') {
            worker.currentAction = `Reading ${input.file_path}`;
          } else if (toolName === 'Edit') {
            worker.currentAction = `Editing ${input.file_path}`;
            this.addMilestone(worker, `Edit: ${input.file_path}`);
          } else if (toolName === 'Write') {
            worker.currentAction = `Writing ${input.file_path}`;
            this.addMilestone(worker, `Write: ${input.file_path}`);
          } else if (toolName === 'Bash') {
            const cmd = input.command || '';
            worker.currentAction = `Running: ${cmd.slice(0, 40)}...`;

            // Detect git commits
            if (cmd.includes('git commit')) {
              // Handle HEREDOC pattern: git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"
              const heredocMatch = cmd.match(/cat\s*<<\s*['"]?EOF['"]?\n([\s\S]*?)\nEOF/);
              const simpleMatch = cmd.match(/-m\s+["']([^"']+)["']/);
              const message = heredocMatch
                ? heredocMatch[1].split('\n')[0].trim()
                : simpleMatch ? simpleMatch[1] : 'commit';
              worker.commits.push({ sha: 'pending', message });
              if (worker.commits.length > 50) {
                worker.commits.shift();
              }
              this.addMilestone(worker, `Commit: ${message}`);
            }
          } else if (toolName === 'Glob' || toolName === 'Grep') {
            worker.currentAction = `Searching...`;
          } else if (toolName === 'AskUserQuestion') {
            // Agent is asking a question - set waiting status
            const questions = input.questions as Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }> | undefined;
            const firstQuestion = questions?.[0];
            worker.status = 'waiting';
            worker.waitingFor = {
              type: 'question',
              prompt: firstQuestion?.question || 'Awaiting input',
              options: firstQuestion?.options,
            };
            worker.currentAction = firstQuestion?.header || 'Question';
            this.addMilestone(worker, `User: ${firstQuestion?.header || 'Question'}...`);
            // Immediately sync waiting state to server (don't wait for 10s interval)
            this.buildd.updateWorker(worker.id, {
              status: 'waiting_input',
              currentAction: worker.currentAction,
              waitingFor: {
                type: 'question',
                prompt: firstQuestion?.question || 'Awaiting input',
                options: firstQuestion?.options?.map((o: any) => typeof o === 'string' ? o : o.label),
              },
            }).catch(() => {});
          } else if (toolName === 'ExitPlanMode') {
            // Agent finished planning and wants approval before implementing
            worker.status = 'waiting';
            worker.waitingFor = {
              type: 'plan_approval',
              prompt: 'Agent has proposed a plan. Review the plan above, then approve or request changes.',
              options: [
                { label: 'Approve & implement', description: 'Let the agent proceed with the plan' },
                { label: 'Request changes', description: 'Ask the agent to revise its approach' },
              ],
            };
            worker.currentAction = 'Awaiting plan approval';
            this.addMilestone(worker, 'Plan ready for review');
            this.buildd.updateWorker(worker.id, {
              status: 'waiting_input',
              currentAction: worker.currentAction,
              waitingFor: {
                type: 'plan_approval',
                prompt: worker.waitingFor.prompt,
                options: ['Approve & implement', 'Request changes'],
              },
            }).catch(() => {});
          }
        }
      }
    }

    if (msg.type === 'result') {
      const result = msg as any;
      // Don't add "Task completed" here - we check for auth errors after stream ends
      if (result.subtype !== 'success') {
        this.addMilestone(worker, `Error: ${result.subtype}`);
      }
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

  private addMilestone(worker: LocalWorker, label: string) {
    const milestone: Milestone = {
      label,
      completed: true,
      timestamp: Date.now(),
    };
    worker.milestones.push(milestone);
    // Keep last 20 milestones
    if (worker.milestones.length > 20) {
      worker.milestones.shift();
    }
    this.emit({ type: 'milestone', workerId: worker.id, milestone });

    // Sync this worker immediately so web dashboard sees milestones right away
    if (worker.status === 'working' || worker.status === 'stale' || worker.status === 'waiting') {
      this.syncWorkerToServer(worker).catch(() => {});
    }
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
    this.addMilestone(worker, 'Retry requested');
    this.emit({ type: 'worker_update', worker });

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
        .filter(m => !['Session started', 'Task completed', 'Retry requested'].includes(m.label))
        .map(m => `- ${m.label}`);
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

    // If worker is done, errored, or stale but session ended, restart it
    if ((worker.status === 'done' || worker.status === 'error' || worker.status === 'stale') && !session) {
      console.log(`Restarting session for worker ${workerId} with follow-up message`);

      // Update worker status (clear any previous error)
      worker.status = 'working';
      worker.error = undefined;
      worker.currentAction = 'Processing follow-up...';
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      worker.completedAt = undefined;
      this.addChatMessage(worker, { type: 'user', content: message, timestamp: Date.now() });
      this.addMilestone(worker, `User: ${message.slice(0, 30)}...`);
      this.emit({ type: 'worker_update', worker });

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

    try {
      // Enqueue message to the input stream for multi-turn conversation
      session.inputStream.enqueue(buildUserMessage(message));
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
      this.addMilestone(worker, `User: ${message.slice(0, 30)}...`);
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
        .filter(m => !['Session started', 'Task completed'].includes(m.label))
        .map(m => `- ${m.label}`);
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
      .filter(m => m.label !== 'Session started' && m.label !== 'Task completed' && !m.label.startsWith('Reading'))
      .map(m => m.label);
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
    // Unsubscribe from all Pusher channels
    for (const workerId of this.pusherChannels.keys()) {
      this.unsubscribeFromWorker(workerId);
    }
    if (this.pusher) {
      this.pusher.disconnect();
    }
    // Abort all active sessions
    for (const session of this.sessions.values()) {
      session.abortController.abort();
      session.inputStream.end();
    }
    this.sessions.clear();
  }
}
