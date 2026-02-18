import { query, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { db } from '../db/client';
import { workers, tasks, type ResultMeta } from '../db/schema';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { createBuilddMcpServer } from './buildd-mcp-server';
import { DANGEROUS_PATTERNS, SENSITIVE_PATHS, type SSEEvent, type WorkerStatusType, type WaitingFor } from '@buildd/shared';

export class WorkerRunner extends EventEmitter {
  private workerId: string;
  private abortController: AbortController | null = null;
  private status: WorkerStatusType = 'idle';
  private costUsd = 0;
  private turns = 0;
  private startTime: Date | null = null;
  private toolFailures: Record<string, { count: number; errors: string[]; interrupts: number }> = {};

  constructor(workerId: string) {
    super();
    this.workerId = workerId;
  }

  async start(prompt: string): Promise<void> {
    if (this.status === 'running') throw new Error('Worker already running');

    this.abortController = new AbortController();
    this.startTime = new Date();
    await this.setStatus('starting');

    try {
      const worker = await db.query.workers.findFirst({
        where: eq(workers.id, this.workerId),
        with: { workspace: true, task: true },
      });

      if (!worker) throw new Error('Worker not found');

      await this.setStatus('running');

      const fullPrompt = this.buildPrompt(prompt, worker);

      // Build environment with LLM provider config
      const env: Record<string, string | undefined> = { ...process.env };
      // Enable Agent Teams support
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      if (config.llmProvider === 'openrouter' || config.llmBaseUrl) {
        env.ANTHROPIC_BASE_URL = config.llmBaseUrl || 'https://openrouter.ai/api';
        if (config.llmApiKey) {
          env.ANTHROPIC_AUTH_TOKEN = config.llmApiKey;
          env.ANTHROPIC_API_KEY = '';  // Must be empty for OpenRouter
        }
      }

      // Extract skill slugs from task context for native SDK discovery
      const skillSlugs: string[] = (worker.task as any)?.context?.skillSlugs || [];
      const allowedTools: string[] = [];
      if (skillSlugs.length > 0) {
        for (const slug of skillSlugs) {
          allowedTools.push(`Skill(${slug})`);
        }
      }

      const systemPrompt: any = { type: 'preset', preset: 'claude_code' };
      if (skillSlugs.length > 0) {
        systemPrompt.append = skillSlugs.length === 1
          ? `You MUST use the ${skillSlugs[0]} skill for this task. Invoke it with the Skill tool before starting work.`
          : `Use these skills for this task: ${skillSlugs.join(', ')}. Invoke them with the Skill tool as needed.`;
      }

      // Build plugins and sandbox config from workspace config
      const gitConfig = (worker.workspace as any)?.gitConfig;
      const pluginPaths: string[] = gitConfig?.pluginPaths || [];
      const plugins = pluginPaths.map((p: string) => ({ type: 'local' as const, path: p }));
      const sandboxConfig = gitConfig?.sandbox?.enabled ? gitConfig.sandbox : undefined;

      // Extract outputSchema from task for structured output support
      const outputSchema = (worker.task as any)?.outputSchema as Record<string, unknown> | null | undefined;

      // Create in-process MCP server for Buildd coordination tools
      const builddMcpServer = config.builddApiKey
        ? createBuilddMcpServer({
            serverUrl: config.builddServerUrl,
            apiKey: config.builddApiKey,
            workerId: this.workerId,
            workspaceId: worker.workspace?.id,
          })
        : null;

      if (builddMcpServer) {
        allowedTools.push('mcp__buildd__buildd', 'mcp__buildd__buildd_memory');
      }

      for await (const message of query({
        prompt: fullPrompt,
        options: {
          sessionId: this.workerId,
          cwd: worker.workspace?.localPath || process.cwd(),
          model: config.anthropicModel,
          abortController: this.abortController,
          permissionMode: 'acceptEdits',
          maxTurns: config.maxTurns,
          enableFileCheckpointing: true,
          maxBudgetUsd: config.maxCostPerWorker || undefined,
          env,
          settingSources: ['user', 'project'],
          systemPrompt,
          ...(allowedTools.length > 0 ? { allowedTools } : {}),
          ...(plugins.length > 0 ? { plugins } : {}),
          ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
          // Structured output: pass outputFormat if task defines an outputSchema
          ...(outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: outputSchema } } : {}),
          ...(builddMcpServer ? { mcpServers: { buildd: builddMcpServer } } : {}),
          hooks: {
            PreToolUse: [{ hooks: [this.preToolUseHook.bind(this)] }],
            PostToolUse: [{ hooks: [this.postToolUseHook.bind(this)] }],
            Notification: [{ hooks: [this.notificationHook.bind(this)] }],
            // PostToolUseFailure/TeammateIdle/TaskCompleted: SDK v0.2.33+ hooks
            // Cast needed: packages/core pins SDK v0.1.x which lacks these HookEvent keys,
            // but the underlying CLI runtime supports them when AGENT_TEAMS is enabled.
            ...({ PostToolUseFailure: [{ hooks: [this.postToolUseFailureHook.bind(this)] }] } as any),
            ...({ TeammateIdle: [{ hooks: [this.teammateIdleHook.bind(this)] }] } as any),
            ...({ TaskCompleted: [{ hooks: [this.taskCompletedHook.bind(this)] }] } as any),
            ...({ SubagentStart: [{ hooks: [this.subagentStartHook.bind(this)] }] } as any),
            ...({ SubagentStop: [{ hooks: [this.subagentStopHook.bind(this)] }] } as any),
          },
        },
      })) {
        await this.handleMessage(message);
        
        if (this.costUsd >= config.maxCostPerWorker) {
          this.cancel();
          await this.setStatus('error');
          await this.setError(`Cost limit exceeded: $${this.costUsd.toFixed(2)}`);
          break;
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        await this.setStatus('paused');
      } else {
        await this.setStatus('error');
        await this.setError((error as Error).message);
      }
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async handleMessage(msg: SDKMessage): Promise<void> {
    if (msg.type === 'system' && 'session_id' in msg) {
      // Session ID tracked in-memory only, no longer persisted to DB
      return;
    }

    // Emit file checkpoint events from SDK
    if (msg.type === 'system' && (msg as any).subtype === 'files_persisted') {
      const event = msg as any;
      this.emitEvent('worker:checkpoint', {
        uuid: event.uuid,
        files: event.files || [],
        failed: event.failed || [],
      });
      return;
    }

    // SDK v0.2.45: Subagent task started — emitted when a subagent task is registered
    if (msg.type === 'system' && (msg as any).subtype === 'task_started') {
      const event = msg as any;
      this.emitEvent('worker:task_started', {
        taskId: event.task_id,
        toolUseId: event.tool_use_id,
        description: event.description,
        taskType: event.task_type,
      });
      return;
    }

    // SDK v0.2.45: Subagent task notification — emitted on task completion/status updates
    if (msg.type === 'system' && (msg as any).subtype === 'task_notification') {
      const event = msg as any;
      this.emitEvent('worker:task_notification', {
        taskId: event.task_id,
        status: event.status,
        message: event.message,
      });
      return;
    }

    if (msg.type === 'assistant') {
      const assistantMsg = msg as any;
      if (assistantMsg.message?.content) {
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            await this.storeMessage('assistant', block.text);
          }
          if (block.type === 'tool_use') {
            await this.storeMessage('tool', null, block.name, block.input);
            if (block.name === 'AskUserQuestion') {
              await this.setStatus('waiting_input');
              await this.setWaitingFor({
                type: 'question',
                prompt: block.input.question || block.input.message || 'Awaiting input',
              });
            }
          }
        }
      }
      this.turns++;
      await this.updateProgress();
      return;
    }

    if (msg.type === 'result') {
      const resultMsg = msg as any;
      this.costUsd = resultMsg.total_cost_usd || 0;
      const isBudgetExceeded = resultMsg.subtype === 'error_max_budget_usd';

      // Extract SDK result metadata
      const resultMeta: ResultMeta = {
        stopReason: resultMsg.stop_reason ?? null,
        durationMs: resultMsg.duration_ms ?? 0,
        durationApiMs: resultMsg.duration_api_ms ?? 0,
        numTurns: resultMsg.num_turns ?? this.turns,
        modelUsage: resultMsg.usage?.byModel ?? {},
        ...(resultMsg.permission_denials?.length > 0 && {
          permissionDenials: resultMsg.permission_denials.map((d: any) => ({
            tool: d.tool_name || d.tool || 'unknown',
            reason: d.reason || d.message || '',
          })),
        }),
      };

      // Use SDK's turn count if available (more accurate than manual counter)
      const turns = resultMeta.numTurns || this.turns;

      // Populate inputTokens/outputTokens from modelUsage aggregate
      let totalInput = 0;
      let totalOutput = 0;
      for (const usage of Object.values(resultMeta.modelUsage)) {
        totalInput += usage.inputTokens + usage.cacheReadInputTokens;
        totalOutput += usage.outputTokens;
      }

      await db.update(workers).set({
        status: resultMsg.is_error ? 'error' : 'completed',
        costUsd: this.costUsd.toString(),
        turns,
        completedAt: new Date(),
        error: isBudgetExceeded
          ? `Budget limit exceeded: $${this.costUsd.toFixed(2)} (max $${config.maxCostPerWorker})`
          : resultMsg.is_error ? (resultMsg.result || 'Unknown error') : null,
        resultMeta,
        ...(totalInput > 0 && { inputTokens: totalInput }),
        ...(totalOutput > 0 && { outputTokens: totalOutput }),
      }).where(eq(workers.id, this.workerId));

      const worker = await db.query.workers.findFirst({
        where: eq(workers.id, this.workerId),
        with: { account: true }
      });

      if (worker?.taskId) {
        const taskUpdate: Record<string, unknown> = {
          status: resultMsg.is_error ? 'failed' : 'completed',
          updatedAt: new Date(),
        };

        // Snapshot deliverables on completion
        if (!resultMsg.is_error) {
          taskUpdate.result = {
            branch: worker.branch,
            commits: worker.commitCount ?? 0,
            sha: worker.lastCommitSha ?? undefined,
            files: worker.filesChanged ?? 0,
            added: worker.linesAdded ?? 0,
            removed: worker.linesRemoved ?? 0,
            prUrl: worker.prUrl ?? undefined,
            prNumber: worker.prNumber ?? undefined,
            // Include structured output from SDK if present
            ...(resultMsg.structured_output && typeof resultMsg.structured_output === 'object'
              ? { structuredOutput: resultMsg.structured_output }
              : {}),
          };
        }

        await db.update(tasks).set(taskUpdate).where(eq(tasks.id, worker.taskId));
      }

      // Update account stats based on auth type
      if (worker?.account) {
        const { accounts } = await import('../db/schema');
        const { sql } = await import('drizzle-orm');

        if (worker.account.authType === 'api') {
          // For API accounts: track costs
          await db.update(accounts)
            .set({
              totalCost: sql`${accounts.totalCost} + ${this.costUsd}`,
              totalTasks: sql`${accounts.totalTasks} + 1`
            })
            .where(eq(accounts.id, worker.account.id));
        } else if (worker.account.authType === 'oauth') {
          // For OAuth accounts: decrement active sessions, no cost tracking
          await db.update(accounts)
            .set({
              activeSessions: sql`GREATEST(0, ${accounts.activeSessions} - 1)`,
              totalTasks: sql`${accounts.totalTasks} + 1`
            })
            .where(eq(accounts.id, worker.account.id));
        }
      }

      const totalToolFailures = Object.values(this.toolFailures).reduce((sum, s) => sum + s.count, 0);
      this.emitEvent('worker:completed', {
        result: resultMsg.result,
        costUsd: this.costUsd,
        turns,
        durationMs: resultMeta.durationMs || (Date.now() - (this.startTime?.getTime() || 0)),
        resultMeta,
        ...(totalToolFailures > 0 ? { toolFailures: this.toolFailures } : {}),
      });
    }
  }

  private preToolUseHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'PreToolUse') return {};
    
    const toolName = (input as any).tool_name;
    const toolInput = (input as any).tool_input as Record<string, unknown>;

    if (toolName === 'Bash') {
      const command = (toolInput.command as string) || '';
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          this.emitEvent('worker:message', { type: 'blocked', tool: toolName, reason: `Blocked: ${pattern.source}` });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Dangerous command blocked`,
            },
          };
        }
      }
    }

    if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      const filePath = (toolInput.file_path as string) || (toolInput.filePath as string) || '';
      for (const pattern of SENSITIVE_PATHS) {
        if (pattern.test(filePath)) {
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

    return {};
  };

  private postToolUseHook: HookCallback = async () => {
    this.emitEvent('worker:cost', { costUsd: this.costUsd });
    return {};
  };

  private postToolUseFailureHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'PostToolUseFailure') return {};

    const toolName = (input as any).tool_name as string;
    const error = (input as any).error as string;
    const isInterrupt = (input as any).is_interrupt as boolean | undefined;

    // Aggregate failure stats per tool
    if (!this.toolFailures[toolName]) {
      this.toolFailures[toolName] = { count: 0, errors: [], interrupts: 0 };
    }
    const stats = this.toolFailures[toolName];
    stats.count++;
    if (isInterrupt) stats.interrupts++;
    // Keep last 5 unique errors per tool to avoid unbounded growth
    if (!stats.errors.includes(error)) {
      if (stats.errors.length >= 5) stats.errors.shift();
      stats.errors.push(error);
    }

    this.emitEvent('worker:tool_failure', {
      toolName,
      error,
      isInterrupt: isInterrupt ?? false,
    });
    return {};
  };

  // TeammateIdle hook — fires when a teammate in an agent team goes idle.
  // Purely observational: emits an event for Pusher/dashboard visibility.
  private teammateIdleHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'TeammateIdle') return {};

    const teammateName = (input as any).teammate_name as string;
    const teamName = (input as any).team_name as string;
    this.emitEvent('worker:teammate_idle', { teammateName, teamName });
    return {};
  };

  // TaskCompleted hook — fires when a task within an agent team completes.
  // Emits event for dashboard and logs the completion.
  private taskCompletedHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'TaskCompleted') return {};

    const taskId = (input as any).task_id as string;
    const taskSubject = (input as any).task_subject as string;
    const teammateName = (input as any).teammate_name as string | undefined;
    const teamName = (input as any).team_name as string | undefined;
    this.emitEvent('worker:task_completed', { taskId, taskSubject, teammateName, teamName });
    return {};
  };

  // SubagentStart hook — fires when a subagent is spawned.
  // Emits event for dashboard visibility.
  private subagentStartHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'SubagentStart') return {};

    const agentId = (input as any).agent_id as string;
    const agentType = (input as any).agent_type as string;
    this.emitEvent('worker:subagent_start', { agentId, agentType });
    return {};
  };

  // SubagentStop hook — fires when a subagent completes.
  // Emits event for dashboard visibility.
  private subagentStopHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'SubagentStop') return {};

    const stopHookActive = (input as any).stop_hook_active as boolean;
    this.emitEvent('worker:subagent_stop', { stopHookActive });
    return {};
  };

  // Notification hook — fires when the agent emits status messages.
  // Captures agent notifications and emits them for dashboard visibility.
  private notificationHook: HookCallback = async (input) => {
    if ((input as any).hook_event_name !== 'Notification') return {};

    const message = (input as any).message as string;
    const title = (input as any).title as string | undefined;
    this.emitEvent('worker:notification', { message, title });
    return {};
  };

  private buildPrompt(userPrompt: string, worker: any): string {
    const parts: string[] = [];
    if (worker.task) {
      parts.push(`# Task: ${worker.task.title}\n`);
      if (worker.task.description) parts.push(`${worker.task.description}\n`);
    }
    parts.push(`\n## Instructions\n${userPrompt}`);
    parts.push(`\n## Guidelines\n- Create a brief task plan first\n- Make incremental commits\n- Ask for clarification if needed`);
    return parts.join('\n');
  }

  private async setStatus(status: WorkerStatusType): Promise<void> {
    const prev = this.status;
    this.status = status;
    await db.update(workers).set({ status, updatedAt: new Date() }).where(eq(workers.id, this.workerId));
    this.emitEvent('worker:status', { status, previousStatus: prev });
  }

  private async setWaitingFor(waitingFor: WaitingFor | null): Promise<void> {
    await db.update(workers).set({ waitingFor }).where(eq(workers.id, this.workerId));
    if (waitingFor) this.emitEvent('worker:waiting', { waitingFor });
  }

  private async setError(error: string): Promise<void> {
    await db.update(workers).set({ error }).where(eq(workers.id, this.workerId));
    this.emitEvent('worker:error', { error, recoverable: false });
  }

  private async updateProgress(): Promise<void> {
    await db.update(workers).set({ turns: this.turns, costUsd: this.costUsd.toString() }).where(eq(workers.id, this.workerId));
    this.emitEvent('worker:progress', { turns: this.turns });
  }

  private async storeMessage(role: string, content: string | null, toolName?: string, toolInput?: Record<string, unknown>): Promise<void> {
    // Messages are no longer persisted to DB - they live in local-UI memory only
    this.emitEvent('worker:message', { role, content, toolName });
  }

  private emitEvent(type: string, data: unknown): void {
    this.emit('event', { type, workerId: this.workerId, data, timestamp: new Date() });
  }
}

// Singleton manager
class WorkerManager {
  private runners = new Map<string, WorkerRunner>();
  private eventEmitter = new EventEmitter();

  async startWorker(workerId: string, prompt: string): Promise<void> {
    let runner = this.runners.get(workerId);
    if (!runner) {
      runner = new WorkerRunner(workerId);
      runner.on('event', (e) => this.eventEmitter.emit('event', e));
      this.runners.set(workerId, runner);
    }
    await runner.start(prompt);
  }

  cancelWorker(workerId: string): void {
    this.runners.get(workerId)?.cancel();
  }

  onEvent(cb: (event: SSEEvent) => void): void {
    this.eventEmitter.on('event', cb);
  }

  offEvent(cb: (event: SSEEvent) => void): void {
    this.eventEmitter.off('event', cb);
  }
}

export const workerManager = new WorkerManager();
