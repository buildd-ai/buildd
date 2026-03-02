import type { BuilddTask, LocalUIConfig } from './types';
import type { Outbox } from './outbox';
import type { WorkspaceSkill, SyncWorkspaceSkillsInput, SkillInstallResult, WorkerEnvironment, ClaimDiagnostics } from '@buildd/shared';

export class BuilddClient {
  private config: LocalUIConfig;
  private outbox: Outbox | null = null;

  constructor(config: LocalUIConfig) {
    this.config = config;
  }

  /** Attach an outbox for queuing failed mutations when server is unreachable */
  setOutbox(outbox: Outbox) {
    this.outbox = outbox;
  }

  private async fetch(endpoint: string, options: RequestInit = {}, allowedErrors: number[] = []) {
    const method = options.method || 'GET';

    try {
      const res = await fetch(`${this.config.builddServer}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          ...options.headers,
        },
      });

      if (!res.ok && !allowedErrors.includes(res.status)) {
        const error = await res.text();
        throw new Error(`API error: ${res.status} - ${error}`);
      }

      return res.json();
    } catch (err: any) {
      // Network errors (server unreachable) - queue if outbox is attached
      const isNetworkError = err instanceof TypeError ||
        err.message?.includes('fetch failed') ||
        err.message?.includes('ECONNREFUSED') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ENOTFOUND') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('socket connection was closed') ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ECONNRESET';

      if (isNetworkError && this.outbox && this.outbox.shouldQueue(method, endpoint)) {
        this.outbox.enqueue(method, endpoint, options.body as string | undefined);
        return {}; // Return empty response for queued mutations
      }

      throw err;
    }
  }

  async listTasks(): Promise<BuilddTask[]> {
    const data = await this.fetch('/api/tasks');
    return data.tasks || [];
  }

  async claimTask(maxTasks = 1, workspaceId?: string, runner?: string, taskId?: string): Promise<{ workers: any[]; diagnostics?: ClaimDiagnostics }> {
    const data = await this.fetch('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ maxTasks, workspaceId, taskId, runner: runner || 'runner' }),
    });
    return { workers: data.workers || [], diagnostics: data.diagnostics };
  }

  async updateWorker(workerId: string, update: {
    status?: string;
    error?: string;
    localUiUrl?: string;
    currentAction?: string;
    milestones?: any[];
    waitingFor?: { type: string; prompt: string; options?: string[] } | null;
    // Git stats
    lastCommitSha?: string;
    commitCount?: number;
    filesChanged?: number;
    linesAdded?: number;
    linesRemoved?: number;
    // Token usage
    inputTokens?: number;
    outputTokens?: number;
    // SDK result metadata
    resultMeta?: Record<string, unknown>;
    // Completion summary (from SDK Stop hook last_assistant_message)
    summary?: string;
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

  async redeemSecret(ref: string, workerId: string): Promise<string | null> {
    try {
      const data = await this.fetch(`/api/workers/secret/${ref}?workerId=${workerId}`);
      return data.value || null;
    } catch (err) {
      console.warn(`Failed to redeem secret ref: ${err}`);
      return null;
    }
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

  async getWorkspaceConfig(workspaceId: string): Promise<{
    gitConfig?: {
      defaultBranch: string;
      branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
      branchPrefix?: string;
      useBuildBranch?: boolean;
      commitStyle: 'conventional' | 'freeform' | 'custom';
      commitPrefix?: string;
      requiresPR: boolean;
      targetBranch?: string;
      autoCreatePR: boolean;
      agentInstructions?: string;
      useClaudeMd: boolean;
      maxBudgetUsd?: number;
    };
    configStatus: 'unconfigured' | 'admin_confirmed';
  }> {
    try {
      const data = await this.fetch(`/api/workspaces/${workspaceId}/config`);
      return data;
    } catch (err) {
      console.warn('Failed to fetch workspace config:', err);
      return { configStatus: 'unconfigured' };
    }
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

  async submitPlan(workerId: string, plan: string) {
    return this.fetch(`/api/workers/${workerId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
  }

  async createArtifact(workerId: string, data: {
    type: string;
    title: string;
    content?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.fetch(`/api/workers/${workerId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createObservation(workspaceId: string, data: {
    type: string;
    title: string;
    content: string;
    files?: string[];
    concepts?: string[];
    workerId?: string;
    taskId?: string;
  }) {
    return this.fetch(`/api/workspaces/${workspaceId}/memory`, {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        tags: data.concepts,
        source: data.workerId ? `worker:${data.workerId}` : 'local-ui',
      }),
    });
  }

  async getObservations(workspaceId: string, params?: {
    type?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set('type', params.type);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.offset) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    const data = await this.fetch(`/api/workspaces/${workspaceId}/memory${qs ? `?${qs}` : ''}`);
    return data.memories || [];
  }

  async getCompactObservations(workspaceId: string): Promise<{ markdown: string; count: number }> {
    try {
      // Use the memory proxy list with a small limit for compact representation
      const data = await this.fetch(`/api/workspaces/${workspaceId}/memory?limit=50`);
      const memories = data.memories || [];
      if (memories.length === 0) return { markdown: '', count: 0 };

      // Format as markdown grouped by type (matching old /compact behavior)
      const byType: Record<string, typeof memories> = {};
      for (const m of memories) {
        if (!byType[m.type]) byType[m.type] = [];
        byType[m.type].push(m);
      }

      const typeOrder = ['gotcha', 'architecture', 'pattern', 'decision', 'discovery', 'summary'];
      const sections = typeOrder
        .filter(t => byType[t]?.length)
        .map(t => {
          const items = byType[t].map((m: any) => {
            const truncContent = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
            const filesNote = m.files?.length ? ` (files: ${m.files.slice(0, 3).join(', ')})` : '';
            return `- **${m.title}**: ${truncContent}${filesNote}`;
          }).join('\n');
          return `### ${t.charAt(0).toUpperCase() + t.slice(1)}s\n${items}`;
        });

      const markdown = `## Workspace Memory (${data.total || memories.length} memories)\n\n${sections.join('\n\n')}`;
      return { markdown, count: data.total || memories.length };
    } catch {
      return { markdown: '', count: 0 };
    }
  }

  async searchObservations(workspaceId: string, query: string, limit = 5): Promise<Array<{ id: string; title: string; type: string; files?: string[] }>> {
    try {
      const data = await this.fetch(
        `/api/workspaces/${workspaceId}/memory?query=${encodeURIComponent(query)}&limit=${limit}`
      );
      return (data.memories || []).map((m: any) => ({
        id: m.id,
        title: m.title,
        type: m.type,
        files: m.files,
      }));
    } catch {
      return [];
    }
  }

  async getBatchObservations(workspaceId: string, ids: string[]): Promise<Array<{ id: string; title: string; type: string; content: string; files?: string[]; concepts?: string[] }>> {
    if (ids.length === 0) return [];
    try {
      // The memory proxy returns full content, so just re-fetch by query
      // Since we don't have a batch endpoint on the proxy, fetch all and filter
      const data = await this.fetch(`/api/workspaces/${workspaceId}/memory?limit=50`);
      const memories = data.memories || [];
      const idSet = new Set(ids);
      return memories
        .filter((m: any) => idSet.has(m.id))
        .map((m: any) => ({
          id: m.id,
          title: m.title,
          type: m.type,
          content: m.content,
          files: m.files || [],
          concepts: m.tags || [],
        }));
    } catch {
      return [];
    }
  }

  async getMemorySummary(workspaceId: string): Promise<{
    total: number;
    recentGotchas: Array<{ id: string; title: string; content: string }>;
  }> {
    try {
      const data = await this.fetch(`/api/workspaces/${workspaceId}/memory?type=gotcha&limit=3`);
      const memories = data.memories || [];
      const total = data.total || 0;

      if (memories.length === 0) {
        // Get total count from unfiltered query
        const allData = await this.fetch(`/api/workspaces/${workspaceId}/memory?limit=1`);
        return { total: allData.total || 0, recentGotchas: [] };
      }

      const recentGotchas = memories.map((m: any) => ({
        id: m.id,
        title: m.title,
        content: (m.content || '').slice(0, 200),
      }));

      return { total, recentGotchas };
    } catch {
      return { total: 0, recentGotchas: [] };
    }
  }

  async reassignTask(taskId: string, force = false): Promise<{
    reassigned: boolean;
    reason?: string;
    canTakeover?: boolean;
    isStale?: boolean;
    onlineRunners?: number;
    availableCapacity?: number;
    warning?: string;
  }> {
    const url = force ? `/api/tasks/${taskId}/reassign?force=true` : `/api/tasks/${taskId}/reassign`;
    return this.fetch(url, { method: 'POST' }, [403]);
  }

  async sendHeartbeat(localUiUrl: string, activeWorkerCount: number, environment?: WorkerEnvironment): Promise<{ viewerToken?: string; pendingTaskCount?: number; latestCommit?: string }> {
    const data = await this.fetch('/api/workers/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ localUiUrl, activeWorkerCount, environment }),
    });
    return { viewerToken: data.viewerToken, pendingTaskCount: data.pendingTaskCount, latestCommit: data.latestCommit };
  }

  async runCleanup(): Promise<{ cleaned: { stalledWorkers: number; orphanedTasks: number; expiredPlans: number } }> {
    return this.fetch('/api/tasks/cleanup', { method: 'POST' });
  }

  async deleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getAccountLevel(): Promise<'admin' | 'member' | 'unknown'> {
    try {
      const data = await this.fetch('/api/account/level');
      return data.level || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async getAccountInfo(): Promise<{ id: string; name: string } | null> {
    try {
      const data = await this.fetch('/api/accounts/me');
      return { id: data.id, name: data.name };
    } catch {
      return null;
    }
  }

  async syncWorkspaceSkills(workspaceId: string, skills: SyncWorkspaceSkillsInput['skills']): Promise<any> {
    return this.fetch(`/api/workspaces/${workspaceId}/skills/sync`, {
      method: 'POST',
      body: JSON.stringify({ skills }),
    });
  }

  async listWorkspaceSkills(workspaceId: string, enabled?: boolean): Promise<WorkspaceSkill[]> {
    const params = new URLSearchParams();
    if (enabled !== undefined) params.set('enabled', String(enabled));
    const qs = params.toString();
    const data = await this.fetch(`/api/workspaces/${workspaceId}/skills${qs ? `?${qs}` : ''}`);
    return data.skills || [];
  }

  async patchWorkspaceSkill(workspaceId: string, skillId: string, update: {
    name?: string;
    description?: string;
    content?: string;
    source?: string;
    enabled?: boolean;
  }): Promise<WorkspaceSkill> {
    const data = await this.fetch(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    });
    return data.skill;
  }

  async deleteWorkspaceSkill(workspaceId: string, skillId: string): Promise<void> {
    await this.fetch(`/api/workspaces/${workspaceId}/skills/${skillId}`, {
      method: 'DELETE',
    });
  }

  async reportSkillInstallResult(workspaceId: string, result: SkillInstallResult) {
    return this.fetch(`/api/workspaces/${workspaceId}/skills/install/result`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  }

  async matchRepos(repos: Array<{ path: string; remoteUrl: string | null; owner: string | null; repo: string | null; provider: string | null }>): Promise<{
    matched: Array<{ path: string; remoteUrl: string | null; owner: string | null; repo: string | null; workspaceId: string; workspaceName: string }>;
    unmatchedInOrg: Array<{ path: string; remoteUrl: string | null; owner: string | null; repo: string | null; inOrg: boolean }>;
    unmatchedExternal: Array<{ path: string; remoteUrl: string | null; owner: string | null; repo: string | null; inOrg: boolean }>;
  }> {
    return this.fetch('/api/workspaces/match-repos', {
      method: 'POST',
      body: JSON.stringify({ repos }),
    });
  }
}
