import { query, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { db } from '../db/client';
import { workers, tasks } from '../db/schema';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { DANGEROUS_PATTERNS, SENSITIVE_PATHS, type SSEEvent, type WorkerStatusType, type WaitingFor } from '@buildd/shared';

export class WorkerRunner extends EventEmitter {
  private workerId: string;
  private abortController: AbortController | null = null;
  private status: WorkerStatusType = 'idle';
  private costUsd = 0;
  private turns = 0;
  private startTime: Date | null = null;

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

      for await (const message of query({
        prompt: fullPrompt,
        options: {
          cwd: worker.workspace?.localPath || process.cwd(),
          model: config.anthropicModel,
          permissionMode: 'acceptEdits',
          maxTurns: config.maxTurns,
          env,
          settingSources: ['user', 'project'],
          systemPrompt,
          ...(allowedTools.length > 0 ? { allowedTools } : {}),
          hooks: {
            PreToolUse: [{ hooks: [this.preToolUseHook.bind(this)] }],
            PostToolUse: [{ hooks: [this.postToolUseHook.bind(this)] }],
            // TeammateIdle/TaskCompleted: agent team lifecycle hooks (SDK v0.2.33+)
            // Cast needed: packages/core pins SDK v0.1.x which lacks these HookEvent keys,
            // but the underlying CLI runtime supports them when AGENT_TEAMS is enabled.
            ...({ TeammateIdle: [{ hooks: [this.teammateIdleHook.bind(this)] }] } as any),
            ...({ TaskCompleted: [{ hooks: [this.taskCompletedHook.bind(this)] }] } as any),
          },
        },
        signal: this.abortController.signal,
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

      await db.update(workers).set({
        status: resultMsg.is_error ? 'error' : 'completed',
        costUsd: this.costUsd.toString(),
        turns: this.turns,
        completedAt: new Date(),
        error: resultMsg.is_error ? (resultMsg.result || 'Unknown error') : null,
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

      this.emitEvent('worker:completed', {
        result: resultMsg.result,
        costUsd: this.costUsd,
        turns: this.turns,
        durationMs: Date.now() - (this.startTime?.getTime() || 0),
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
