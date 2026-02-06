import type { ClaimTasksInput, ClaimTasksResponse, Task } from '@buildd/shared';
import { WorkerRunner } from './runner';

interface AgentConfig {
  serverUrl: string;
  apiKey: string;
  workspaceId?: string;
  maxTasks: number;
}

export class BuilddAgent {
  private config: AgentConfig;
  private runners = new Map<string, WorkerRunner>();
  private pollingInterval?: Timer;
  private running = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async run() {
    this.running = true;
    console.log('Agent started. Polling for tasks...');

    // Initial claim
    await this.claimAndStartTasks();

    // Poll every 10 seconds
    this.pollingInterval = setInterval(async () => {
      if (this.running) {
        await this.claimAndStartTasks();
      }
    }, 10_000);
  }

  async stop() {
    this.running = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Stop all runners
    for (const runner of this.runners.values()) {
      runner.stop();
    }

    console.log('Agent stopped');
  }

  private async claimAndStartTasks() {
    try {
      // Count active runners
      const activeCount = Array.from(this.runners.values()).filter((r) => r.isRunning()).length;
      const availableSlots = this.config.maxTasks - activeCount;

      if (availableSlots <= 0) {
        return;
      }

      // Claim tasks
      const input: ClaimTasksInput = {
        workspaceId: this.config.workspaceId,
        maxTasks: availableSlots,
        runner: 'cli',
      };

      const response = await this.claimTasks(input);

      if (response.workers.length === 0) {
        return;
      }

      console.log(`Claimed ${response.workers.length} task(s)`);

      // Start runners for claimed tasks
      for (const worker of response.workers) {
        console.log(`Starting worker ${worker.id} for task: ${worker.task.title}`);

        const runner = new WorkerRunner(this.config.serverUrl, this.config.apiKey, worker);
        this.runners.set(worker.id, runner);

        // Start runner in background
        runner.start().then(() => {
          console.log(`Worker ${worker.id} completed`);
          this.runners.delete(worker.id);
        }).catch((err) => {
          console.error(`Worker ${worker.id} failed:`, err);
          this.runners.delete(worker.id);
        });
      }
    } catch (error) {
      console.error('Failed to claim tasks:', error);
    }
  }

  private async claimTasks(input: ClaimTasksInput): Promise<ClaimTasksResponse> {
    const response = await fetch(`${this.config.serverUrl}/api/workers/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to claim tasks: ${response.status} ${error}`);
    }

    return response.json();
  }
}
