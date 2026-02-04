import { query, createSdkMcpServer, tool, type SDKMessage, type SDKUserMessage, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { LocalWorker, Milestone, LocalUIConfig, BuilddTask, WorkerCommand, ChatMessage } from './types';
import { BuilddClient } from './buildd';
import { createWorkspaceResolver, type WorkspaceResolver } from './workspace';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Pusher from 'pusher-js';

// Planning mode system prompt - instructs agent to investigate and propose a plan
const PLANNING_SYSTEM_PROMPT = `
## PLANNING MODE - READ CAREFULLY

This is a PLANNING task. You must NOT implement any changes yet. Instead:

1. **Investigate the codebase** - Use Read, Glob, Grep to understand the relevant code
2. **Analyze the requirements** - Break down what needs to be done
3. **Propose implementation approaches** - Describe 2-3 possible approaches with trade-offs
4. **Recommend the best approach** - Explain your recommendation and why

When you have completed your investigation and are ready to submit your plan, use the
\`mcp__buildd__submit_plan\` tool with your complete plan in markdown format.

Your plan should include:
- **Summary**: Brief overview of the task
- **Key Files**: Files that will need to be modified
- **Approach Options**: 2-3 implementation approaches with pros/cons
- **Recommended Approach**: Your recommendation with justification
- **Implementation Steps**: Ordered list of changes to make
- **Risk Assessment**: Potential issues and how to mitigate them

DO NOT make any file edits, writes, or run any commands that modify files. Only investigate and plan.
After submitting your plan, STOP and wait for the task author to approve before proceeding.
`;

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

// Plan submission callback type
type PlanSubmissionCallback = (workerId: string, plan: string) => Promise<void>;

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
  private planSubmissionCallbacks = new Map<string, PlanSubmissionCallback>();

  constructor(config: LocalUIConfig, resolver?: WorkspaceResolver) {
    this.config = config;
    this.buildd = new BuilddClient(config);
    this.resolver = resolver || createWorkspaceResolver(config.projectsRoot);
    this.acceptRemoteTasks = config.acceptRemoteTasks !== false;

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
            status: 'running',
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

  // Create MCP server for planning mode with plan submission tool
  private createPlanningMcpServer(worker: LocalWorker): McpSdkServerConfigWithInstance {
    return createSdkMcpServer({
      name: 'buildd',
      version: '1.0.0',
      tools: [
        tool(
          'submit_plan',
          'Submit your implementation plan for review. Call this when you have completed investigating the codebase and are ready to propose your implementation approach. The plan will be reviewed by the task author before any implementation begins.',
          { plan: z.string().describe('The complete implementation plan in markdown format') },
          async ({ plan }) => {
            console.log(`[Worker ${worker.id}] Plan submitted (${plan.length} chars)`);

            // Store plan as artifact via buildd API
            try {
              await this.buildd.submitPlan(worker.id, plan);
              this.addMilestone(worker, 'Plan submitted for review');
              worker.currentAction = 'Awaiting plan approval';
              this.emit({ type: 'worker_update', worker });
            } catch (err) {
              console.error(`[Worker ${worker.id}] Failed to submit plan:`, err);
            }

            return {
              content: [{
                type: 'text' as const,
                text: 'Your plan has been submitted for review. Please wait for the task author to approve it before proceeding with implementation. Do not make any changes until you receive approval.',
              }],
            };
          }
        ),
      ],
    });
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

      // Fetch workspace observations for context
      const observationsData = await this.buildd.getCompactObservations(task.workspaceId);

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

      // Add workspace memory (observations from prior tasks)
      if (observationsData.count > 0) {
        promptParts.push(observationsData.markdown);
      }

      // Add task description
      // Clean up description: strip anything after "---" separator which might be polluted context from previous runs
      let taskDescription = task.description || task.title;
      const separatorIndex = taskDescription.indexOf('\n---');
      if (separatorIndex > 0) {
        taskDescription = taskDescription.substring(0, separatorIndex).trim();
      }
      promptParts.push(`## Task\n${taskDescription}`);

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

      // Check if task is in planning mode
      const isPlanningMode = task.mode === 'planning';

      // Build query options
      const queryOptions: Parameters<typeof query>[0]['options'] = {
        cwd,
        model: this.config.model,
        abortController,
        env: cleanEnv,
        settingSources: useClaudeMd ? ['project'] : [],  // Conditionally load CLAUDE.md
        permissionMode: isPlanningMode ? 'plan' : 'acceptEdits',  // Use plan mode or auto-accept edits
        stderr: (data: string) => {
          console.log(`[Worker ${worker.id}] stderr: ${data}`);
        },
      };

      // Configure system prompt based on mode
      if (isPlanningMode) {
        // Planning mode: append planning instructions to system prompt
        queryOptions.systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: PLANNING_SYSTEM_PROMPT,
        };
        // Add MCP server for plan submission
        queryOptions.mcpServers = {
          buildd: this.createPlanningMcpServer(worker),
        };
        // Only allow read-only tools in planning mode
        queryOptions.allowedTools = [
          'Read', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch',
          'mcp__buildd__submit_plan',
        ];
        this.addMilestone(worker, 'Planning mode started');
        worker.currentAction = 'Investigating codebase...';
        this.emit({ type: 'worker_update', worker });
      } else {
        // Execution mode: standard claude_code preset
        queryOptions.systemPrompt = { type: 'preset', preset: 'claude_code' };
      }

      // Start query with full options
      const queryInstance = query({
        prompt: promptText,
        options: queryOptions,
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

        // Capture summary observation (non-fatal)
        try {
          const summary = this.buildSessionSummary(worker);
          const files = this.extractFilesFromToolCalls(worker.toolCalls);
          await this.buildd.createObservation(task.workspaceId, {
            type: 'summary',
            title: `Task: ${task.title}`,
            content: summary,
            files,
            workerId: worker.id,
            taskId: task.id,
          });
        } catch (err) {
          console.error(`[Worker ${worker.id}] Failed to capture summary observation:`, err);
        }
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
              if (worker.commits.length > 50) {
                worker.commits.shift();
              }
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

  private addChatMessage(worker: LocalWorker, msg: ChatMessage) {
    worker.messages.push(msg);
    // Keep last 200 messages
    if (worker.messages.length > 200) {
      worker.messages.shift();
    }
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
    const worker = this.workers.get(workerId);
    if (!worker) {
      return false;
    }

    const session = this.sessions.get(workerId);

    // If worker is done but session ended, restart it
    if (worker.status === 'done' && !session) {
      console.log(`Restarting session for worker ${workerId} with follow-up message`);

      // Update worker status
      worker.status = 'working';
      worker.currentAction = 'Processing follow-up...';
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.addChatMessage(worker, { type: 'user', content: message, timestamp: Date.now() });
      this.addMilestone(worker, `User: ${message.slice(0, 30)}...`);
      this.emit({ type: 'worker_update', worker });

      // Update server
      await this.buildd.updateWorker(worker.id, { status: 'running', currentAction: 'Processing follow-up...' });

      // Get workspace path and task
      const workspacePath = this.resolver.resolve({
        id: worker.workspaceId,
        name: worker.workspaceName,
        repo: undefined,
      });

      if (!workspacePath) {
        console.error(`Cannot resolve workspace for worker: ${worker.id}`);
        return false;
      }

      // Reconstruct task for startSession
      const task = {
        id: worker.taskId,
        title: worker.taskTitle,
        description: message, // Use follow-up message as new description
        workspaceId: worker.workspaceId,
        workspace: {
          name: worker.workspaceName,
        },
        status: 'assigned',
        priority: 1,
      };

      // Start new session with follow-up message
      this.startSession(worker, workspacePath, task as any).catch(err => {
        console.error(`[Worker ${worker.id}] Follow-up session error:`, err);
      });

      return true;
    }

    // Normal case - active session
    if (!session || worker.status !== 'working') {
      return false;
    }

    try {
      // Enqueue message to the input stream for multi-turn conversation
      session.inputStream.enqueue(buildUserMessage(message));
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.addChatMessage(worker, { type: 'user', content: message, timestamp: Date.now() });
      this.addMilestone(worker, `User: ${message.slice(0, 30)}...`);
      this.emit({ type: 'worker_update', worker });
      return true;
    } catch (err) {
      console.error('Failed to send message:', err);
      return false;
    }
  }

  private buildSessionSummary(worker: LocalWorker): string {
    const parts: string[] = [];

    // Milestones summary
    const milestones = worker.milestones
      .filter(m => m.label !== 'Session started' && m.label !== 'Task completed')
      .map(m => m.label);
    if (milestones.length > 0) {
      parts.push(`Milestones: ${milestones.slice(-10).join(', ')}`);
    }

    // Commits summary
    if (worker.commits.length > 0) {
      const commitMsgs = worker.commits.map(c => c.message).slice(-5);
      parts.push(`Commits: ${commitMsgs.join('; ')}`);
    }

    // Tool usage stats
    const toolCounts: Record<string, number> = {};
    for (const tc of worker.toolCalls) {
      toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
    }
    const toolSummary = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');
    if (toolSummary) {
      parts.push(`Tools used: ${toolSummary}`);
    }

    // Last output lines as context
    const lastOutput = worker.output.slice(-3).join(' ').trim();
    if (lastOutput) {
      const truncated = lastOutput.length > 200 ? lastOutput.slice(0, 200) + '...' : lastOutput;
      parts.push(`Result: ${truncated}`);
    }

    const summary = parts.join('\n');
    return summary.length > 500 ? summary.slice(0, 500) + '...' : summary;
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
