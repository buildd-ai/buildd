import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, LocalUIConfig, BuilddTask, WorkerCommand } from './types';
import { BuilddClient } from './buildd';
import { createWorkspaceResolver, type WorkspaceResolver } from './workspace';
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
}

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

  constructor(config: LocalUIConfig, resolver?: WorkspaceResolver) {
    this.config = config;
    this.buildd = new BuilddClient(config);
    this.resolver = resolver || createWorkspaceResolver(config.projectsRoot);

    // Check for stale workers every 30s
    this.staleCheckInterval = setInterval(() => this.checkStale(), 30_000);

    // Sync worker state to server every 10s
    this.syncInterval = setInterval(() => this.syncToServer(), 10_000);

    // Initialize Pusher if configured
    if (config.pusherKey && config.pusherCluster) {
      this.pusher = new Pusher(config.pusherKey, {
        cluster: config.pusherCluster,
      });
      console.log('Pusher connected for command relay');
    }

    // Check if credentials exist (don't validate, SDK handles auth)
    this.hasCredentials = hasClaudeCredentials();
    if (this.hasCredentials) {
      console.log('Claude Code: credentials found');
    } else {
      console.warn('Claude Code: no credentials - run `claude login` or set ANTHROPIC_API_KEY');
    }
  }

  // Check if credentials exist
  getAuthStatus(): { hasCredentials: boolean } {
    return { hasCredentials: this.hasCredentials };
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

  // Sync all worker states to server
  private async syncToServer() {
    for (const worker of this.workers.values()) {
      if (worker.status === 'working' || worker.status === 'stale') {
        try {
          await this.buildd.updateWorker(worker.id, {
            status: worker.status === 'stale' ? 'running' : 'running',
            currentAction: worker.currentAction,
            milestones: worker.milestones.map(m => ({ label: m.label, timestamp: m.timestamp || Date.now() })),
            localUiUrl: this.config.localUiUrl,
          });
        } catch (err) {
          // Silently ignore sync errors
        }
      }
    }
  }

  onEvent(handler: EventHandler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  private emit(event: any) {
    for (const handler of this.eventHandlers) {
      handler(event);
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

    // Claim from buildd
    const claimed = await this.buildd.claimTask(1, task.workspaceId);
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

  private async startSession(worker: LocalWorker, cwd: string, task: BuilddTask) {
    const inputStream = new MessageStream();
    const abortController = new AbortController();

    // Store session state for sendMessage and abort
    this.sessions.set(worker.id, { inputStream, abortController });

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

      // Build prompt with workspace context
      const promptParts: string[] = [];

      // Add admin-defined agent instructions (if configured)
      if (isConfigured && gitConfig?.agentInstructions) {
        promptParts.push(`## Workspace Instructions\n${gitConfig.agentInstructions}`);
      }

      // Add git workflow context (if configured)
      if (isConfigured && gitConfig) {
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

      // Add task description
      promptParts.push(`## Task\n${task.description || task.title}`);

      // Add task metadata
      promptParts.push(`---\nTask ID: ${task.id}\nWorkspace: ${worker.workspaceName}`);

      const promptText = promptParts.join('\n\n');

      // Filter out potentially problematic env vars (expired OAuth tokens)
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          !k.includes('CLAUDE_CODE_OAUTH_TOKEN')  // Can contain expired tokens
        )
      );

      // Determine whether to load CLAUDE.md
      // Default to true if not configured, respect admin setting if configured
      const useClaudeMd = !isConfigured || gitConfig?.useClaudeMd !== false;

      // Start query with full options
      const queryInstance = query({
        prompt: promptText,
        options: {
          cwd,
          model: this.config.model,
          abortController,
          env: cleanEnv,
          settingSources: useClaudeMd ? ['project'] : [],  // Conditionally load CLAUDE.md
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          permissionMode: 'acceptEdits',  // Auto-accept edits for autonomous execution
          stderr: (data: string) => {
            console.log(`[Worker ${worker.id}] stderr: ${data}`);
          },
        },
      });

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
      const outputText = worker.output.join('\n').toLowerCase();
      const isAuthError = outputText.includes('invalid api key') ||
        outputText.includes('please run /login') ||
        outputText.includes('authentication') ||
        outputText.includes('unauthorized');

      if (isAuthError) {
        // Auth error - mark as failed, not completed
        worker.status = 'error';
        worker.error = 'Agent authentication failed';
        worker.currentAction = 'Auth failed';
        worker.hasNewActivity = true;
        await this.buildd.updateWorker(worker.id, { status: 'failed', error: 'Agent authentication failed - check API key' });
        this.emit({ type: 'worker_update', worker });
      } else {
        // Actually completed
        this.addMilestone(worker, 'Task completed');
        worker.status = 'done';
        worker.currentAction = 'Completed';
        worker.hasNewActivity = true;
        await this.buildd.updateWorker(worker.id, { status: 'completed' });
        this.emit({ type: 'worker_update', worker });
      }

    } catch (error) {
      console.error(`Worker ${worker.id} error:`, error);
      worker.status = 'error';
      worker.error = error instanceof Error ? error.message : 'Unknown error';
      worker.hasNewActivity = true;
      await this.buildd.updateWorker(worker.id, {
        status: 'failed',
        error: worker.error
      });
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

    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      worker.sessionId = msg.session_id;
      this.addMilestone(worker, 'Session started');
    }

    if (msg.type === 'assistant') {
      // Extract text from assistant message
      const content = (msg as any).message?.content || [];
      for (const block of content) {
        if (block.type === 'text') {
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

        // Detect tool use for milestones
        if (block.type === 'tool_use') {
          const toolName = block.name;
          const input = block.input || {};

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
              const match = cmd.match(/-m\s+["']([^"']+)["']/);
              const message = match ? match[1] : 'commit';
              worker.commits.push({ sha: 'pending', message });
              this.addMilestone(worker, `Commit: ${message}`);
            }
          } else if (toolName === 'Glob' || toolName === 'Grep') {
            worker.currentAction = `Searching...`;
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
  }

  async abort(workerId: string) {
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
      worker.error = 'Aborted by user';
      worker.currentAction = 'Aborted';
      // This may return 409 if already completed on server - that's ok
      try {
        await this.buildd.updateWorker(workerId, { status: 'failed', error: 'Aborted' });
      } catch {
        // Ignore - worker may already be done on server
      }
      this.emit({ type: 'worker_update', worker });
    }
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
    const session = this.sessions.get(workerId);
    const worker = this.workers.get(workerId);

    if (!session || !worker || worker.status !== 'working') {
      return false;
    }

    try {
      // Enqueue message to the input stream for multi-turn conversation
      session.inputStream.enqueue(buildUserMessage(message));
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.addMilestone(worker, `User: ${message.slice(0, 30)}...`);
      this.emit({ type: 'worker_update', worker });
      return true;
    } catch (err) {
      console.error('Failed to send message:', err);
      return false;
    }
  }

  destroy() {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
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
