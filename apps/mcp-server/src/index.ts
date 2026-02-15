#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Load ~/.buildd/config.json as fallback for env vars
 */
function loadBuilddConfig(): { apiKey?: string; builddServer?: string } {
  try {
    const configPath = join(homedir(), ".buildd", "config.json");
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const config = loadBuilddConfig();
const SERVER_URL = process.env.BUILDD_SERVER || config.builddServer || "https://buildd.dev";
const API_KEY = process.env.BUILDD_API_KEY || config.apiKey || "";
const EXPLICIT_WORKSPACE_ID = process.env.BUILDD_WORKSPACE_ID || process.env.BUILDD_WORKSPACE || "";
const WORKER_ID = process.env.BUILDD_WORKER_ID || "";

// Cache for workspace lookup and account info
let cachedWorkspaceId: string | null = null;
let cachedAccountLevel: 'worker' | 'admin' | null = null;

/**
 * Extract repo full name (owner/repo) from git remote URL
 */
function getRepoFullNameFromGit(): string | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^.]+)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // Handle HTTPS URLs: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^.]+)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];

    return null;
  } catch {
    return null;
  }
}

/**
 * Get workspace ID from repo full name via API
 */
async function getWorkspaceIdFromRepo(repoFullName: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${SERVER_URL}/api/workspaces/by-repo?repo=${encodeURIComponent(repoFullName)}`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
      }
    );

    if (!response.ok) return null;

    const data = await response.json();
    return data.workspace?.id || null;
  } catch {
    return null;
  }
}

/**
 * Get the workspace ID to use for filtering
 * Priority: BUILDD_WORKSPACE_ID env > git remote lookup > null (no filter)
 */
async function getWorkspaceId(): Promise<string | null> {
  // Use explicit env var if set
  if (EXPLICIT_WORKSPACE_ID) return EXPLICIT_WORKSPACE_ID;

  // Use cached value if available
  if (cachedWorkspaceId !== null) return cachedWorkspaceId || null;

  // Try to detect from git remote
  const repoFullName = getRepoFullNameFromGit();
  if (repoFullName) {
    cachedWorkspaceId = await getWorkspaceIdFromRepo(repoFullName);
    return cachedWorkspaceId;
  }

  cachedWorkspaceId = "";
  return null;
}

/**
 * Get the account level from API
 */
async function getAccountLevel(): Promise<'worker' | 'admin'> {
  if (cachedAccountLevel !== null) return cachedAccountLevel;

  try {
    const response = await fetch(`${SERVER_URL}/api/accounts/me`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      cachedAccountLevel = data.level || 'worker';
      return cachedAccountLevel;
    }
  } catch {
    // Default to worker level if fetch fails
  }

  cachedAccountLevel = 'worker';
  return cachedAccountLevel;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  workspaceId?: string;
  workspace?: { name: string };
}

interface Worker {
  id: string;
  taskId: string;
  branch: string;
  task: Task;
}

async function apiCall(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`${SERVER_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Create MCP server
const server = new Server(
  {
    name: "buildd",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `Buildd is a task coordination system for AI coding agents. Two tools: \`buildd\` (task actions) and \`buildd_memory\` (workspace knowledge).

**Worker workflow:**
1. \`buildd\` action=list_tasks → action=claim_task → checkout the returned branch → do the work
2. Report progress at milestones (25%, 50%, 75%) via action=update_progress. Include plan param to submit a plan for review.
3. When done: push commits → action=create_pr → action=complete_task (with summary). If blocked, use action=complete_task with error param instead.

**Admin actions** (hidden from workers): create_task, update_task, create_schedule, list_schedules, register_skill

**Memory (REQUIRED):**
- When you claim a task, relevant memory is included automatically. READ IT before starting.
- BEFORE touching unfamiliar files, use \`buildd_memory\` action=search with keywords
- AFTER encountering a gotcha, pattern, or decision, use \`buildd_memory\` action=save IMMEDIATELY
- Observation types: **gotcha** (non-obvious bugs/traps), **pattern** (recurring code conventions), **decision** (architectural choices), **discovery** (learned behaviors/undocumented APIs), **architecture** (system structure/data flow)`,
  }
);

// Worker actions available to all
const workerActions = [
  "list_tasks", "claim_task", "update_progress", "complete_task", "create_pr", "update_task",
];

// Admin-only actions
const adminActions = [
  "create_task", "create_schedule", "list_schedules", "register_skill",
];

// List available tools (dynamically based on account level)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const level = await getAccountLevel();
  const allActions = level === 'admin' ? [...workerActions, ...adminActions] : workerActions;

  const tools = [
    {
      name: "buildd",
      description: `Task coordination tool. Available actions: ${allActions.join(", ")}. Use action parameter to select operation, params for action-specific arguments.`,
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: `Action to perform: ${allActions.join(", ")}`,
            enum: allActions,
          },
          params: {
            type: "object",
            description: `Action-specific parameters. By action:
- list_tasks: { offset? }
- claim_task: { maxTasks?, workspaceId? }
- update_progress: { workerId (required), progress (required), message?, plan?, inputTokens?, outputTokens?, lastCommitSha?, commitCount?, filesChanged?, linesAdded?, linesRemoved? }
- complete_task: { workerId (required), summary?, error? } — if error present, marks task as failed
- create_pr: { workerId (required), title (required), head (required), body?, base?, draft? }
- update_task: { taskId (required), title?, description?, priority? }${level === 'admin' ? `
- create_task: { title (required), description (required), workspaceId?, priority? }
- create_schedule: { name (required), cronExpression (required), title (required), description?, timezone?, priority?, mode?, workspaceId? }
- list_schedules: { workspaceId? }
- register_skill: { name (required), content (required), description?, source?, workspaceId? }` : ''}`,
          },
        },
        required: ["action"],
      },
    },
    {
      name: "buildd_memory",
      description: "Search or save workspace memory (observations about code patterns, gotchas, decisions). Search returns full content inline.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "search or save",
            enum: ["search", "save"],
          },
          params: {
            type: "object",
            description: `Action-specific parameters:
- search: { query?, type?, files? (array), concepts? (array), limit? }
- save: { type (required: gotcha|pattern|decision|discovery|architecture), title (required), content (required), files? (array), concepts? (array) }`,
          },
        },
        required: ["action"],
      },
    },
  ];

  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "buildd") {
      const action = args?.action as string;
      const params = (args?.params || {}) as Record<string, unknown>;

      switch (action) {
        case "list_tasks": {
          const data = await apiCall("/api/tasks");
          const tasks = data.tasks || [];

          // Filter to pending tasks only (ready to claim)
          const explicitWorkspaceId = process.env.BUILDD_WORKSPACE_ID;
          let pending = tasks.filter((t: Task) => t.status === "pending");
          if (explicitWorkspaceId) {
            pending = pending.filter((t: Task) => t.workspaceId === explicitWorkspaceId);
          }

          // Sort by priority (higher first)
          pending.sort((a: Task, b: Task) => (b.priority || 0) - (a.priority || 0));

          // Apply pagination
          const limit = 5;
          const offset = Math.max((params.offset as number) || 0, 0);
          const paginated = pending.slice(offset, offset + limit);
          const hasMore = offset + limit < pending.length;

          if (paginated.length === 0) {
            return {
              content: [{ type: "text", text: "No pending tasks to claim." }],
            };
          }

          const summary = paginated.map((t: Task) =>
            `- ${t.title} (id: ${t.id})\n  ${t.description?.slice(0, 100) || 'No description'}...`
          ).join("\n\n");

          const header = `${pending.length} pending task${pending.length === 1 ? '' : 's'}:`;
          const moreHint = hasMore ? `\n\nCall with offset=${offset + limit} to see more.` : "";

          return {
            content: [{ type: "text", text: `${header}\n\n${summary}${moreHint}` }],
          };
        }

        case "claim_task": {
          // Use explicit arg, or fall back to auto-detected workspace
          const workspaceId = (params.workspaceId as string) || await getWorkspaceId();
          const data = await apiCall("/api/workers/claim", {
            method: "POST",
            body: JSON.stringify({
              maxTasks: params.maxTasks || 1,
              workspaceId,
              runner: "mcp",
            }),
          });

          const workers = data.workers || [];

          if (workers.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No tasks available to claim. All tasks may be assigned or completed.",
                },
              ],
            };
          }

          const claimed = workers.map((w: Worker) =>
            `**Worker ID:** ${w.id}\n**Task:** ${w.task.title}\n**Branch:** ${w.branch}\n**Description:** ${w.task.description || 'No description'}`
          ).join("\n\n---\n\n");

          // Generate env export commands for hooks integration
          const firstWorker = workers[0];
          const envExports = `# For Claude Code hooks integration (optional - enables automatic activity tracking):
export BUILDD_WORKER_ID=${firstWorker.id}
export BUILDD_SERVER=${SERVER_URL}`;

          // Proactively fetch relevant memory for the claimed task
          let memorySection = '';
          try {
            const firstTask = firstWorker.task;
            const resolvedWsId = workspaceId || firstWorker.task?.workspaceId;
            if (resolvedWsId && firstTask.title) {
              const searchData = await apiCall(
                `/api/workspaces/${resolvedWsId}/observations/search?query=${encodeURIComponent(firstTask.title)}&limit=5`
              );
              const results = searchData.results || [];
              if (results.length > 0) {
                const ids = results.map((r: { id: string }) => r.id).join(',');
                const batchData = await apiCall(
                  `/api/workspaces/${resolvedWsId}/observations/batch?ids=${ids}`
                );
                const observations = batchData.observations || [];
                if (observations.length > 0) {
                  const memoryLines = observations.map((o: { type: string; title: string; content: string }) => {
                    const truncContent = o.content.length > 200 ? o.content.slice(0, 200) + '...' : o.content;
                    return `- **[${o.type}] ${o.title}**: ${truncContent}`;
                  });
                  memorySection = `\n\n## Relevant Memory\nREAD these observations before starting work:\n${memoryLines.join('\n')}\n\nUse \`buildd_memory\` action=search for more context.`;
                }
              }
            }
          } catch {
            // Memory fetch is non-fatal — don't block the claim
          }

          return {
            content: [
              {
                type: "text",
                text: `Claimed ${workers.length} task(s):\n\n${claimed}${memorySection}\n\nUse the worker ID to report progress and completion.\n\n---\n${envExports}`,
              },
            ],
          };
        }

        case "update_progress": {
          if (!params.workerId) {
            throw new Error("workerId is required");
          }

          // If plan is present, submit plan instead
          if (params.plan) {
            await apiCall(`/api/workers/${params.workerId}/plan`, {
              method: "POST",
              body: JSON.stringify({ plan: params.plan }),
            });

            return {
              content: [
                {
                  type: "text",
                  text: "Your plan has been submitted for review. Please wait for the task author to approve it before proceeding with implementation. Do not make any changes until you receive approval.",
                },
              ],
            };
          }

          let response;
          try {
            // Build appendMilestones for status tracking
            const statusMilestone = params.message ? {
              appendMilestones: [{
                type: 'status',
                label: params.message,
                progress: params.progress || 0,
                ts: Date.now(),
              }],
            } : {};

            response = await apiCall(`/api/workers/${params.workerId}`, {
              method: "PATCH",
              body: JSON.stringify({
                status: "running",
                progress: params.progress || 0,
                ...(params.message && { currentAction: params.message }),
                ...statusMilestone,
                // Token usage (optional)
                ...(typeof params.inputTokens === 'number' && { inputTokens: params.inputTokens }),
                ...(typeof params.outputTokens === 'number' && { outputTokens: params.outputTokens }),
                // Git stats (optional)
                ...(params.lastCommitSha && { lastCommitSha: params.lastCommitSha }),
                ...(typeof params.commitCount === 'number' && { commitCount: params.commitCount }),
                ...(typeof params.filesChanged === 'number' && { filesChanged: params.filesChanged }),
                ...(typeof params.linesAdded === 'number' && { linesAdded: params.linesAdded }),
                ...(typeof params.linesRemoved === 'number' && { linesRemoved: params.linesRemoved }),
              }),
            });
          } catch (err: unknown) {
            // Check if this is an abort signal (409 Conflict)
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("409")) {
              return {
                content: [
                  {
                    type: "text",
                    text: `**ABORT: Your worker has been terminated.** The task may have been reassigned by an admin. STOP working on this task immediately - do not push, commit, or create PRs. Use complete_task with error param or simply stop.`,
                  },
                ],
                isError: true,
              };
            }
            throw err;
          }

          // Check for admin instructions in response
          const instructions = response.instructions;
          let resultText = `Progress updated: ${params.progress}%${params.message ? ` - ${params.message}` : ""}`;

          if (instructions) {
            // Check if this is a structured instruction (e.g., request_plan)
            let parsedInstruction: { type?: string; message?: string } | null = null;
            try {
              parsedInstruction = JSON.parse(instructions);
            } catch {
              // Not JSON - treat as plain text instruction
            }

            if (parsedInstruction?.type === 'request_plan') {
              resultText += `\n\n**PLAN REQUESTED:** Please pause implementation. Investigate the codebase, then use update_progress with plan param to submit your implementation plan. ${parsedInstruction.message || ''}`;
            } else {
              resultText += `\n\n**ADMIN INSTRUCTION:** ${instructions}`;
            }
          }

          return {
            content: [{ type: "text", text: resultText }],
          };
        }

        case "complete_task": {
          if (!params.workerId) {
            throw new Error("workerId is required");
          }

          // If error is present, mark as failed
          if (params.error) {
            await apiCall(`/api/workers/${params.workerId}`, {
              method: "PATCH",
              body: JSON.stringify({
                status: "failed",
                error: params.error,
              }),
            });

            return {
              content: [{ type: "text", text: `Task marked as failed: ${params.error}` }],
            };
          }

          // Otherwise mark as completed
          try {
            await apiCall(`/api/workers/${params.workerId}`, {
              method: "PATCH",
              body: JSON.stringify({
                status: "completed",
                ...(params.summary ? { summary: params.summary } : {}),
              }),
            });
          } catch (err: unknown) {
            // Check if this is an abort signal (409 Conflict)
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("409")) {
              return {
                content: [
                  {
                    type: "text",
                    text: `**WARNING: Worker was already terminated.** The task may have been reassigned. Your work may have been superseded by another worker.`,
                  },
                ],
                isError: true,
              };
            }
            throw err;
          }

          return {
            content: [
              {
                type: "text",
                text: `Task completed successfully!${params.summary ? `\n\nSummary: ${params.summary}` : ""}`,
              },
            ],
          };
        }

        case "create_pr": {
          if (!params.workerId || !params.title || !params.head) {
            throw new Error("workerId, title, and head branch are required");
          }

          const data = await apiCall("/api/github/pr", {
            method: "POST",
            body: JSON.stringify({
              workerId: params.workerId,
              title: params.title,
              body: params.body,
              head: params.head,
              base: params.base,
              draft: params.draft,
            }),
          });

          return {
            content: [
              {
                type: "text",
                text: `Pull request created!\n\n**PR #${data.pr.number}:** ${data.pr.title}\n**URL:** ${data.pr.url}\n**State:** ${data.pr.state}`,
              },
            ],
          };
        }

        case "update_task": {
          if (!params.taskId) {
            throw new Error("taskId is required");
          }

          const updateFields: Record<string, unknown> = {};
          if (params.title !== undefined) updateFields.title = params.title;
          if (params.description !== undefined) updateFields.description = params.description;
          if (params.priority !== undefined) updateFields.priority = params.priority;

          if (Object.keys(updateFields).length === 0) {
            throw new Error("At least one field (title, description, priority) must be provided");
          }

          const updated = await apiCall(`/api/tasks/${params.taskId}`, {
            method: "PATCH",
            body: JSON.stringify(updateFields),
          });

          return {
            content: [
              {
                type: "text",
                text: `Task updated: "${updated.title}" (ID: ${updated.id})\nStatus: ${updated.status}\nPriority: ${updated.priority}`,
              },
            ],
          };
        }

        case "create_task": {
          const level = await getAccountLevel();
          if (level !== 'admin') {
            throw new Error("This operation requires an admin-level token");
          }

          if (!params.title || !params.description) {
            throw new Error("title and description are required");
          }

          const workspaceId = (params.workspaceId as string) || await getWorkspaceId();
          if (!workspaceId) {
            throw new Error("Could not determine workspace. Provide workspaceId or run from a git repo linked to a workspace.");
          }

          const taskBody: Record<string, unknown> = {
            workspaceId,
            title: params.title,
            description: params.description,
            priority: params.priority || 5,
            creationSource: 'mcp',
          };

          if (WORKER_ID) {
            taskBody.createdByWorkerId = WORKER_ID;
          }

          const task = await apiCall("/api/tasks", {
            method: "POST",
            body: JSON.stringify(taskBody),
          });

          return {
            content: [
              {
                type: "text",
                text: `Task created: "${task.title}" (ID: ${task.id})\nStatus: pending\nPriority: ${task.priority}${WORKER_ID ? `\nCreated by worker: ${WORKER_ID}` : ''}`,
              },
            ],
          };
        }

        case "create_schedule": {
          const level = await getAccountLevel();
          if (level !== 'admin') {
            throw new Error("This operation requires an admin-level token");
          }

          if (!params.name || !params.cronExpression || !params.title) {
            throw new Error("name, cronExpression, and title are required");
          }

          const workspaceId = (params.workspaceId as string) || await getWorkspaceId();
          if (!workspaceId) {
            throw new Error("Could not determine workspace. Provide workspaceId or run from a git repo linked to a workspace.");
          }

          const schedule = await apiCall(`/api/workspaces/${workspaceId}/schedules`, {
            method: "POST",
            body: JSON.stringify({
              name: params.name,
              cronExpression: params.cronExpression,
              timezone: params.timezone || 'UTC',
              taskTemplate: {
                title: params.title,
                description: params.description,
                priority: params.priority || 5,
                mode: params.mode || 'execution',
              },
            }),
          });

          const sched = schedule.schedule;
          return {
            content: [
              {
                type: "text",
                text: `Schedule created: "${sched.name}" (ID: ${sched.id})\nCron: ${sched.cronExpression} (${sched.timezone})\nNext run: ${sched.nextRunAt || 'not scheduled'}\nCreates task: "${sched.taskTemplate.title}"`,
              },
            ],
          };
        }

        case "list_schedules": {
          const level = await getAccountLevel();
          if (level !== 'admin') {
            throw new Error("This operation requires an admin-level token");
          }

          const workspaceId = (params.workspaceId as string) || await getWorkspaceId();
          if (!workspaceId) {
            throw new Error("Could not determine workspace. Provide workspaceId or run from a git repo linked to a workspace.");
          }

          const data = await apiCall(`/api/workspaces/${workspaceId}/schedules`);
          const schedules = data.schedules || [];

          if (schedules.length === 0) {
            return {
              content: [{ type: "text", text: "No schedules configured for this workspace." }],
            };
          }

          const summary = schedules.map((s: { id: string; name: string; cronExpression: string; timezone: string; enabled: boolean; nextRunAt: string | null; totalRuns: number; consecutiveFailures: number; taskTemplate: { title: string } }) =>
            `- **${s.name}** ${s.enabled ? '' : '(PAUSED)'}\n  Cron: ${s.cronExpression} (${s.timezone})\n  Next: ${s.nextRunAt || 'N/A'} | Runs: ${s.totalRuns}${s.consecutiveFailures > 0 ? ` | Failures: ${s.consecutiveFailures}` : ''}\n  Task: ${s.taskTemplate.title}\n  ID: ${s.id}`
          ).join("\n\n");

          return {
            content: [{ type: "text", text: `${schedules.length} schedule(s):\n\n${summary}` }],
          };
        }

        case "register_skill": {
          const level = await getAccountLevel();
          if (level !== 'admin') {
            throw new Error("This operation requires an admin-level token");
          }

          if (!params.name || !params.content) {
            throw new Error("name and content are required");
          }

          const workspaceId = (params.workspaceId as string) || await getWorkspaceId();
          if (!workspaceId) {
            throw new Error("Could not determine workspace. Provide workspaceId or run from a git repo linked to a workspace.");
          }

          const data = await apiCall(`/api/workspaces/${workspaceId}/skills`, {
            method: "POST",
            body: JSON.stringify({
              name: params.name,
              content: params.content,
              description: params.description || undefined,
              source: params.source || 'mcp',
            }),
          });

          const skill = data.skill;
          return {
            content: [
              {
                type: "text",
                text: `Skill registered: "${skill.name}" (slug: ${skill.slug})\nOrigin: ${skill.origin}\nEnabled: ${skill.enabled}`,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } else if (name === "buildd_memory") {
      const action = args?.action as string;
      const params = (args?.params || {}) as Record<string, unknown>;

      switch (action) {
        case "search": {
          const workspaceId = await getWorkspaceId();
          if (!workspaceId) {
            throw new Error("Could not determine workspace. Run from a git repo linked to a workspace or set BUILDD_WORKSPACE_ID.");
          }

          const searchParams = new URLSearchParams();
          if (params.query) searchParams.set("query", params.query as string);
          if (params.type) searchParams.set("type", params.type as string);
          if (params.files && Array.isArray(params.files) && params.files.length > 0) {
            searchParams.set("files", (params.files as string[]).join(","));
          }
          if (params.concepts && Array.isArray(params.concepts) && params.concepts.length > 0) {
            searchParams.set("concepts", (params.concepts as string[]).join(","));
          }
          searchParams.set("limit", String(Math.min((params.limit as number) || 10, 50)));

          const data = await apiCall(`/api/workspaces/${workspaceId}/observations/search?${searchParams}`);

          if (!data.results || data.results.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No observations found${params.query ? ` matching "${params.query}"` : ""}. Use buildd_memory action=save to record observations.`,
                },
              ],
            };
          }

          // Fetch full content inline (replaces separate get_memory call)
          const ids = data.results.map((r: { id: string }) => r.id).join(',');
          let observations: Array<{ id: string; type: string; title: string; content: string; files: string[]; concepts: string[] }> = [];
          try {
            const batchData = await apiCall(
              `/api/workspaces/${workspaceId}/observations/batch?ids=${ids}`
            );
            observations = batchData.observations || [];
          } catch {
            // Fall back to summary-only if batch fails
            observations = [];
          }

          if (observations.length > 0) {
            const details = observations.map((obs) =>
              `## ${obs.type}: ${obs.title}\n**ID:** ${obs.id}\n**Files:** ${obs.files?.join(", ") || "none"}\n**Concepts:** ${obs.concepts?.join(", ") || "none"}\n\n${obs.content}`
            ).join("\n\n---\n\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${data.total} observation(s)${data.total > observations.length ? ` (showing ${observations.length})` : ""}:\n\n${details}`,
                },
              ],
            };
          }

          // Fallback: summary only
          const summary = data.results.map((obs: { id: string; title: string; type: string; files: string[] }) =>
            `- **${obs.type}**: ${obs.title}\n  ID: ${obs.id}\n  Files: ${obs.files?.slice(0, 3).join(", ") || "none"}`
          ).join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${data.total} observation(s)${data.total > data.results.length ? ` (showing ${data.results.length})` : ""}:\n\n${summary}`,
              },
            ],
          };
        }

        case "save": {
          const workspaceId = await getWorkspaceId();
          if (!workspaceId) {
            throw new Error("Could not determine workspace. Run from a git repo linked to a workspace or set BUILDD_WORKSPACE_ID.");
          }

          if (!params.type || !params.title || !params.content) {
            throw new Error("type, title, and content are required");
          }

          const validTypes = ["gotcha", "pattern", "decision", "discovery", "architecture"];
          if (!validTypes.includes(params.type as string)) {
            throw new Error(`Invalid type. Must be one of: ${validTypes.join(", ")}`);
          }

          const body: Record<string, unknown> = {
            type: params.type,
            title: params.title,
            content: params.content,
          };

          if (params.files && Array.isArray(params.files)) {
            body.files = params.files;
          }
          if (params.concepts && Array.isArray(params.concepts)) {
            body.concepts = params.concepts;
          }

          // Include worker context if available
          if (WORKER_ID) {
            body.workerId = WORKER_ID;
          }

          const data = await apiCall(`/api/workspaces/${workspaceId}/observations`, {
            method: "POST",
            body: JSON.stringify(body),
          });

          return {
            content: [
              {
                type: "text",
                text: `Observation saved: "${data.observation.title}" (${data.observation.type})\nID: ${data.observation.id}`,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown memory action: ${action}. Use "search" or "save".`);
      }
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("buildd MCP server running");
}

main().catch(console.error);
