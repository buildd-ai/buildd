/**
 * Shared MCP tool handlers for Buildd.
 *
 * Used by:
 * - packages/core/buildd-mcp-server.ts (in-process SDK server)
 * - apps/mcp-server/src/index.ts (stdio server)
 * - apps/web/src/app/api/mcp/route.ts (HTTP server)
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ApiFn = (endpoint: string, options?: RequestInit) => Promise<any>;

export interface ActionContext {
  workerId?: string;
  workspaceId?: string;
  getWorkspaceId: () => Promise<string | null>;
  getLevel: () => Promise<'worker' | 'admin'>;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ── Action Lists ─────────────────────────────────────────────────────────────

export const workerActions = [
  'list_tasks', 'claim_task', 'update_progress', 'complete_task',
  'create_pr', 'update_task', 'create_task', 'create_artifact',
  'list_artifacts', 'update_artifact',
  'emit_event', 'query_events',
] as const;

export const adminActions = [
  'create_schedule', 'update_schedule', 'list_schedules', 'register_skill',
] as const;

export const allActions = [...workerActions, ...adminActions] as const;

export const memoryActions = ['context', 'search', 'save', 'get', 'update', 'delete'] as const;

export type BuilddAction = (typeof allActions)[number];
export type MemoryAction = (typeof memoryActions)[number];

// ── Description Builders ─────────────────────────────────────────────────────

export function buildToolDescription(actions: readonly string[]): string {
  return `Task coordination tool. Available actions: ${actions.join(', ')}. Use action parameter to select operation, params for action-specific arguments.`;
}

export function buildParamsDescription(actions: readonly string[]): string {
  const descriptions: Record<string, string> = {
    list_tasks: '{ offset? }',
    claim_task: '{ maxTasks?, workspaceId? } — auto-assigns highest-priority pending task',
    update_progress: '{ workerId (required), progress (required), message?, plan?, inputTokens?, outputTokens?, lastCommitSha?, commitCount?, filesChanged?, linesAdded?, linesRemoved? }',
    complete_task: '{ workerId (required), summary?, error?, structuredOutput? } — if error present, marks task as failed',
    create_pr: '{ workerId (required), title (required), head (required), body?, base?, draft? }',
    update_task: '{ taskId (required), title?, description?, priority?, project? }',
    create_task: '{ title (required), description (required), workspaceId?, priority?, category? (bug|feature|refactor|chore|docs|test|infra|design — auto-detected if omitted), outputRequirement? (pr_required|artifact_required|none|auto — default auto), outputSchema?, project? (monorepo project name for scoping) }',
    create_artifact: '{ workerId (required), type (required: content|report|data|link|summary), title (required), content?, url?, metadata?, key? }',
    list_artifacts: '{ workspaceId?, key?, type?, limit? }',
    update_artifact: '{ artifactId (required), title?, content?, metadata? }',
    create_schedule: '{ name (required), cronExpression (required), title (required), description?, timezone?, priority?, mode?, skillSlugs?, trigger?, workspaceId? } [admin]',
    update_schedule: '{ scheduleId (required), cronExpression?, timezone?, enabled?, name?, taskTemplate?, skillSlugs?, workspaceId? } [admin]',
    list_schedules: '{ workspaceId? } [admin]',
    register_skill: '{ name?, content?, filePath?, repo?, description?, source?, workspaceId? } [admin]',
    emit_event: '{ workerId (required), type (required), label (required), metadata? }',
    query_events: '{ workerId (required), type? }',
    detect_projects: '{ rootDir? } — detect monorepo projects from package.json workspaces field',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters. By action:\n${lines.join('\n')}`;
}

export function buildMemoryDescription(actions: readonly string[]): string {
  const descriptions: Record<string, string> = {
    context: '{ project? } — get markdown-formatted memory context for agent injection',
    search: '{ query?, type?, files? (array), project?, limit?, offset? }',
    save: '{ type (required: gotcha|pattern|decision|discovery|architecture), title (required), content (required), files? (array), tags? (array), project?, source? }',
    get: '{ id (required) }',
    update: '{ id (required), title?, content?, type?, files? (array), tags?, project? }',
    delete: '{ id (required) }',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters:\n${lines.join('\n')}`;
}

// ── Buildd Action Handler ────────────────────────────────────────────────────

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });
const errorResult = (t: string): ToolResult => ({
  content: [{ type: 'text' as const, text: t }],
  isError: true,
});

export async function handleBuilddAction(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ToolResult> {
  switch (action) {
    case 'list_tasks': {
      const data = await api('/api/tasks');
      const allTasks = data.tasks || [];
      const wsId = ctx.workspaceId || await ctx.getWorkspaceId();
      let pending = allTasks.filter((t: any) => t.status === 'pending');
      if (wsId) {
        pending = pending.filter((t: any) => t.workspaceId === wsId);
      }
      pending.sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));

      const limit = 5;
      const offset = Math.max((params.offset as number) || 0, 0);
      const paginated = pending.slice(offset, offset + limit);
      const hasMore = offset + limit < pending.length;

      if (paginated.length === 0) return text('No pending tasks to claim.');

      const summary = paginated.map((t: any) => {
        const catPrefix = t.category ? `[${t.category}] ` : '';
        return `- ${catPrefix}${t.title} (id: ${t.id})\n  ${t.description?.slice(0, 100) || 'No description'}...`;
      }).join('\n\n');

      const header = `${pending.length} pending task${pending.length === 1 ? '' : 's'}:`;
      const moreHint = hasMore ? `\n\nCall with offset=${offset + limit} to see more.` : '';
      const claimHint = `\n\nTo claim a task, call action=claim_task (it auto-assigns the highest-priority task — you don't pick by ID).`;
      return text(`${header}\n\n${summary}${moreHint}${claimHint}`);
    }

    case 'claim_task': {
      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      const data = await api('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ maxTasks: params.maxTasks || 1, workspaceId: wsId, runner: 'mcp' }),
      });

      const workers = data.workers || [];
      if (workers.length === 0) return text('No tasks available to claim. All tasks may be assigned or completed.');

      const claimed = workers.map((w: any) =>
        `**Worker ID:** ${w.id}\n**Task:** ${w.task.title}\n**Branch:** ${w.branch}\n**Description:** ${w.task.description || 'No description'}`
      ).join('\n\n---\n\n');

      // Proactively fetch relevant memory from memory service
      let memorySection = '';
      try {
        const { getMemoryClient } = await import('./memory-client');
        const memClient = getMemoryClient();
        if (memClient && workers[0]?.task?.title) {
          const searchData = await memClient.search({
            query: workers[0].task.title,
            limit: 5,
          });
          const results = searchData.results || [];
          if (results.length > 0) {
            const batchData = await memClient.batch(results.map(r => r.id));
            const memories = batchData.memories || [];
            if (memories.length > 0) {
              const memoryLines = memories.map((m: any) => {
                const truncContent = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
                return `- **[${m.type}] ${m.title}**: ${truncContent}`;
              });
              memorySection = `\n\n## Relevant Memory\nREAD these memories before starting work:\n${memoryLines.join('\n')}\n\nUse \`buildd_memory\` action=search for more context.`;
            }
          }
        }
      } catch {
        // Memory fetch is non-fatal
      }

      // Open PRs section: inform agent about concurrent work
      let openPRsSection = '';
      const firstWorkerPRs = workers[0]?.openPRs;
      if (firstWorkerPRs && firstWorkerPRs.length > 0) {
        const prLines = firstWorkerPRs.map((pr: any) =>
          `- PR #${pr.prNumber} (branch: ${pr.branch}): "${pr.taskTitle || 'Unknown task'}" — ${pr.prUrl}`
        );
        openPRsSection = `\n\n## Open PRs in this workspace\nThese PRs are from other agents working in the same repo. Avoid modifying the same files if possible, or rebase on top of their branches.\n${prLines.join('\n')}`;
      }

      return text(`Claimed ${workers.length} task(s):\n\n${claimed}${openPRsSection}${memorySection}\n\nUse the worker ID to report progress and completion.`);
    }

    case 'update_progress': {
      if (!params.workerId) throw new Error('workerId is required');

      // Plan submission
      if (params.plan) {
        await api(`/api/workers/${params.workerId}/plan`, {
          method: 'POST',
          body: JSON.stringify({ plan: params.plan }),
        });
        return text('Your plan has been submitted for review. Please wait for the task author to approve it before proceeding with implementation. Do not make any changes until you receive approval.');
      }

      let response;
      try {
        const statusMilestone = params.message ? {
          appendMilestones: [{
            type: 'status',
            label: params.message,
            progress: params.progress || 0,
            ts: Date.now(),
          }],
        } : {};

        const progressBody: Record<string, unknown> = {
          status: 'running',
          progress: params.progress || 0,
          ...statusMilestone,
        };
        if (params.message) progressBody.currentAction = params.message;
        if (typeof params.inputTokens === 'number') progressBody.inputTokens = params.inputTokens;
        if (typeof params.outputTokens === 'number') progressBody.outputTokens = params.outputTokens;
        if (params.lastCommitSha) progressBody.lastCommitSha = params.lastCommitSha;
        if (typeof params.commitCount === 'number') progressBody.commitCount = params.commitCount;
        if (typeof params.filesChanged === 'number') progressBody.filesChanged = params.filesChanged;
        if (typeof params.linesAdded === 'number') progressBody.linesAdded = params.linesAdded;
        if (typeof params.linesRemoved === 'number') progressBody.linesRemoved = params.linesRemoved;

        response = await api(`/api/workers/${params.workerId}`, {
          method: 'PATCH',
          body: JSON.stringify(progressBody),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return errorResult('**ABORT: Your worker has been terminated.** The task may have been reassigned by an admin. STOP working on this task immediately - do not push, commit, or create PRs. Use complete_task with error param or simply stop.');
        }
        throw err;
      }

      let resultText = `Progress updated: ${params.progress}%${params.message ? ` - ${params.message}` : ''}`;

      const instructions = response.instructions;
      if (instructions) {
        resultText += `\n\n**ADMIN INSTRUCTION:** ${instructions}`;
      }

      return text(resultText);
    }

    case 'complete_task': {
      if (!params.workerId) throw new Error('workerId is required');

      if (params.error) {
        await api(`/api/workers/${params.workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: params.error }),
        });
        return text(`Task marked as failed: ${params.error}`);
      }

      try {
        await api(`/api/workers/${params.workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'completed',
            ...(params.summary ? { summary: params.summary } : {}),
            ...(params.structuredOutput ? { structuredOutput: params.structuredOutput } : {}),
          }),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return errorResult('**WARNING: Worker was already terminated.** The task may have been reassigned. Your work may have been superseded by another worker.');
        }
        throw err;
      }

      return text(`Task completed successfully!${params.summary ? `\n\nSummary: ${params.summary}` : ''}`);
    }

    case 'create_pr': {
      if (!params.workerId || !params.title || !params.head) {
        throw new Error('workerId, title, and head branch are required');
      }

      const data = await api('/api/github/pr', {
        method: 'POST',
        body: JSON.stringify({
          workerId: params.workerId,
          title: params.title,
          body: params.body,
          head: params.head,
          base: params.base,
          draft: params.draft,
        }),
      });

      return text(`Pull request created!\n\n**PR #${data.pr.number}:** ${data.pr.title}\n**URL:** ${data.pr.url}\n**State:** ${data.pr.state}`);
    }

    case 'update_task': {
      if (!params.taskId) throw new Error('taskId is required');

      const updateFields: Record<string, unknown> = {};
      if (params.title !== undefined) updateFields.title = params.title;
      if (params.description !== undefined) updateFields.description = params.description;
      if (params.priority !== undefined) updateFields.priority = params.priority;
      if (params.project !== undefined) updateFields.project = params.project;

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, description, priority, project) must be provided');
      }

      const updated = await api(`/api/tasks/${params.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateFields),
      });

      return text(`Task updated: "${updated.title}" (ID: ${updated.id})\nStatus: ${updated.status}\nPriority: ${updated.priority}`);
    }

    case 'create_task': {
      if (!params.title || !params.description) throw new Error('title and description are required');

      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskBody: Record<string, unknown> = {
        workspaceId: wsId,
        title: params.title,
        description: params.description,
        priority: params.priority || 5,
        creationSource: 'mcp',
      };
      if (ctx.workerId) taskBody.createdByWorkerId = ctx.workerId;
      if (params.category) taskBody.category = params.category;
      if (params.outputRequirement) taskBody.outputRequirement = params.outputRequirement;
      if (params.outputSchema && typeof params.outputSchema === 'object') {
        taskBody.outputSchema = params.outputSchema;
      }
      if (params.project) taskBody.project = params.project;

      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskBody),
      });

      return text(`Task created: "${task.title}" (ID: ${task.id})\nStatus: pending\nPriority: ${task.priority}${ctx.workerId ? `\nCreated by worker: ${ctx.workerId}` : ''}`);
    }

    case 'create_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.cronExpression || !params.title) {
        throw new Error('name, cronExpression, and title are required');
      }

      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskTemplate: Record<string, unknown> = {
        title: params.title,
        description: params.description,
        priority: params.priority || 5,
        mode: params.mode || 'execution',
      };

      if (params.skillSlugs && Array.isArray(params.skillSlugs) && params.skillSlugs.length > 0) {
        taskTemplate.context = { skillSlugs: params.skillSlugs };
      }

      if (params.trigger && typeof params.trigger === 'object') {
        const trigger = params.trigger as Record<string, unknown>;
        if (!trigger.type || !trigger.url) throw new Error("trigger requires type ('rss' | 'http-json') and url");
        if (trigger.type !== 'rss' && trigger.type !== 'http-json') throw new Error("trigger.type must be 'rss' or 'http-json'");
        taskTemplate.trigger = {
          type: trigger.type,
          url: trigger.url,
          ...(trigger.path ? { path: trigger.path } : {}),
          ...(trigger.headers ? { headers: trigger.headers } : {}),
        };
      }

      const schedule = await api(`/api/workspaces/${wsId}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          cronExpression: params.cronExpression,
          timezone: params.timezone || 'UTC',
          taskTemplate,
        }),
      });

      const sched = schedule.schedule;
      const triggerInfo = sched.taskTemplate?.trigger
        ? `\nTrigger: ${sched.taskTemplate.trigger.type} → ${sched.taskTemplate.trigger.url}`
        : '';
      return text(`Schedule created: "${sched.name}" (ID: ${sched.id})\nCron: ${sched.cronExpression} (${sched.timezone})\nNext run: ${sched.nextRunAt || 'not scheduled'}\nCreates task: "${sched.taskTemplate.title}"${triggerInfo}`);
    }

    case 'update_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.scheduleId) throw new Error('scheduleId is required');

      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      if (!wsId) throw new Error('Could not determine workspace.');

      const updateBody: Record<string, unknown> = {};
      if (params.cronExpression !== undefined) updateBody.cronExpression = params.cronExpression;
      if (params.timezone !== undefined) updateBody.timezone = params.timezone;
      if (params.enabled !== undefined) updateBody.enabled = params.enabled;
      if (params.name !== undefined) updateBody.name = params.name;
      if (params.taskTemplate !== undefined) updateBody.taskTemplate = params.taskTemplate;

      if (params.skillSlugs && Array.isArray(params.skillSlugs) && !params.taskTemplate) {
        const current = await api(`/api/workspaces/${wsId}/schedules/${params.scheduleId}`);
        const existingTemplate = current.schedule?.taskTemplate || {};
        updateBody.taskTemplate = {
          ...existingTemplate,
          context: {
            ...(existingTemplate.context || {}),
            skillSlugs: params.skillSlugs,
          },
        };
      }

      if (Object.keys(updateBody).length === 0) {
        throw new Error('At least one field (cronExpression, timezone, enabled, name, taskTemplate, skillSlugs) must be provided');
      }

      const updated = await api(`/api/workspaces/${wsId}/schedules/${params.scheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateBody),
      });

      const updSched = updated.schedule;
      return text(`Schedule updated: "${updSched.name}" (ID: ${updSched.id})\nCron: ${updSched.cronExpression} (${updSched.timezone})\nEnabled: ${updSched.enabled}\nNext run: ${updSched.nextRunAt || 'not scheduled'}`);
    }

    case 'list_schedules': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const data = await api(`/api/workspaces/${wsId}/schedules`);
      const schedules = data.schedules || [];

      if (schedules.length === 0) return text('No schedules configured for this workspace.');

      const summary = schedules.map((s: any) =>
        `- **${s.name}** ${s.enabled ? '' : '(PAUSED)'}\n  Cron: ${s.cronExpression} (${s.timezone})\n  Next: ${s.nextRunAt || 'N/A'} | Runs: ${s.totalRuns}${s.consecutiveFailures > 0 ? ` | Failures: ${s.consecutiveFailures}` : ''}\n  Task: ${s.taskTemplate.title}\n  ID: ${s.id}`
      ).join('\n\n');

      return text(`${schedules.length} schedule(s):\n\n${summary}`);
    }

    case 'register_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.content) throw new Error('name and content are required');

      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const data = await api(`/api/workspaces/${wsId}/skills`, {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          content: params.content,
          description: params.description || undefined,
          source: params.source || 'mcp',
        }),
      });

      const skill = data.skill;
      return text(`Skill registered: "${skill.name}" (slug: ${skill.slug})\nOrigin: ${skill.origin}\nEnabled: ${skill.enabled}`);
    }

    case 'create_artifact': {
      if (!params.workerId) throw new Error('workerId is required');
      if (!params.type || !params.title) throw new Error('type and title are required');

      const validArtifactTypes = ['content', 'report', 'data', 'link', 'summary'];
      if (!validArtifactTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validArtifactTypes.join(', ')}`);
      }

      const artifactBody: Record<string, unknown> = {
        type: params.type,
        title: params.title,
      };
      if (params.content) artifactBody.content = params.content;
      if (params.url) artifactBody.url = params.url;
      if (params.metadata && typeof params.metadata === 'object') artifactBody.metadata = params.metadata;
      if (params.key) artifactBody.key = params.key;

      const artifactData = await api(`/api/workers/${params.workerId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify(artifactBody),
      });

      const art = artifactData.artifact;
      const upserted = artifactData.upserted ? ' (updated existing)' : '';
      return text(`Artifact created${upserted}: "${art.title}" (${art.type})\nID: ${art.id}\nShare URL: ${art.shareUrl}`);
    }

    case 'list_artifacts': {
      const wsId = (params.workspaceId as string) || ctx.workspaceId || await ctx.getWorkspaceId();
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const searchParams = new URLSearchParams();
      if (params.key) searchParams.set('key', params.key as string);
      if (params.type) searchParams.set('type', params.type as string);
      if (params.limit) searchParams.set('limit', String(params.limit));

      const data = await api(`/api/workspaces/${wsId}/artifacts?${searchParams}`);
      const artifactsList = data.artifacts || [];

      if (artifactsList.length === 0) {
        return text(`No artifacts found${params.key ? ` with key "${params.key}"` : ''}.`);
      }

      const summary = artifactsList.map((a: any) => {
        const preview = a.content && a.content.length > 200 ? a.content.slice(0, 200) + '...' : a.content;
        return `- **${a.title}** (${a.type}${a.key ? `, key: ${a.key}` : ''})\n  ID: ${a.id}\n  Updated: ${a.updatedAt}\n  Share: ${a.shareUrl || 'N/A'}${preview ? `\n  Preview: ${preview}` : ''}`;
      }).join('\n\n');

      return text(`${artifactsList.length} artifact(s):\n\n${summary}`);
    }

    case 'update_artifact': {
      if (!params.artifactId) throw new Error('artifactId is required');

      const updateBody: Record<string, unknown> = {};
      if (params.title !== undefined) updateBody.title = params.title;
      if (params.content !== undefined) updateBody.content = params.content;
      if (params.metadata !== undefined) updateBody.metadata = params.metadata;

      if (Object.keys(updateBody).length === 0) {
        throw new Error('At least one field (title, content, metadata) must be provided');
      }

      const updated = await api(`/api/artifacts/${params.artifactId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateBody),
      });

      const updatedArt = updated.artifact;
      return text(`Artifact updated: "${updatedArt.title}" (${updatedArt.type})\nID: ${updatedArt.id}\nShare URL: ${updatedArt.shareUrl || 'N/A'}`);
    }

    // ── Observability (Phase 5) ────────────────────────────────────────────

    case 'emit_event': {
      if (!params.workerId) throw new Error('workerId is required');
      if (!params.type) throw new Error('type is required');
      if (!params.label) throw new Error('label is required');

      await api(`/api/workers/${params.workerId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          appendMilestones: [{
            type: params.type,
            label: params.label,
            ts: Date.now(),
            ...(params.metadata && typeof params.metadata === 'object' ? { metadata: params.metadata } : {}),
          }],
        }),
      });

      return text(`Event emitted: [${params.type}] ${params.label}`);
    }

    case 'query_events': {
      if (!params.workerId) throw new Error('workerId is required');

      const data = await api(`/api/workers/${params.workerId}`);
      const milestones = data.milestones || [];

      let filtered = milestones;
      if (params.type) {
        filtered = milestones.filter((m: any) => m.type === params.type);
      }

      if (filtered.length === 0) {
        return text(`No events found${params.type ? ` of type "${params.type}"` : ''}.`);
      }

      const summary = filtered.map((m: any) =>
        `- [${m.type}] ${m.label} (${new Date(m.ts).toISOString()})${m.metadata ? ` — ${JSON.stringify(m.metadata)}` : ''}`
      ).join('\n');

      return text(`${filtered.length} event(s):\n\n${summary}`);
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── Memory Action Handler ────────────────────────────────────────────────────

import { MemoryClient } from './memory-client';

export async function handleMemoryAction(
  memoryClient: MemoryClient,
  action: string,
  params: Record<string, unknown>,
  ctx: { project?: string; workerId?: string },
): Promise<ToolResult> {
  switch (action) {
    case 'context': {
      const project = (params.project as string) || ctx.project;
      const data = await memoryClient.getContext(project);
      return text(data.markdown || '(No memories yet)');
    }

    case 'search': {
      const data = await memoryClient.search({
        query: params.query as string | undefined,
        type: params.type as string | undefined,
        project: (params.project as string) || ctx.project,
        files: params.files as string[] | undefined,
        limit: Math.min((params.limit as number) || 10, 50),
        offset: params.offset as number | undefined,
      });

      if (!data.results || data.results.length === 0) {
        return text(`No memories found${params.query ? ` matching "${params.query}"` : ''}. Use buildd_memory action=save to record memories.`);
      }

      // Fetch full content
      const ids = data.results.map(r => r.id);
      let fetched: any[] = [];
      try {
        const batchData = await memoryClient.batch(ids);
        fetched = batchData.memories || [];
      } catch {
        fetched = [];
      }

      if (fetched.length > 0) {
        const details = fetched.map((m: any) =>
          `## ${m.type}: ${m.title}\n**ID:** ${m.id}\n**Files:** ${m.files?.join(', ') || 'none'}\n**Tags:** ${m.tags?.join(', ') || 'none'}\n\n${m.content}`
        ).join('\n\n---\n\n');

        return text(`Found ${data.total} memory(s)${data.total > fetched.length ? ` (showing ${fetched.length})` : ''}:\n\n${details}`);
      }

      // Fallback: summary only
      const summary = data.results.map((m: any) =>
        `- **${m.type}**: ${m.title}\n  ID: ${m.id}\n  Files: ${m.files?.slice(0, 3).join(', ') || 'none'}`
      ).join('\n\n');

      return text(`Found ${data.total} memory(s)${data.total > data.results.length ? ` (showing ${data.results.length})` : ''}:\n\n${summary}`);
    }

    case 'save': {
      if (!params.type || !params.title || !params.content) throw new Error('type, title, and content are required');

      const validTypes = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
      if (!validTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
      }

      const data = await memoryClient.save({
        type: params.type as string,
        title: params.title as string,
        content: params.content as string,
        project: (params.project as string) || ctx.project || undefined,
        tags: params.tags as string[] | undefined,
        files: params.files as string[] | undefined,
        source: (params.source as string) || (ctx.workerId ? `worker:${ctx.workerId}` : 'mcp-agent'),
      });

      return text(`Memory saved: "${data.memory.title}" (${data.memory.type})\nID: ${data.memory.id}`);
    }

    case 'get': {
      if (!params.id) throw new Error('id is required');
      const data = await memoryClient.get(params.id as string);
      const m = data.memory;
      const meta = [
        `Type: ${m.type}`,
        m.project && `Project: ${m.project}`,
        m.tags?.length && `Tags: ${m.tags.join(', ')}`,
        m.files?.length && `Files: ${m.files.join(', ')}`,
        m.source && `Source: ${m.source}`,
      ].filter(Boolean).join('\n');
      return text(`# ${m.title}\n\n${meta}\n\n${m.content}`);
    }

    case 'update': {
      if (!params.id) throw new Error('id is required');

      const updateFields: Record<string, unknown> = {};
      if (params.title !== undefined) updateFields.title = params.title;
      if (params.content !== undefined) updateFields.content = params.content;
      if (params.type !== undefined) updateFields.type = params.type;
      if (params.files !== undefined) updateFields.files = params.files;
      if (params.tags !== undefined) updateFields.tags = params.tags;
      if (params.project !== undefined) updateFields.project = params.project;

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, content, type, files, tags, project) must be provided');
      }

      const data = await memoryClient.update(params.id as string, updateFields);
      return text(`Memory updated: "${data.memory.title}" (${data.memory.type})\nID: ${data.memory.id}`);
    }

    case 'delete': {
      if (!params.id) throw new Error('id is required');
      await memoryClient.delete(params.id as string);
      return text(`Memory deleted: ${params.id}`);
    }

    default:
      throw new Error(`Unknown memory action: ${action}. Use one of: ${memoryActions.join(', ')}`);
  }
}
