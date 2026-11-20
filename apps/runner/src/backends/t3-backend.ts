import { realpath } from 'node:fs/promises';
import type { AgentBackend, BackendEvent, RunStreamedOpts } from './types';

export interface T3Command {
  args: string[];
  cwd: string;
  stdin?: string;
}

export interface T3BackendConfig {
  /** An existing, dedicated thread bound to a worktree. Never share it with another runner. */
  threadId: string;
  /** Executable and fixed prefix arguments; prompts always travel over stdin. */
  command?: string[];
  execute?: (command: T3Command) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid T3 JSON response');
  return value as Record<string, unknown>;
}

/** Experimental CLI bridge, intentionally absent from the production backend factory. */
export class T3Backend implements AgentBackend {
  private busy = false;
  private readonly execute: NonNullable<T3BackendConfig['execute']>;

  constructor(private readonly config: T3BackendConfig) {
    if (!config.threadId.trim() || config.threadId.startsWith('-')) throw new Error('A T3 thread id is required');
    this.execute = config.execute ?? (async ({ args, cwd, stdin }) => {
      const child = Bun.spawn([...(config.command ?? ['t3']), ...args], {
        cwd,
        stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { stdout, stderr, exitCode };
    });
  }

  async *runStreamed(opts: RunStreamedOpts): AsyncIterable<BackendEvent> {
    if (this.busy) {
      yield { type: 'error', error: 'This T3 backend already has an active run' };
      return;
    }
    this.busy = true;
    try {
      if (!opts.allowReducedConfinement) throw new Error('T3 prototype requires explicit trusted-local reduced confinement');
      if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) throw new Error('T3 prototype accepts a non-empty text prompt only; streaming steering is unsupported');
      for (const key of ['sandboxMode', 'maxBudgetUsd', 'maxTurns', 'outputSchema', 'env', 'signal'] as const) {
        if (opts[key] !== undefined) throw new Error(`T3 CLI cannot enforce ${key}; use a native backend`);
      }
      if (opts.resumeThreadId !== undefined && opts.resumeThreadId !== this.config.threadId) throw new Error('T3 resume thread does not match the configured thread');
      const inspected = await this.execute({ args: ['thread', 'show', this.config.threadId, '--json'], cwd: opts.cwd });
      if (inspected.exitCode !== 0) throw new Error(`T3 inspection failed: ${inspected.stderr.trim()}`);
      const thread = record(record(JSON.parse(inspected.stdout)).thread);
      if (thread.threadId !== this.config.threadId) throw new Error('T3 returned a different thread');
      if (typeof thread.worktreePath !== 'string' || await realpath(thread.worktreePath) !== await realpath(opts.cwd)) {
        throw new Error('T3 thread must be bound to the exact requested worktree; project-root threads are unsupported');
      }
      if (thread.activeRunId !== null || !['idle', 'completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'].includes(String(thread.status)) || thread.pendingRequestCount !== 0) {
        throw new Error('T3 thread is busy or waiting for input');
      }
      if (!Array.isArray(thread.pendingBackgroundTasks) || thread.pendingBackgroundTasks.length > 0 || thread.blockedOnThreadWait === true) {
        throw new Error('T3 thread must report no background work or pending thread waits');
      }
      if (opts.model !== undefined && thread.model !== opts.model) throw new Error('T3 thread model differs from the requested model');
      yield { type: 'progress', message: `Running in T3 thread ${this.config.threadId}; follow and answer approvals in T3. Token usage is unavailable through this CLI.` };
      const sent = await this.execute({ args: ['thread', 'send', this.config.threadId, '-', '--wait', '--json'], cwd: opts.cwd, stdin: opts.prompt });
      const result = record(JSON.parse(sent.stdout));
      if (result.threadId !== this.config.threadId || typeof result.runId !== 'string' || !result.runId) throw new Error('T3 returned an invalid run identity');
      if (sent.exitCode !== 0 || result.status !== 'completed') {
        const detail = result.status === 'waiting'
          ? 'Waiting for an answer in T3; the remote run remains active. Answer there before resuming.'
          : typeof result.error === 'string' ? result.error : sent.stderr.trim();
        throw new Error(`T3 run ${result.runId}: ${String(result.status)}. ${detail}`);
      }
      if (typeof result.reply !== 'string') throw new Error('T3 completed without a text reply');
      yield { type: 'turn_complete' };
      yield { type: 'complete', summary: result.reply };
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.busy = false;
    }
  }
}
