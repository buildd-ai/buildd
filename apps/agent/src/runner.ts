import type { Task } from '@buildd/shared';
import { $ } from 'bun';

interface WorkerInfo {
  id: string;
  taskId: string;
  branch: string;
  task: Task;
}

export class WorkerRunner {
  private serverUrl: string;
  private apiKey: string;
  private worker: WorkerInfo;
  private running = false;
  private aborted = false;

  constructor(serverUrl: string, apiKey: string, worker: WorkerInfo) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.worker = worker;
  }

  isRunning(): boolean {
    return this.running;
  }

  stop() {
    this.aborted = true;
    this.running = false;
  }

  async start() {
    this.running = true;

    try {
      const prompt = this.buildPrompt();

      // Auto-detect authentication method
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        console.log(`[${this.worker.id}] Using OAuth (seat-based)`);
        await this.executeViaOAuth(prompt);
      } else if (process.env.ANTHROPIC_API_KEY) {
        console.log(`[${this.worker.id}] Using API (pay-per-token)`);
        await this.executeViaAPI(prompt);
      } else {
        throw new Error('No authentication configured. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
      }

      await this.reportComplete('Task completed successfully');
    } catch (error) {
      if (!this.aborted) {
        console.error(`[${this.worker.id}] Error:`, error);
        await this.reportError(error instanceof Error ? error.message : 'Unknown error');
      }
    } finally {
      this.running = false;
    }
  }

  private buildPrompt(): string {
    let prompt = `# Task: ${this.worker.task.title}\n\n`;

    if (this.worker.task.description) {
      prompt += `${this.worker.task.description}\n\n`;
    }

    prompt += `## Guidelines\n`;
    prompt += `- Create a brief task plan first\n`;
    prompt += `- Make incremental commits\n`;
    prompt += `- Ask for clarification if needed\n`;
    prompt += `- Report progress periodically\n`;

    return prompt;
  }

  private async executeViaOAuth(prompt: string) {
    // Write prompt to temp file
    const tmpFile = `/tmp/buildd-prompt-${this.worker.id}.txt`;
    await Bun.write(tmpFile, prompt);

    try {
      await this.reportProgress(0, 'Starting Claude (OAuth)...');

      // Execute claude CLI with OAuth token
      const proc = Bun.spawn(['claude', '--dangerously-skip-permissions', '-f', tmpFile], {
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN!,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const error = await new Response(proc.stderr).text();
        throw new Error(`Claude execution failed: ${error}`);
      }

      console.log(`[${this.worker.id}] Claude output:\n${output}`);
    } finally {
      // Clean up temp file
      await $`rm -f ${tmpFile}`.quiet();
    }
  }

  private async executeViaAPI(prompt: string) {
    // Import Claude SDK only when needed (for API auth)
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    await this.reportProgress(0, 'Starting Claude (API)...');

    let turnCount = 0;
    let totalCost = 0;

    // Execute via Claude Agent SDK
    for await (const message of query({
      prompt,
      options: {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
        permissionMode: 'acceptEdits',
        maxTurns: 100,
      },
    })) {
      if (this.aborted) {
        break;
      }

      if (message.type === 'assistant') {
        turnCount++;
        const progress = Math.min(95, Math.round((turnCount / 100) * 100));
        await this.reportProgress(progress, `Turn ${turnCount}`);
      }

      if (message.type === 'result') {
        const result = message as any;
        totalCost = result.total_cost_usd || 0;
        console.log(`[${this.worker.id}] Cost: $${totalCost.toFixed(4)}`);
      }
    }
  }

  private async reportProgress(percent: number, message: string) {
    try {
      const response = await fetch(`${this.serverUrl}/api/workers/${this.worker.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          progress: percent,
          status: 'running',
        }),
      });

      if (!response.ok) {
        console.warn(`Failed to report progress: ${response.status}`);
      }

      console.log(`[${this.worker.id}] Progress: ${percent}% - ${message}`);
    } catch (error) {
      console.warn('Failed to report progress:', error);
    }
  }

  private async reportComplete(result: string) {
    try {
      const response = await fetch(`${this.serverUrl}/api/workers/${this.worker.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          status: 'completed',
          result,
        }),
      });

      if (!response.ok) {
        console.warn(`Failed to report completion: ${response.status}`);
      }

      console.log(`[${this.worker.id}] Completed: ${result}`);
    } catch (error) {
      console.warn('Failed to report completion:', error);
    }
  }

  private async reportError(error: string) {
    try {
      const response = await fetch(`${this.serverUrl}/api/workers/${this.worker.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          status: 'error',
          error,
        }),
      });

      if (!response.ok) {
        console.warn(`Failed to report error: ${response.status}`);
      }
    } catch (err) {
      console.warn('Failed to report error:', err);
    }
  }
}
