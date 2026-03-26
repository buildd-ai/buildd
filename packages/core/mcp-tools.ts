/**
 * Shared MCP tool handlers for Buildd.
 *
 * Used by:
 * - packages/core/buildd-mcp-server.ts (in-process SDK server)
 * - apps/web/src/app/api/mcp/route.ts (HTTP server)
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_NAMES: Record<string, number> = {
  lowest: 1, low: 3, medium: 5, high: 7, highest: 9, critical: 10, urgent: 10,
};

/** Convert named priority levels (e.g. "medium") to integer 0-10. */
function normalizePriority(val: unknown, fallback = 5): number {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'number') return Math.max(0, Math.min(10, Math.round(val)));
  const s = String(val).toLowerCase().trim();
  const parsed = Number(s);
  if (!isNaN(parsed)) return Math.max(0, Math.min(10, Math.round(parsed)));
  return PRIORITY_NAMES[s] ?? fallback;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ApiFn = (endpoint: string, options?: RequestInit) => Promise<any>;

export interface ActionContext {
  workerId?: string;
  workspaceId?: string;
  getWorkspaceId: () => Promise<string | null>;
  getLevel: () => Promise<'trigger' | 'worker' | 'admin'>;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ── Action Lists ─────────────────────────────────────────────────────────────

// Trigger level: can create tasks and artifacts, but cannot claim or execute
export const triggerActions = [
  'list_tasks', 'create_task', 'create_artifact',
  'list_artifacts', 'get_artifact', 'emit_event',
  'list_artifact_templates',
] as const;

export const workerActions = [
  'list_tasks', 'claim_task', 'update_progress', 'complete_task',
  'create_pr', 'update_task', 'create_task', 'create_artifact',
  'upload_artifact', 'list_artifacts', 'get_artifact', 'update_artifact',
  'emit_event', 'query_events',
  'list_artifact_templates',
  'suggest_schedule_update',
] as const;

export const adminActions = [
  'create_schedule', 'update_schedule', 'list_schedules',
  'register_skill', 'list_skills', 'update_skill', 'delete_skill',
  'manage_secrets',
  'approve_plan', 'reject_plan',
  'manage_missions',
  'manage_workspaces',
  'list_recipes', 'create_recipe', 'run_recipe',
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
    update_progress: '{ workerId?, progress (required), message?, plan?, inputTokens?, outputTokens?, lastCommitSha?, commitCount?, filesChanged?, linesAdded?, linesRemoved? } — workerId auto-resolved from context if omitted',
    complete_task: '{ workerId?, summary?, error?, structuredOutput?, nextSuggestion? } — if error present, marks task as failed. nextSuggestion hints what the orchestrator should consider next. workerId auto-resolved from context if omitted',
    create_pr: '{ workerId?, title (required), head (required), body?, base?, draft? } — workerId auto-resolved from context if omitted',
    update_task: '{ taskId (required), title?, description?, priority?, project?, status? (pending|completed|failed — only for tasks without active workers) }',
    create_task: '{ title (required), description (required), workspaceId?, priority?, category? (bug|feature|refactor|chore|docs|test|infra|design — auto-detected if omitted), outputRequirement? (pr_required|artifact_required|none|auto — default auto), outputSchema?, project? (monorepo project name for scoping), missionId? (auto-inherited from caller), parentTaskId? (link retry to original task), roleSlug? (route to specific role), baseBranch? (start worktree from this branch instead of default), verificationCommand? (command to run after completion), iteration? (retry attempt number), maxIterations? (max retry attempts), failureContext? (error output from previous attempt), skillSlugs?, model? (haiku|sonnet|opus or full ID), effort? (low|medium|high — reasoning effort), callbackUrl? (HTTPS URL to POST results on completion), callbackToken? (Bearer token for callback auth) }',
    create_artifact: '{ workerId?, missionId?, type (required: content|report|data|link|summary|email_draft|social_post|analysis|recommendation|alert|calendar_event|file), title (required), content?, url?, metadata?, key? } — workerId auto-resolved from context if omitted. Pass missionId instead to create a mission-level artifact without a worker context.',
    upload_artifact: '{ workerId?, filename (required), mimeType (required), sizeBytes (required), title?, type? (default: file), metadata? } — Returns presigned upload URL. After calling, upload file with: curl -X PUT -H "Content-Type: {mimeType}" --data-binary @{filePath} "{uploadUrl}". Also returns downloadUrl for embedding in markdown.',
    list_artifacts: '{ workspaceId?, key?, type?, limit? }',
    get_artifact: '{ artifactId (required) } — fetch full artifact content by ID',
    update_artifact: '{ artifactId (required), title?, content?, metadata? }',
    create_schedule: '{ name (required), cronExpression (required), title (required), description?, timezone?, priority?, mode?, skillSlugs?, trigger?, workspaceId? } [admin]',
    update_schedule: '{ scheduleId (required), cronExpression?, timezone?, enabled?, name?, taskTemplate?, skillSlugs?, workspaceId? } [admin]',
    list_schedules: '{ workspaceId? } [admin]',
    register_skill: '{ name (required), content (required), description?, source?, workspaceId?, slug?, model? (inherit|opus|sonnet|haiku), allowedTools? (string[]), canDelegateTo? (string[]), background? (boolean), maxTurns? (number), color? (hex string), mcpServers? (Record<string, McpServerConfig> or string[]), requiredEnvVars? (Record<string, string>), isRole? (boolean) } — create/upsert skill by slug [admin]',
    list_skills: '{ workspaceId?, enabled? (boolean), isRole? (boolean) } — list skills/roles in workspace [admin]',
    update_skill: '{ slug (required), workspaceId?, name?, description?, content?, model?, allowedTools?, canDelegateTo?, background?, maxTurns?, color?, mcpServers? (Record<string, McpServerConfig>), requiredEnvVars? (Record<string, string>), isRole?, repoUrl?, enabled? } — update skill by slug [admin]',
    delete_skill: '{ slug (required), workspaceId? } — delete skill by slug [admin]',
    manage_secrets: '{ action: "list" | "set" | "delete", label? (required for set — env var name), value? (required for set — the secret value), purpose? (default: mcp_credential), secretId? (required for delete) } — manage encrypted MCP credential secrets [admin]',
    approve_plan: '{ taskId (required) } — approve planning task, create child execution tasks [admin]',
    reject_plan: '{ taskId (required), feedback (required) } — reject plan with feedback, create revised planning task [admin]',
    manage_missions: '{ action: "list" | "create" | "get" | "update" | "delete" | "link_task" | "unlink_task", missionId?, title?, description?, workspaceId?, cronExpression?, priority?, status?, taskId?, skillSlugs?, recipeId?, model?, isHeartbeat?: boolean (default true — heartbeat auto-enabled on create; set false to disable), heartbeatChecklist?: string, activeHoursStart?: number (0-23), activeHoursEnd?: number (0-23), activeHoursTimezone?: string } — manage team missions [admin]',
    manage_workspaces: '{ action: "list" | "create" | "update" | "create_repo" | "init", workspaceId? (required for update/create_repo/init), name?, repoUrl?, defaultBranch?, accessMode?, org?, private? (default true), description? } — manage workspaces and bootstrap new projects. New project flow: 1) manage_workspaces action=create (name + optional repoUrl) to create workspace under your team, 2) Agent claims task in that workspace, 3) If no repo yet: manage_workspaces action=create_repo to create GitHub repo, or action=update to link existing repo, 4) Agent scaffolds project, commits, pushes, 5) Future tasks automatically resolve to the repo directory. [admin]',
    list_recipes: '{ workspaceId? } — list reusable workflow recipes [admin]',
    create_recipe: '{ name (required), steps (required: array of { ref, title, description?, mode?, dependsOn?, requiredCapabilities?, outputRequirement?, priority? }), description?, category? (content|research|code|ops|custom), variables?, isPublic?, workspaceId? } [admin]',
    run_recipe: '{ recipeId (required), variables?, parentTaskId?, workspaceId? } — instantiate recipe into tasks [admin]',
    emit_event: '{ workerId?, type (required), label (required), metadata? } — workerId auto-resolved from context if omitted',
    query_events: '{ workerId?, type? } — workerId auto-resolved from context if omitted',
    list_artifact_templates: '{ } — list available artifact templates with their JSON schemas for structured output',
    suggest_schedule_update: '{ scheduleId?, cronExpression?, enabled?, reason (required) } — propose a schedule change for human approval. scheduleId auto-resolved from task context if omitted. At least one of cronExpression or enabled required.',
    detect_projects: '{ rootDir? } — detect monorepo projects from package.json workspaces field',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters. By action:\n${lines.join('\n')}\n\nNote: workspaceId accepts a UUID, a repo name (e.g. "buildd"), or "owner/repo" (e.g. "buildd-ai/buildd"). Usually the repo folder name is enough — the org prefix is optional.`;
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

// UUID pattern for workspace IDs
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve worker ID from params, falling back to context worker ID.
 * Throws if neither is available.
 */
function resolveWorkerId(param: unknown, ctx: ActionContext): string {
  const workerId = (param as string) || ctx.workerId;
  if (!workerId) throw new Error('workerId is required — pass it explicitly or ensure the MCP server has worker context');
  return workerId;
}

/**
 * Resolve a skill's UUID from its slug within a workspace.
 */
async function resolveSkillId(api: ApiFn, wsId: string, slug: string): Promise<string> {
  const data = await api(`/api/workspaces/${wsId}/skills`);
  const match = (data.skills || []).find((s: any) => s.slug === slug);
  if (!match) throw new Error(`Skill with slug "${slug}" not found in workspace`);
  return match.id;
}

/**
 * Build a skill update body from params, picking only defined fields.
 */
function buildSkillBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.description !== undefined) body.description = params.description;
  if (params.content) body.content = params.content;
  if (params.source) body.source = params.source;
  if (params.model) body.model = params.model;
  if (Array.isArray(params.allowedTools)) body.allowedTools = params.allowedTools;
  if (Array.isArray(params.canDelegateTo)) body.canDelegateTo = params.canDelegateTo;
  if (typeof params.background === 'boolean') body.background = params.background;
  if (typeof params.maxTurns === 'number') body.maxTurns = params.maxTurns;
  if (params.color) body.color = params.color;
  if (params.mcpServers && typeof params.mcpServers === 'object') body.mcpServers = params.mcpServers;
  if (params.requiredEnvVars && typeof params.requiredEnvVars === 'object') body.requiredEnvVars = params.requiredEnvVars;
  if (typeof params.isRole === 'boolean') body.isRole = params.isRole;
  if (typeof params.enabled === 'boolean') body.enabled = params.enabled;
  if (params.repoUrl !== undefined) body.repoUrl = params.repoUrl;
  return body;
}

/**
 * Resolve workspace ID from a UUID, repo name (e.g. "buildd-ai/buildd"), or workspace name.
 * Falls back to context workspace ID if no param given.
 */
async function resolveWorkspaceId(
  api: ApiFn,
  param: unknown,
  ctx: ActionContext,
): Promise<string | null> {
  const raw = (param as string) || ctx.workspaceId;
  if (raw && UUID_RE.test(raw)) return raw;

  // Try context fallback first
  if (!raw) return ctx.getWorkspaceId();

  // Not a UUID — resolve by repo name or workspace name
  // Try by-repo first (handles "owner/repo" format)
  if (raw.includes('/')) {
    const data = await api(`/api/workspaces/by-repo?repo=${encodeURIComponent(raw)}`);
    if (data.workspace?.id) return data.workspace.id;
  }

  // Fall back to name match across accessible workspaces
  const wsData = await api('/api/workspaces');
  const workspaces = wsData.workspaces || [];
  const match = workspaces.find((ws: any) =>
    ws.name.toLowerCase() === raw.toLowerCase() ||
    ws.repo?.toLowerCase() === raw.toLowerCase() ||
    ws.repo?.toLowerCase().endsWith('/' + raw.toLowerCase())
  );
  if (match) return match.id;

  return null;
}

// Actions that require at least worker level (trigger tokens cannot use these)
const workerOnlyActions = new Set(
  (workerActions as readonly string[]).filter(a => !(triggerActions as readonly string[]).includes(a))
);

async function requireWorkerLevel(ctx: ActionContext, action: string): Promise<ToolResult | null> {
  if (!workerOnlyActions.has(action)) return null;
  const level = await ctx.getLevel();
  if (level === 'trigger') {
    return errorResult(`Action '${action}' requires a worker or admin token. Trigger tokens can only use: ${triggerActions.join(', ')}`);
  }
  return null;
}

export async function handleBuilddAction(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ToolResult> {
  // Check trigger-level restrictions before processing
  const levelErr = await requireWorkerLevel(ctx, action);
  if (levelErr) return levelErr;

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
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
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
      const workerId = resolveWorkerId(params.workerId, ctx);

      // Plan submission
      if (params.plan) {
        await api(`/api/workers/${workerId}/plan`, {
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

        response = await api(`/api/workers/${workerId}`, {
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
      const workerId = resolveWorkerId(params.workerId, ctx);

      if (params.error) {
        await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: params.error }),
        });
        return text(`Task marked as failed: ${params.error}`);
      }

      try {
        await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'completed',
            ...(params.summary ? { summary: params.summary } : {}),
            ...(params.structuredOutput ? { structuredOutput: params.structuredOutput } : {}),
            ...(params.nextSuggestion ? { nextSuggestion: params.nextSuggestion } : {}),
          }),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return errorResult('**WARNING: Worker was already terminated.** The task may have been reassigned. Your work may have been superseded by another worker.');
        }
        // Handle output requirement validation errors (400) — return hint so agent can fix
        if (errMsg.includes('400')) {
          try {
            const jsonMatch = errMsg.match(/\{.*\}/s);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.hint) {
                return errorResult(`**Cannot complete task:** ${parsed.error}\n\nPlease use \`${parsed.hint}\` before calling complete_task again.`);
              }
            }
          } catch { /* fall through to generic error */ }
          return errorResult(`**Cannot complete task:** ${errMsg}\n\nIf you created a PR using \`gh pr create\`, use \`create_pr\` instead so Buildd can track it.`);
        }
        throw err;
      }

      return text(`Task completed successfully!${params.summary ? `\n\nSummary: ${params.summary}` : ''}`);
    }

    case 'create_pr': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.title || !params.head) {
        throw new Error('title and head branch are required');
      }

      const data = await api('/api/github/pr', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
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
      if (params.priority !== undefined) updateFields.priority = normalizePriority(params.priority);
      if (params.project !== undefined) updateFields.project = params.project;
      if (params.status !== undefined) updateFields.status = params.status;

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, description, priority, project, status) must be provided');
      }

      const updated = await api(`/api/tasks/${params.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateFields),
      });

      return text(`Task updated: "${updated.title}" (ID: ${updated.id})\nStatus: ${updated.status}\nPriority: ${updated.priority}`);
    }

    case 'create_task': {
      if (!params.title || !params.description) throw new Error('title and description are required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskBody: Record<string, unknown> = {
        workspaceId: wsId,
        title: params.title,
        description: params.description,
        priority: normalizePriority(params.priority),
        creationSource: 'mcp',
      };
      if (ctx.workerId) taskBody.createdByWorkerId = ctx.workerId;
      if (params.parentTaskId && typeof params.parentTaskId === 'string') {
        taskBody.parentTaskId = params.parentTaskId;
      }
      if (params.category) taskBody.category = params.category;
      if (params.roleSlug && typeof params.roleSlug === 'string') taskBody.roleSlug = params.roleSlug;
      // outputRequirement inheritance from mission is handled by the API route;
      // only pass through if explicitly provided by the caller.
      if (params.outputRequirement) taskBody.outputRequirement = params.outputRequirement;
      if (params.outputSchema && typeof params.outputSchema === 'object') {
        taskBody.outputSchema = params.outputSchema;
      }
      if (params.project) taskBody.project = params.project;

      // Auto-link to mission: explicit param takes precedence, then inherit from caller's task
      if (params.missionId) {
        taskBody.missionId = params.missionId;
      } else if (ctx.workerId) {
        // Fetch caller worker's task to inherit missionId
        try {
          const workerData = await api(`/api/workers/${ctx.workerId}`);
          const callerMissionId = workerData?.task?.missionId || workerData?.task?.context?.missionId;
          if (callerMissionId) {
            taskBody.missionId = callerMissionId;
          }
        } catch {
          // Non-fatal — skip auto-linking if worker lookup fails
        }
      }

      // Pass through context fields for worker configuration
      const taskContext: Record<string, unknown> = (taskBody.context as Record<string, unknown>) || {};
      if (params.skillSlugs && Array.isArray(params.skillSlugs)) {
        taskContext.skillSlugs = params.skillSlugs;
      }
      if (params.model && typeof params.model === 'string') {
        taskContext.model = params.model;
      }
      if (params.effort && typeof params.effort === 'string') {
        taskContext.effort = params.effort;
      }
      // Ralph loop fields — branch continuity, verification, and retry metadata
      if (params.baseBranch && typeof params.baseBranch === 'string') {
        taskContext.baseBranch = params.baseBranch;
      }
      if (params.verificationCommand && typeof params.verificationCommand === 'string') {
        taskContext.verificationCommand = params.verificationCommand;
      }
      if (typeof params.iteration === 'number') {
        taskContext.iteration = params.iteration;
      }
      if (typeof params.maxIterations === 'number') {
        taskContext.maxIterations = params.maxIterations;
      }
      if (params.failureContext && typeof params.failureContext === 'string') {
        taskContext.failureContext = params.failureContext;
      }
      if (params.callbackUrl && typeof params.callbackUrl === 'string') {
        if (!params.callbackUrl.startsWith('https://')) {
          throw new Error('callbackUrl must use HTTPS');
        }
        taskContext.callback = {
          url: params.callbackUrl,
          ...(params.callbackToken && typeof params.callbackToken === 'string'
            ? { token: params.callbackToken }
            : {}),
        };
      }
      if (Object.keys(taskContext).length > 0) {
        taskBody.context = taskContext;
      }

      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskBody),
      });

      return text(`Task created: "${task.title}" (ID: ${task.id})\nStatus: pending\nPriority: ${task.priority}${taskBody.parentTaskId ? `\nParent: ${taskBody.parentTaskId}` : ''}${taskBody.missionId ? `\nLinked to mission: ${taskBody.missionId}` : ''}${ctx.workerId ? `\nCreated by worker: ${ctx.workerId}` : ''}`);
    }

    case 'create_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.cronExpression || !params.title) {
        throw new Error('name, cronExpression, and title are required');
      }

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskTemplate: Record<string, unknown> = {
        title: params.title,
        description: params.description,
        priority: normalizePriority(params.priority),
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

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace.');

      const updateBody: Record<string, unknown> = {};
      if (params.cronExpression !== undefined) updateBody.cronExpression = params.cronExpression;
      if (params.timezone !== undefined) updateBody.timezone = params.timezone;
      if (params.enabled !== undefined) updateBody.enabled = params.enabled;
      if (params.name !== undefined) updateBody.name = params.name;
      if (params.taskTemplate !== undefined) updateBody.taskTemplate = params.taskTemplate;
      if (params.workspaceId !== undefined) updateBody.workspaceId = params.workspaceId;

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
        throw new Error('At least one field (cronExpression, timezone, enabled, name, taskTemplate, skillSlugs, workspaceId) must be provided');
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

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      // If workspace specified, list its schedules; otherwise aggregate across all workspaces
      if (wsId) {
        const data = await api(`/api/workspaces/${wsId}/schedules`);
        const schedules = data.schedules || [];

        if (schedules.length === 0) return text('No schedules configured for this workspace.');

        const summary = schedules.map((s: any) =>
          `- **${s.name}** ${s.enabled ? '' : '(PAUSED)'}\n  Cron: ${s.cronExpression} (${s.timezone})\n  Next: ${s.nextRunAt || 'N/A'} | Runs: ${s.totalRuns}${s.consecutiveFailures > 0 ? ` | Failures: ${s.consecutiveFailures}` : ''}\n  Task: ${s.taskTemplate.title}\n  ID: ${s.id}`
        ).join('\n\n');

        return text(`${schedules.length} schedule(s):\n\n${summary}`);
      }

      // No workspace — list across all accessible workspaces
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allSchedules: { workspace: string; schedule: any }[] = [];
      for (const ws of workspaces) {
        const data = await api(`/api/workspaces/${ws.id}/schedules`);
        for (const s of (data.schedules || [])) {
          allSchedules.push({ workspace: ws.name, schedule: s });
        }
      }

      if (allSchedules.length === 0) return text('No schedules configured across any workspace.');

      const summary = allSchedules.map(({ workspace, schedule: s }) =>
        `- **${s.name}** ${s.enabled ? '' : '(PAUSED)'} [${workspace}]\n  Cron: ${s.cronExpression} (${s.timezone})\n  Next: ${s.nextRunAt || 'N/A'} | Runs: ${s.totalRuns}${s.consecutiveFailures > 0 ? ` | Failures: ${s.consecutiveFailures}` : ''}\n  Task: ${s.taskTemplate.title}\n  ID: ${s.id}`
      ).join('\n\n');

      return text(`${allSchedules.length} schedule(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'register_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.content) throw new Error('name and content are required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillBody: Record<string, unknown> = {
        name: params.name,
        content: params.content,
        description: params.description || undefined,
        source: params.source || 'mcp',
      };
      if (params.model) skillBody.model = params.model;
      if (Array.isArray(params.allowedTools)) skillBody.allowedTools = params.allowedTools;
      if (Array.isArray(params.canDelegateTo)) skillBody.canDelegateTo = params.canDelegateTo;
      if (typeof params.background === 'boolean') skillBody.background = params.background;
      if (typeof params.maxTurns === 'number') skillBody.maxTurns = params.maxTurns;
      if (params.color) skillBody.color = params.color;
      if (params.mcpServers && typeof params.mcpServers === 'object') skillBody.mcpServers = params.mcpServers;
      if (params.requiredEnvVars && typeof params.requiredEnvVars === 'object') skillBody.requiredEnvVars = params.requiredEnvVars;
      if (typeof params.isRole === 'boolean') skillBody.isRole = params.isRole;
      if (params.slug) skillBody.slug = params.slug;

      const data = await api(`/api/workspaces/${wsId}/skills`, {
        method: 'POST',
        body: JSON.stringify(skillBody),
      });

      const skill = data.skill;
      return text(`Skill registered: "${skill.name}" (slug: ${skill.slug})\nOrigin: ${skill.origin}\nEnabled: ${skill.enabled}`);
    }

    case 'list_skills': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      // If workspace specified, list its skills
      if (wsId) {
        const qp = new URLSearchParams();
        if (typeof params.enabled === 'boolean') qp.set('enabled', String(params.enabled));
        if (typeof params.isRole === 'boolean') qp.set('isRole', String(params.isRole));
        const qs = qp.toString() ? `?${qp.toString()}` : '';

        const data = await api(`/api/workspaces/${wsId}/skills${qs}`);
        const skills = data.skills || [];
        if (skills.length === 0) return text('No skills found.');

        const summary = skills.map((s: any) => {
          const mcpCount = s.mcpServers
            ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
            : 0;
          const tags = [
            s.isRole ? 'role' : 'skill',
            s.enabled ? '' : 'DISABLED',
            s.model !== 'inherit' ? s.model : '',
            mcpCount > 0 ? `${mcpCount} MCP(s)` : '',
          ].filter(Boolean).join(', ');
          return `- **${s.name}** (\`${s.slug}\`) [${tags}]${s.description ? `\n  ${s.description}` : ''}`;
        }).join('\n');

        return text(`${skills.length} skill(s):\n\n${summary}`);
      }

      // No workspace — list across all accessible workspaces
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allSkills: { workspace: string; skill: any }[] = [];
      for (const ws of workspaces) {
        const qp = new URLSearchParams();
        if (typeof params.enabled === 'boolean') qp.set('enabled', String(params.enabled));
        if (typeof params.isRole === 'boolean') qp.set('isRole', String(params.isRole));
        const qs = qp.toString() ? `?${qp.toString()}` : '';
        const data = await api(`/api/workspaces/${ws.id}/skills${qs}`);
        for (const s of (data.skills || [])) {
          allSkills.push({ workspace: ws.name, skill: s });
        }
      }

      if (allSkills.length === 0) return text('No skills found across any workspace.');

      const summary = allSkills.map(({ workspace, skill: s }) => {
        const mcpCount = s.mcpServers
          ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
          : 0;
        const tags = [
          s.isRole ? 'role' : 'skill',
          s.enabled ? '' : 'DISABLED',
          s.model !== 'inherit' ? s.model : '',
          mcpCount > 0 ? `${mcpCount} MCP(s)` : '',
        ].filter(Boolean).join(', ');
        return `- **${s.name}** (\`${s.slug}\`) [${tags}] — ${workspace}${s.description ? `\n  ${s.description}` : ''}`;
      }).join('\n');

      return text(`${allSkills.length} skill(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'update_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.slug) throw new Error('slug is required to identify the skill to update');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillId = await resolveSkillId(api, wsId, params.slug as string);
      const body = buildSkillBody(params);

      if (Object.keys(body).length === 0) {
        throw new Error('No fields to update. Provide at least one field (name, content, mcpServers, etc.)');
      }

      const data = await api(`/api/workspaces/${wsId}/skills/${skillId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      const s = data.skill;
      const mcpCount = s.mcpServers
        ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
        : 0;
      return text(`Skill updated: "${s.name}" (slug: ${s.slug})\nModel: ${s.model} | Tools: ${(s.allowedTools || []).length || 'all'} | MCPs: ${mcpCount} | Delegates to: ${(s.canDelegateTo || []).join(', ') || 'none'}\nEnabled: ${s.enabled}`);
    }

    case 'delete_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.slug) throw new Error('slug is required to identify the skill to delete');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillId = await resolveSkillId(api, wsId, params.slug as string);

      await api(`/api/workspaces/${wsId}/skills/${skillId}`, {
        method: 'DELETE',
      });

      return text(`Skill "${params.slug}" deleted successfully.`);
    }

    case 'manage_secrets': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const subAction = params.action as string;
      if (!subAction || !['list', 'set', 'delete'].includes(subAction)) {
        throw new Error('action is required: "list", "set", or "delete"');
      }

      if (subAction === 'list') {
        const data = await api('/api/secrets');
        const secrets = data.secrets || [];
        if (secrets.length === 0) return text('No secrets found.');

        const summary = secrets.map((s: any) =>
          `- **${s.label || s.purpose}** (${s.purpose})\n  ID: ${s.id} | Created: ${s.createdAt}`
        ).join('\n');
        return text(`${secrets.length} secret(s):\n\n${summary}`);
      }

      if (subAction === 'set') {
        if (!params.label) throw new Error('label is required (env var name, e.g. "buildd-api-key")');
        if (!params.value) throw new Error('value is required (the secret value)');

        const data = await api('/api/secrets', {
          method: 'POST',
          body: JSON.stringify({
            value: params.value,
            purpose: params.purpose || 'mcp_credential',
            label: params.label,
          }),
        });

        return text(`Secret stored: label="${params.label}" | ID: ${data.id}`);
      }

      if (subAction === 'delete') {
        if (!params.secretId) throw new Error('secretId is required');

        await api(`/api/secrets?id=${params.secretId}`, {
          method: 'DELETE',
        });

        return text(`Secret ${params.secretId} deleted.`);
      }

      return text('Unknown action');
    }

    case 'create_artifact': {
      if (!params.type || !params.title) throw new Error('type and title are required');

      const validArtifactTypes = ['content', 'report', 'data', 'link', 'summary', 'email_draft', 'social_post', 'analysis', 'recommendation', 'alert', 'calendar_event', 'file'];
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

      // Support mission-level artifacts (no worker required) or worker artifacts
      let artifactData;
      if (params.missionId) {
        artifactData = await api(`/api/missions/${params.missionId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifactBody),
        });
      } else {
        const workerId = resolveWorkerId(params.workerId, ctx);
        artifactData = await api(`/api/workers/${workerId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifactBody),
        });
      }

      const art = artifactData.artifact;
      const upserted = artifactData.upserted ? ' (updated existing)' : '';
      return text(`Artifact created${upserted}: "${art.title}" (${art.type})\nID: ${art.id}\nShare URL: ${art.shareUrl}`);
    }

    case 'upload_artifact': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.filename || !params.mimeType || !params.sizeBytes) {
        throw new Error('filename, mimeType, and sizeBytes are required');
      }

      const uploadBody: Record<string, unknown> = {
        workerId,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
      };
      if (params.title) uploadBody.title = params.title;
      if (params.type) uploadBody.type = params.type;
      if (params.metadata && typeof params.metadata === 'object') uploadBody.metadata = params.metadata;

      const data = await api('/api/artifacts/upload-url', {
        method: 'POST',
        body: JSON.stringify(uploadBody),
      });

      const mimeStr = params.mimeType as string;
      const lines = [
        `Upload URL ready (expires in 10 minutes).`,
        ``,
        `Upload the file:`,
        `curl -X PUT -H "Content-Type: ${mimeStr}" --data-binary @./${params.filename} "${data.uploadUrl}"`,
        ``,
        `Download URL (permanent, for markdown embedding):`,
        data.downloadUrl,
        ``,
        `Share URL: ${data.shareUrl}`,
        `Artifact ID: ${data.artifactId}`,
      ];

      if (mimeStr.startsWith('image/')) {
        lines.push(``, `Markdown image: ![${params.title || params.filename}](${data.downloadUrl})`);
      }

      return text(lines.join('\n'));
    }

    case 'list_artifacts': {
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      const searchParams = new URLSearchParams();
      if (params.key) searchParams.set('key', params.key as string);
      if (params.type) searchParams.set('type', params.type as string);
      if (params.limit) searchParams.set('limit', String(params.limit));

      const formatArtifact = (a: any, workspace?: string) => {
        const preview = a.content && a.content.length > 200 ? a.content.slice(0, 200) + '...' : a.content;
        return `- **${a.title}** (${a.type}${a.key ? `, key: ${a.key}` : ''})${workspace ? ` [${workspace}]` : ''}\n  ID: ${a.id}\n  Updated: ${a.updatedAt}\n  Share: ${a.shareUrl || 'N/A'}${preview ? `\n  Preview: ${preview}` : ''}`;
      };

      if (wsId) {
        const data = await api(`/api/workspaces/${wsId}/artifacts?${searchParams}`);
        const artifactsList = data.artifacts || [];

        if (artifactsList.length === 0) {
          return text(`No artifacts found${params.key ? ` with key "${params.key}"` : ''}.`);
        }

        const summary = artifactsList.map((a: any) => formatArtifact(a)).join('\n\n');
        return text(`${artifactsList.length} artifact(s):\n\n${summary}`);
      }

      // No workspace — aggregate across all
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allArtifacts: { workspace: string; artifact: any }[] = [];
      for (const ws of workspaces) {
        const data = await api(`/api/workspaces/${ws.id}/artifacts?${searchParams}`);
        for (const a of (data.artifacts || [])) {
          allArtifacts.push({ workspace: ws.name, artifact: a });
        }
      }

      if (allArtifacts.length === 0) {
        return text(`No artifacts found${params.key ? ` with key "${params.key}"` : ''}.`);
      }

      const summary = allArtifacts.map(({ workspace, artifact: a }) => formatArtifact(a, workspace)).join('\n\n');
      return text(`${allArtifacts.length} artifact(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'get_artifact': {
      if (!params.artifactId) throw new Error('artifactId is required');

      const data = await api(`/api/artifacts/${params.artifactId}`);
      const art = data.artifact;

      const meta = [
        `**Title:** ${art.title || '(untitled)'}`,
        `**Type:** ${art.type}`,
        `**ID:** ${art.id}`,
        art.key && `**Key:** ${art.key}`,
        `**Created:** ${art.createdAt}`,
        `**Updated:** ${art.updatedAt}`,
        art.shareUrl && `**Share URL:** ${art.shareUrl}`,
        art.metadata && Object.keys(art.metadata).length > 0 && `**Metadata:** ${JSON.stringify(art.metadata)}`,
      ].filter(Boolean).join('\n');

      const content = art.content || '(no content)';

      return text(`${meta}\n\n## Content\n\n${content}`);
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

    case 'list_artifact_templates': {
      const { artifactTemplates } = await import('./artifact-templates');
      const templateList = Object.entries(artifactTemplates).map(([name, tmpl]) =>
        `## ${name}\n**Type:** ${tmpl.type}\n**Description:** ${tmpl.description}\n**Schema:**\n\`\`\`json\n${JSON.stringify(tmpl.schema, null, 2)}\n\`\`\``
      ).join('\n\n---\n\n');
      return text(`Available artifact templates:\n\n${templateList}\n\nUse create_artifact with matching type and structured content following the schema.`);
    }

    // ── Observability (Phase 5) ────────────────────────────────────────────

    case 'emit_event': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.type) throw new Error('type is required');
      if (!params.label) throw new Error('label is required');

      await api(`/api/workers/${workerId}`, {
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
      const workerId = resolveWorkerId(params.workerId, ctx);

      const data = await api(`/api/workers/${workerId}`);
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

    case 'suggest_schedule_update': {
      if (!params.reason) throw new Error('reason is required');
      if (params.cronExpression === undefined && params.enabled === undefined) {
        throw new Error('At least one of cronExpression or enabled must be provided');
      }

      // Resolve scheduleId from params or from worker's task context
      let scheduleId = params.scheduleId as string | undefined;
      let wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      if (!scheduleId && ctx.workerId) {
        const workerData = await api(`/api/workers/${ctx.workerId}`);
        const taskContext = workerData?.task?.context || workerData?.context || {};
        scheduleId = taskContext.scheduleId;
        if (!wsId) wsId = workerData?.workspaceId || workerData?.task?.workspaceId;
      }

      if (!scheduleId) throw new Error('scheduleId is required — pass it explicitly or run from a scheduled task');
      if (!wsId) throw new Error('Could not determine workspace.');

      const suggestionBody: Record<string, unknown> = {
        reason: params.reason,
      };
      if (params.cronExpression !== undefined) suggestionBody.cronExpression = params.cronExpression;
      if (params.enabled !== undefined) suggestionBody.enabled = params.enabled;
      if (ctx.workerId) suggestionBody.workerId = ctx.workerId;

      // Get taskId from worker context
      if (ctx.workerId) {
        try {
          const workerData = await api(`/api/workers/${ctx.workerId}`);
          if (workerData?.taskId) suggestionBody.taskId = workerData.taskId;
        } catch {
          // non-critical
        }
      }

      const result = await api(`/api/workspaces/${wsId}/schedules/${scheduleId}/suggestion`, {
        method: 'POST',
        body: JSON.stringify(suggestionBody),
      });

      const changes: string[] = [];
      if (params.cronExpression) changes.push(`cron → "${params.cronExpression}"`);
      if (params.enabled !== undefined) changes.push(`enabled → ${params.enabled}`);

      return text(`Schedule suggestion created for schedule ${scheduleId}.\nProposed changes: ${changes.join(', ')}\nReason: ${params.reason}\n\nThe suggestion is now pending human approval in the dashboard.`);
    }

    case 'approve_plan': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.taskId) throw new Error('taskId is required');

      const data = await api(`/api/tasks/${params.taskId}/approve-plan`, {
        method: 'POST',
      });

      const taskIds = data.tasks || [];
      return text(`Plan approved! Created ${taskIds.length} child task(s):\n${taskIds.map((id: string) => `- ${id}`).join('\n')}`);
    }

    case 'reject_plan': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.taskId) throw new Error('taskId is required');
      if (!params.feedback) throw new Error('feedback is required');

      const data = await api(`/api/tasks/${params.taskId}/reject-plan`, {
        method: 'POST',
        body: JSON.stringify({ feedback: params.feedback }),
      });

      return text(`Plan rejected. Revised planning task created: ${data.taskId}`);
    }

    case 'manage_missions': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const missionAction = params.action as string;
      if (!missionAction) throw new Error('action is required (list, create, get, update, delete, link_task, unlink_task)');

      switch (missionAction) {
        case 'list': {
          const qs = new URLSearchParams();
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (wsId) qs.set('workspaceId', wsId);
          }
          if (params.status) qs.set('status', params.status as string);
          const data = await api(`/api/missions?${qs}`);
          const missions = data.missions || [];
          if (missions.length === 0) return text('No missions found.');
          const summary = missions.map((m: any) =>
            `- **${m.title}** [${m.status}] — ${m.progress}% (${m.completedTasks}/${m.totalTasks} tasks)\n  ID: ${m.id}${m.workspace ? `\n  Workspace: ${m.workspace.name}` : ''}`
          ).join('\n\n');
          return text(`${missions.length} mission(s):\n\n${summary}`);
        }
        case 'create': {
          if (!params.title) throw new Error('title is required');
          const body: Record<string, unknown> = { title: params.title };
          if (params.description) body.description = params.description;
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          }
          if (params.cronExpression) body.cronExpression = params.cronExpression;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.skillSlugs) body.skillSlugs = params.skillSlugs;
          if (params.recipeId) body.recipeId = params.recipeId;
          if (params.model) body.model = params.model;
          if (params.isHeartbeat !== undefined) body.isHeartbeat = params.isHeartbeat;
          if (params.heartbeatChecklist) body.heartbeatChecklist = params.heartbeatChecklist;
          if (params.activeHoursStart !== undefined) body.activeHoursStart = params.activeHoursStart;
          if (params.activeHoursEnd !== undefined) body.activeHoursEnd = params.activeHoursEnd;
          if (params.activeHoursTimezone) body.activeHoursTimezone = params.activeHoursTimezone;
          const data = await api('/api/missions', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return text(`Mission created: "${data.title}" (ID: ${data.id})\nStatus: ${data.status}\nPriority: ${data.priority}`);
        }
        case 'get': {
          if (!params.missionId) throw new Error('missionId is required');
          const data = await api(`/api/missions/${params.missionId}`);
          const taskList = (data.tasks || []).map((t: any) =>
            `  - [${t.status}] ${t.title} (${t.id})`
          ).join('\n');
          const schedCtx = data.schedule?.taskTemplate?.context;
          const heartbeatInfo = schedCtx?.heartbeat ? `\nHeartbeat: enabled${schedCtx.activeHoursStart != null && schedCtx.activeHoursEnd != null ? ` (active ${schedCtx.activeHoursStart}:00-${schedCtx.activeHoursEnd}:00${schedCtx.activeHoursTimezone ? ` ${schedCtx.activeHoursTimezone}` : ''})` : ''}${schedCtx.heartbeatChecklist ? `\nChecklist: ${schedCtx.heartbeatChecklist}` : ''}` : '';
          return text(`**${data.title}** [${data.status}]\nID: ${data.id}\nProgress: ${data.progress}% (${data.completedTasks}/${data.totalTasks})\n${data.description ? `Description: ${data.description}\n` : ''}${heartbeatInfo}${taskList ? `\nLinked tasks:\n${taskList}` : '\nNo linked tasks.'}`);
        }
        case 'update': {
          if (!params.missionId) throw new Error('missionId is required');
          const body: Record<string, unknown> = {};
          if (params.title !== undefined) body.title = params.title;
          if (params.description !== undefined) body.description = params.description;
          if (params.status !== undefined) body.status = params.status;
          if (params.cronExpression !== undefined) body.cronExpression = params.cronExpression;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.workspaceId !== undefined) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          }
          if (params.skillSlugs !== undefined) body.skillSlugs = params.skillSlugs;
          if (params.recipeId !== undefined) body.recipeId = params.recipeId;
          if (params.model !== undefined) body.model = params.model;
          if (params.isHeartbeat !== undefined) body.isHeartbeat = params.isHeartbeat;
          if (params.heartbeatChecklist !== undefined) body.heartbeatChecklist = params.heartbeatChecklist;
          if (params.activeHoursStart !== undefined) body.activeHoursStart = params.activeHoursStart;
          if (params.activeHoursEnd !== undefined) body.activeHoursEnd = params.activeHoursEnd;
          if (params.activeHoursTimezone !== undefined) body.activeHoursTimezone = params.activeHoursTimezone;
          if (Object.keys(body).length === 0) throw new Error('At least one field to update is required');
          const data = await api(`/api/missions/${params.missionId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          return text(`Mission updated: "${data.title}" [${data.status}] (ID: ${data.id})`);
        }
        case 'delete': {
          if (!params.missionId) throw new Error('missionId is required');
          await api(`/api/missions/${params.missionId}`, { method: 'DELETE' });
          return text(`Mission deleted: ${params.missionId}`);
        }
        case 'link_task': {
          if (!params.missionId || !params.taskId) throw new Error('missionId and taskId are required');
          await api(`/api/tasks/${params.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ missionId: params.missionId }),
          });
          return text(`Task ${params.taskId} linked to mission ${params.missionId}`);
        }
        case 'unlink_task': {
          if (!params.taskId) throw new Error('taskId is required');
          await api(`/api/tasks/${params.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ missionId: null }),
          });
          return text(`Task ${params.taskId} unlinked from mission`);
        }
        default:
          throw new Error(`Unknown missions action: ${missionAction}. Use one of: list, create, get, update, delete, link_task, unlink_task`);
      }
    }

    // ── Workspaces ─────────────────────────────────────────────────────────

    case 'manage_workspaces': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsAction = params.action as string;
      if (!wsAction) throw new Error('action is required (list, create, update, create_repo, init)');

      switch (wsAction) {
        case 'create': {
          if (!params.name && !params.repoUrl) throw new Error('name or repoUrl is required');
          const body: Record<string, unknown> = {};
          if (params.name) body.name = params.name;
          if (params.repoUrl) body.repoUrl = params.repoUrl;
          if (params.defaultBranch) body.defaultBranch = params.defaultBranch;
          if (params.accessMode) body.accessMode = params.accessMode;
          const wsData = await api('/api/workspaces', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return text(`Workspace created: "${wsData.name}" (ID: ${wsData.id})${wsData.repo ? `\nRepo: ${wsData.repo}` : ''}`);
        }
        case 'list': {
          const data = await api('/api/workspaces');
          const wsList = data.workspaces || [];
          if (wsList.length === 0) return text('No workspaces found.');
          const summary = wsList.map((ws: any) =>
            `- **${ws.name}**${ws.repo ? ` (${ws.repo})` : ' (no repo)'}\n  ID: ${ws.id}${ws.accessMode ? ` | Access: ${ws.accessMode}` : ''}`
          ).join('\n\n');
          return text(`${wsList.length} workspace(s):\n\n${summary}`);
        }
        case 'update': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for update');
          const body: Record<string, unknown> = {};
          if (params.name !== undefined) body.name = params.name;
          if (params.repoUrl !== undefined) body.repoUrl = params.repoUrl;
          if (params.defaultBranch !== undefined) body.defaultBranch = params.defaultBranch;
          if (params.accessMode !== undefined) body.accessMode = params.accessMode;
          if (Object.keys(body).length === 0) throw new Error('At least one field to update is required (name, repoUrl, defaultBranch, accessMode)');
          await api(`/api/workspaces/${wsId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          return text(`Workspace ${wsId} updated.${body.repoUrl ? ` Repo set to: ${body.repoUrl}` : ''}${body.name ? ` Name set to: ${body.name}` : ''}`);
        }
        case 'create_repo': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for create_repo');
          if (!params.name) throw new Error('name (repo name) is required for create_repo');
          const repoData = await api(`/api/workspaces/${wsId}/create-repo`, {
            method: 'POST',
            body: JSON.stringify({
              name: params.name,
              org: params.org || undefined,
              private: params.private !== false,
              description: params.description || undefined,
            }),
          });
          if (repoData.error) {
            return errorResult(`Failed to create repo: ${repoData.error}${repoData.hint ? `\nHint: ${repoData.hint}` : ''}`);
          }
          return text(`Repository created: ${repoData.repoUrl}\nWorkspace updated with new repo URL.`);
        }
        case 'init': {
          // init is a runner-side action — return instructions for the agent
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for init');
          return text(`Workspace ${wsId} directory will be auto-created by the runner when a task is claimed. No-repo workspaces are resolved to a persistent project directory on the runner (e.g. /home/coder/project/{workspace-name}/). To set up the project:\n1. The runner creates the directory automatically\n2. Run \`git init\` in the workspace directory\n3. Use manage_workspaces action=create_repo or action=update to link a remote repo`);
        }
        default:
          throw new Error(`Unknown workspaces action: ${wsAction}. Use one of: list, create, update, create_repo, init`);
      }
    }

    // ── Recipes ───────────────────────────────────────────────────────────

    case 'list_recipes': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      if (wsId) {
        const data = await api(`/api/workspaces/${wsId}/recipes`);
        const recipes = data.recipes || [];

        if (recipes.length === 0) return text('No recipes configured for this workspace.');

        const summary = recipes.map((r: any) =>
          `- **${r.name}**${r.category ? ` [${r.category}]` : ''}\n  ${r.description || 'No description'}\n  Steps: ${r.steps?.length || 0} | Public: ${r.isPublic}\n  ID: ${r.id}`
        ).join('\n\n');

        return text(`${recipes.length} recipe(s):\n\n${summary}`);
      }

      // No workspace — aggregate across all
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allRecipes: { workspace: string; recipe: any }[] = [];
      for (const ws of workspaces) {
        const data = await api(`/api/workspaces/${ws.id}/recipes`);
        for (const r of (data.recipes || [])) {
          allRecipes.push({ workspace: ws.name, recipe: r });
        }
      }

      if (allRecipes.length === 0) return text('No recipes configured across any workspace.');

      const summary = allRecipes.map(({ workspace, recipe: r }) =>
        `- **${r.name}**${r.category ? ` [${r.category}]` : ''} [${workspace}]\n  ${r.description || 'No description'}\n  Steps: ${r.steps?.length || 0} | Public: ${r.isPublic}\n  ID: ${r.id}`
      ).join('\n\n');

      return text(`${allRecipes.length} recipe(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'create_recipe': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.steps) throw new Error('name and steps are required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const data = await api(`/api/workspaces/${wsId}/recipes`, {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          steps: params.steps,
          description: params.description || undefined,
          category: params.category || undefined,
          variables: params.variables || undefined,
          isPublic: params.isPublic || false,
        }),
      });

      const recipe = data.recipe;
      return text(`Recipe created: "${recipe.name}" (ID: ${recipe.id})\nSteps: ${recipe.steps?.length || 0}\nCategory: ${recipe.category || 'none'}`);
    }

    case 'run_recipe': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.recipeId) throw new Error('recipeId is required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const data = await api(`/api/workspaces/${wsId}/recipes/${params.recipeId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          variables: params.variables || {},
          parentTaskId: params.parentTaskId || undefined,
        }),
      });

      const taskIds = data.tasks || [];
      return text(`Recipe instantiated! Created ${taskIds.length} task(s):\n${taskIds.map((id: string) => `- ${id}`).join('\n')}`);
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
