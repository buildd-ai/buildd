import type { BuilddTask, LocalUIConfig } from './types';

export class BuilddClient {
  private config: LocalUIConfig;

  constructor(config: LocalUIConfig) {
    this.config = config;
  }

  private async fetch(endpoint: string, options: RequestInit = {}, allowedErrors: number[] = []) {
    const apiKey = this.config.apiKey?.trim(); // Trim any whitespace
    const url = `${this.config.builddServer}${endpoint}`;
    console.log(`[fetch] ${options.method || 'GET'} ${url}`);
    console.log(`[fetch] Key length: ${apiKey?.length}, starts: ${apiKey?.slice(0, 10)}, ends: ${apiKey?.slice(-10)}`);

    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...options.headers,
      },
    });

    if (!res.ok && !allowedErrors.includes(res.status)) {
      const error = await res.text();
      throw new Error(`API error: ${res.status} - ${error}`);
    }

    return res.json();
  }

  async listTasks(): Promise<BuilddTask[]> {
    const data = await this.fetch('/api/tasks');
    return data.tasks || [];
  }

  async claimTask(maxTasks = 1, workspaceId?: string) {
    const data = await this.fetch('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ maxTasks, workspaceId }),
    });
    return data.workers || [];
  }

  async updateWorker(workerId: string, update: {
    status?: string;
    progress?: number;
    error?: string;
    localUiUrl?: string;
    currentAction?: string;
    milestones?: Array<{ label: string; timestamp: number }>;
  }) {
    // Allow 409 (already completed) - just means worker finished on server
    return this.fetch(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    }, [409]);
  }

  async sendCommand(workerId: string, action: string, text?: string) {
    // Allow 409 (already completed) - can't send commands to finished workers
    return this.fetch(`/api/workers/${workerId}/cmd`, {
      method: 'POST',
      body: JSON.stringify({ action, text }),
    }, [409]);
  }

  async createTask(task: {
    workspaceId: string;
    title: string;
    description: string;
    attachments?: Array<{ data: string; mimeType: string; filename: string }>;
  }) {
    return this.fetch('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    });
  }

  async listWorkspaces() {
    const data = await this.fetch('/api/workspaces');
    return data.workspaces || [];
  }

  async createWorkspace(workspace: {
    name: string;
    repoUrl?: string;
  }) {
    return this.fetch('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(workspace),
    });
  }
}
