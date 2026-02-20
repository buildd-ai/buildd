/**
 * In-process MCP server for Buildd worker coordination.
 *
 * Uses the SDK's createSdkMcpServer() + tool() helpers to provide
 * buildd coordination tools (progress reporting, task updates, memory)
 * directly in the worker process — no subprocess overhead.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

export interface BuilddMcpServerOptions {
  /** Buildd API server URL */
  serverUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Pre-assigned worker ID (if any) */
  workerId?: string;
  /** Workspace ID override */
  workspaceId?: string;
}

function apiCall(serverUrl: string, apiKey: string, endpoint: string, options: RequestInit = {}) {
  return fetch(`${serverUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  }).then(async (response) => {
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }
    return response.json();
  });
}

async function getAccountLevel(serverUrl: string, apiKey: string): Promise<'worker' | 'admin'> {
  try {
    const data = await apiCall(serverUrl, apiKey, '/api/accounts/me');
    return data.level || 'worker';
  } catch {
    return 'worker';
  }
}

/**
 * Creates an in-process MCP server with Buildd coordination tools.
 * Returns a config object that can be passed to query() options.mcpServers.
 */
export function createBuilddMcpServer(opts: BuilddMcpServerOptions) {
  const { serverUrl, apiKey, workerId, workspaceId } = opts;

  const api = (endpoint: string, options?: RequestInit) =>
    apiCall(serverUrl, apiKey, endpoint, options);

  return createSdkMcpServer({
    name: 'buildd',
    version: '1.0.0',
    tools: [
      // ── buildd tool ──────────────────────────────────────────────────
      tool(
        'buildd',
        `Task coordination tool. Available actions: list_tasks, claim_task, update_progress, complete_task, create_pr, update_task, create_task, create_artifact, create_schedule, update_schedule, list_schedules, register_skill, review_workspace. Use action parameter to select operation, params for action-specific arguments.`,
        {
          action: z.enum([
            'list_tasks', 'claim_task', 'update_progress', 'complete_task',
            'create_pr', 'update_task', 'create_task', 'create_artifact',
            'create_schedule', 'update_schedule', 'list_schedules', 'register_skill',
            'review_workspace',
          ]),
          params: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          try {
            const params = (args.params || {}) as Record<string, unknown>;
            return await handleBuilddAction(api, args.action, params, {
              serverUrl, workerId, workspaceId,
              getLevel: () => getAccountLevel(serverUrl, apiKey),
            });
          } catch (error) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
              isError: true,
            };
          }
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
        },
      ),

      // ── buildd_memory tool ────────────────────────────────────────────
      tool(
        'buildd_memory',
        'Search or save workspace memory (observations about code patterns, gotchas, decisions). Search returns full content inline.',
        {
          action: z.enum(['search', 'save']),
          params: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          try {
            const params = (args.params || {}) as Record<string, unknown>;
            return await handleMemoryAction(api, args.action, params, { workspaceId, workerId });
          } catch (error) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
              isError: true,
            };
          }
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
        },
      ),
    ],
  });
}

// ── Action Handlers ─────────────────────────────────────────────────────────

interface ActionContext {
  serverUrl: string;
  workerId?: string;
  workspaceId?: string;
  getLevel: () => Promise<'worker' | 'admin'>;
}

type ApiFn = (endpoint: string, options?: RequestInit) => Promise<any>;

async function handleBuilddAction(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
) {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  switch (action) {
    case 'list_tasks': {
      const data = await api('/api/tasks');
      const allTasks = data.tasks || [];
      let pending = allTasks.filter((t: any) => t.status === 'pending');
      if (ctx.workspaceId) {
        pending = pending.filter((t: any) => t.workspaceId === ctx.workspaceId);
      }
      pending.sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));

      const limit = 5;
      const offset = Math.max((params.offset as number) || 0, 0);
      const paginated = pending.slice(offset, offset + limit);
      const hasMore = offset + limit < pending.length;

      if (paginated.length === 0) return text('No pending tasks to claim.');

      const summary = paginated.map((t: any) =>
        `- ${t.title} (id: ${t.id})\n  ${t.description?.slice(0, 100) || 'No description'}...`
      ).join('\n\n');

      const header = `${pending.length} pending task${pending.length === 1 ? '' : 's'}:`;
      const moreHint = hasMore ? `\n\nCall with offset=${offset + limit} to see more.` : '';
      const claimHint = `\n\nTo claim a task, call action=claim_task (it auto-assigns the highest-priority task — you don't pick by ID).`;
      return text(`${header}\n\n${summary}${moreHint}${claimHint}`);
    }

    case 'claim_task': {
      const wsId = (params.workspaceId as string) || ctx.workspaceId;
      const data = await api('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ maxTasks: params.maxTasks || 1, workspaceId: wsId, runner: 'mcp' }),
      });

      const workers = data.workers || [];
      if (workers.length === 0) return text('No tasks available to claim. All tasks may be assigned or completed.');

      const claimed = workers.map((w: any) =>
        `**Worker ID:** ${w.id}\n**Task:** ${w.task.title}\n**Branch:** ${w.branch}\n**Description:** ${w.task.description || 'No description'}`
      ).join('\n\n---\n\n');

      // Proactively fetch relevant memory
      let memorySection = '';
      try {
        const firstWorker = workers[0];
        const resolvedWsId = wsId || firstWorker.task?.workspaceId;
        if (resolvedWsId && firstWorker.task.title) {
          const searchData = await api(`/api/workspaces/${resolvedWsId}/observations/search?query=${encodeURIComponent(firstWorker.task.title)}&limit=5`);
          const results = searchData.results || [];
          if (results.length > 0) {
            const ids = results.map((r: any) => r.id).join(',');
            const batchData = await api(`/api/workspaces/${resolvedWsId}/observations/batch?ids=${ids}`);
            const observations = batchData.observations || [];
            if (observations.length > 0) {
              const memoryLines = observations.map((o: any) => {
                const truncContent = o.content.length > 200 ? o.content.slice(0, 200) + '...' : o.content;
                return `- **[${o.type}] ${o.title}**: ${truncContent}`;
              });
              memorySection = `\n\n## Relevant Memory\nREAD these observations before starting work:\n${memoryLines.join('\n')}\n\nUse \`buildd_memory\` action=search for more context.`;
            }
          }
        }
      } catch {
        // Memory fetch is non-fatal
      }

      return text(`Claimed ${workers.length} task(s):\n\n${claimed}${memorySection}\n\nUse the worker ID to report progress and completion.`);
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
          return {
            content: [{ type: 'text' as const, text: '**ABORT: Your worker has been terminated.** The task may have been reassigned by an admin. STOP working on this task immediately - do not push, commit, or create PRs. Use complete_task with error param or simply stop.' }],
            isError: true,
          };
        }
        throw err;
      }

      let resultText = `Progress updated: ${params.progress}%${params.message ? ` - ${params.message}` : ''}`;

      const instructions = response.instructions;
      if (instructions) {
        let parsedInstruction: { type?: string; message?: string } | null = null;
        try { parsedInstruction = JSON.parse(instructions); } catch { /* plain text */ }

        if (parsedInstruction?.type === 'request_plan') {
          resultText += `\n\n**PLAN REQUESTED:** Please pause implementation. Investigate the codebase, then use update_progress with plan param to submit your implementation plan. ${parsedInstruction.message || ''}`;
        } else {
          resultText += `\n\n**ADMIN INSTRUCTION:** ${instructions}`;
        }
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
          }),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return {
            content: [{ type: 'text' as const, text: '**WARNING: Worker was already terminated.** The task may have been reassigned. Your work may have been superseded by another worker.' }],
            isError: true,
          };
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
      if (params.addBlockedByTaskIds && Array.isArray(params.addBlockedByTaskIds)) {
        updateFields.addBlockedByTaskIds = params.addBlockedByTaskIds;
      }
      if (params.removeBlockedByTaskIds && Array.isArray(params.removeBlockedByTaskIds)) {
        updateFields.removeBlockedByTaskIds = params.removeBlockedByTaskIds;
      }

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, description, priority, addBlockedByTaskIds, removeBlockedByTaskIds) must be provided');
      }

      const updated = await api(`/api/tasks/${params.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateFields),
      });

      return text(`Task updated: "${updated.title}" (ID: ${updated.id})\nStatus: ${updated.status}\nPriority: ${updated.priority}`);
    }

    case 'create_task': {
      if (!params.title || !params.description) throw new Error('title and description are required');

      const wsId = (params.workspaceId as string) || ctx.workspaceId;
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskBody: Record<string, unknown> = {
        workspaceId: wsId,
        title: params.title,
        description: params.description,
        priority: params.priority || 5,
        creationSource: 'mcp',
      };
      if (ctx.workerId) taskBody.createdByWorkerId = ctx.workerId;
      if (params.blockedByTaskIds && Array.isArray(params.blockedByTaskIds)) {
        taskBody.blockedByTaskIds = params.blockedByTaskIds;
      }

      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskBody),
      });

      const statusLabel = task.status === 'blocked' ? 'blocked' : 'pending';
      return text(`Task created: "${task.title}" (ID: ${task.id})\nStatus: ${statusLabel}\nPriority: ${task.priority}${ctx.workerId ? `\nCreated by worker: ${ctx.workerId}` : ''}${task.status === 'blocked' ? `\nBlocked by: ${(params.blockedByTaskIds as string[]).join(', ')}` : ''}`);
    }

    case 'create_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.cronExpression || !params.title) {
        throw new Error('name, cronExpression, and title are required');
      }

      const wsId = (params.workspaceId as string) || ctx.workspaceId;
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

      const wsId = (params.workspaceId as string) || ctx.workspaceId;
      if (!wsId) throw new Error('Could not determine workspace.');

      const updateBody: Record<string, unknown> = {};
      if (params.cronExpression !== undefined) updateBody.cronExpression = params.cronExpression;
      if (params.timezone !== undefined) updateBody.timezone = params.timezone;
      if (params.enabled !== undefined) updateBody.enabled = params.enabled;
      if (params.name !== undefined) updateBody.name = params.name;
      if (params.taskTemplate !== undefined) updateBody.taskTemplate = params.taskTemplate;

      // Shorthand: skillSlugs merges into existing taskTemplate.context
      if (params.skillSlugs && Array.isArray(params.skillSlugs) && !params.taskTemplate) {
        // Fetch current schedule to merge skillSlugs into existing template
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

      const wsId = (params.workspaceId as string) || ctx.workspaceId;
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

      const wsId = (params.workspaceId as string) || ctx.workspaceId;
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

      const artifactData = await api(`/api/workers/${params.workerId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify(artifactBody),
      });

      const art = artifactData.artifact;
      return text(`Artifact created: "${art.title}" (${art.type})\nID: ${art.id}\nShare URL: ${art.shareUrl}`);
    }

    case 'review_workspace': {
      const wsId = (params.workspaceId as string) || ctx.workspaceId;
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      // Fetch recent tasks (completed + failed) with their workers
      const hoursBack = Math.min(Math.max((params.hoursBack as number) || 24, 1), 168); // 1h–7d
      const data = await api(`/api/workspaces/${wsId}/tasks/review?hoursBack=${hoursBack}`);

      const tasksToReview = data.tasks || [];
      if (tasksToReview.length === 0) {
        return text(`No completed or failed tasks in the last ${hoursBack} hours. Nothing to review.`);
      }

      // Analyze each task for protocol issues
      const findings: string[] = [];
      const taskSummaries: string[] = [];

      for (const task of tasksToReview) {
        const issues: string[] = [];
        const result = task.result || {};
        const worker = task.worker;

        // Check: task failed without a follow-up
        if (task.status === 'failed') {
          const hasSubTasks = (task.subTaskCount || 0) > 0;
          if (!hasSubTasks) {
            issues.push('FAILED without follow-up task created');
          }
        }

        // Check: completed but no PR created (when workspace requires PRs)
        if (task.status === 'completed' && task.mode === 'execution') {
          if (!result.prUrl && !result.prNumber) {
            if (result.commits && result.commits > 0) {
              issues.push(`Has ${result.commits} commit(s) but NO PR created`);
            } else if (!result.commits || result.commits === 0) {
              issues.push('Completed with NO commits and NO PR — may not have pushed work');
            }
          }
        }

        // Check: planning mode completed but no structured output or summary
        if (task.status === 'completed' && task.mode === 'planning') {
          if (!result.summary && !result.structuredOutput) {
            issues.push('Planning task completed without a plan summary or structured output');
          }
        }

        // Check: worker had permission denials
        if (worker?.resultMeta?.permissionDenials?.length > 0) {
          issues.push(`Worker had ${worker.resultMeta.permissionDenials.length} permission denial(s)`);
        }

        const statusIcon = task.status === 'completed' ? 'OK' : 'FAIL';
        const prInfo = result.prUrl ? ` | PR: ${result.prUrl}` : '';
        const commitInfo = result.commits ? ` | ${result.commits} commits` : '';

        let taskLine = `- [${statusIcon}] **${task.title}** (${task.id.slice(0, 8)})${commitInfo}${prInfo}`;
        if (issues.length > 0) {
          taskLine += `\n  ⚠ Issues: ${issues.join('; ')}`;
        }
        taskSummaries.push(taskLine);

        if (issues.length > 0) {
          findings.push(
            `Task "${task.title}" (${task.id}):\n` +
            issues.map(i => `  - ${i}`).join('\n')
          );
        }
      }

      const completed = tasksToReview.filter((t: any) => t.status === 'completed').length;
      const failed = tasksToReview.filter((t: any) => t.status === 'failed').length;
      const header = `## Workspace Review (last ${hoursBack}h)\n\n**${tasksToReview.length} tasks** reviewed: ${completed} completed, ${failed} failed\n`;

      const tasksSection = `### Tasks\n${taskSummaries.join('\n')}\n`;

      let findingsSection = '';
      if (findings.length > 0) {
        findingsSection = `\n### Findings (${findings.length} issue${findings.length === 1 ? '' : 's'})\n${findings.join('\n\n')}\n\n### Recommended Actions\nFor each finding above, consider creating a follow-up task using \`action=create_task\` to:\n- Create PRs for unpushed work\n- Retry or investigate failed tasks\n- Document plans that were completed without summaries`;
      } else {
        findingsSection = '\n### Findings\nAll tasks followed protocols correctly. No issues found.';
      }

      return text(`${header}\n${tasksSection}${findingsSection}`);
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function handleMemoryAction(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: { workspaceId?: string; workerId?: string },
) {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  switch (action) {
    case 'search': {
      if (!ctx.workspaceId) throw new Error('Could not determine workspace. Set workspaceId.');

      const searchParams = new URLSearchParams();
      if (params.query) searchParams.set('query', params.query as string);
      if (params.type) searchParams.set('type', params.type as string);
      if (params.files && Array.isArray(params.files) && params.files.length > 0) {
        searchParams.set('files', (params.files as string[]).join(','));
      }
      if (params.concepts && Array.isArray(params.concepts) && params.concepts.length > 0) {
        searchParams.set('concepts', (params.concepts as string[]).join(','));
      }
      searchParams.set('limit', String(Math.min((params.limit as number) || 10, 50)));

      const data = await api(`/api/workspaces/${ctx.workspaceId}/observations/search?${searchParams}`);

      if (!data.results || data.results.length === 0) {
        return text(`No observations found${params.query ? ` matching "${params.query}"` : ''}. Use buildd_memory action=save to record observations.`);
      }

      // Fetch full content
      const ids = data.results.map((r: any) => r.id).join(',');
      let observations: any[] = [];
      try {
        const batchData = await api(`/api/workspaces/${ctx.workspaceId}/observations/batch?ids=${ids}`);
        observations = batchData.observations || [];
      } catch {
        observations = [];
      }

      if (observations.length > 0) {
        const details = observations.map((obs: any) =>
          `## ${obs.type}: ${obs.title}\n**ID:** ${obs.id}\n**Files:** ${obs.files?.join(', ') || 'none'}\n**Concepts:** ${obs.concepts?.join(', ') || 'none'}\n\n${obs.content}`
        ).join('\n\n---\n\n');

        return text(`Found ${data.total} observation(s)${data.total > observations.length ? ` (showing ${observations.length})` : ''}:\n\n${details}`);
      }

      // Fallback: summary only
      const summary = data.results.map((obs: any) =>
        `- **${obs.type}**: ${obs.title}\n  ID: ${obs.id}\n  Files: ${obs.files?.slice(0, 3).join(', ') || 'none'}`
      ).join('\n\n');

      return text(`Found ${data.total} observation(s)${data.total > data.results.length ? ` (showing ${data.results.length})` : ''}:\n\n${summary}`);
    }

    case 'save': {
      if (!ctx.workspaceId) throw new Error('Could not determine workspace. Set workspaceId.');
      if (!params.type || !params.title || !params.content) throw new Error('type, title, and content are required');

      const validTypes = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
      if (!validTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
      }

      const body: Record<string, unknown> = {
        type: params.type,
        title: params.title,
        content: params.content,
      };
      if (params.files && Array.isArray(params.files)) body.files = params.files;
      if (params.concepts && Array.isArray(params.concepts)) body.concepts = params.concepts;
      if (ctx.workerId) body.workerId = ctx.workerId;

      const data = await api(`/api/workspaces/${ctx.workspaceId}/observations`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return text(`Observation saved: "${data.observation.title}" (${data.observation.type})\nID: ${data.observation.id}`);
    }

    default:
      throw new Error(`Unknown memory action: ${action}. Use "search" or "save".`);
  }
}
