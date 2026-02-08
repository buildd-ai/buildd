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
    instructions: `Buildd is a task coordination system for AI coding agents. Use these tools to manage your work.

**Worker workflow:**
1. List tasks → claim a task → checkout the returned branch name → do the work
2. Report progress at meaningful milestones (25%, 50%, 75%) with git stats
3. When done: push commits → create PR via buildd_create_pr → complete the task
4. If blocked or unable to finish: fail the task with a clear error message

**Admin workflow:**
- Create tasks when the user describes work to be done or wants to break a project into units
- Monitor workers and send instructions to redirect their work
- Reassign stuck tasks that aren't making progress

**Memory (REQUIRED):**
- When you claim a task, relevant memory is included automatically. READ IT before starting work.
- BEFORE touching unfamiliar files, call \`buildd_search_memory\` with keywords about the files/concepts
- AFTER encountering a gotcha, pattern, or decision, call \`buildd_save_memory\` IMMEDIATELY — don't wait until the end
- Observation types: **gotcha** (non-obvious bugs/traps), **pattern** (recurring code conventions), **decision** (architectural choices with rationale), **discovery** (learned behaviors/undocumented APIs), **architecture** (system structure/data flow)

**When to proactively use tools:**
- User says "pick up a task", "what's available", "get to work" → list then claim
- User describes work to be done or says "create a task" → buildd_create_task
- Starting work on unfamiliar code → buildd_search_memory first
- Hit a non-obvious bug or learned something important → buildd_save_memory`,
  }
);

// Base tools available to all levels
const baseTools = [
  {
    name: "buildd_list_tasks",
    description: "List available tasks from buildd that can be claimed. Use when the user asks about work, says 'what's available', or before claiming a task. Call with offset to see more.",
    inputSchema: {
      type: "object",
      properties: {
        offset: {
          type: "number",
          description: "Skip first N tasks (for 'show me more')",
          default: 0,
        },
      },
    },
  },
  {
    name: "buildd_claim_task",
    description: "Claim a task from buildd to work on. Returns worker info with task details. Use after listing tasks, or when user says 'pick up a task' or 'get to work'. After claiming, checkout the returned branch name before starting work.",
    inputSchema: {
      type: "object",
      properties: {
        maxTasks: {
          type: "number",
          description: "Maximum number of tasks to claim (default: 1)",
          default: 1,
        },
        workspaceId: {
          type: "string",
          description: "Optional: only claim from specific workspace",
        },
      },
    },
  },
  {
    name: "buildd_update_progress",
    description: "Report progress on a claimed task. Only call at meaningful milestones (e.g., 25%, 50%, 75%) - not for every small step. Include git stats when available.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "The worker ID from claim_task",
        },
        progress: {
          type: "number",
          description: "Progress percentage (0-100)",
        },
        message: {
          type: "string",
          description: "Status message",
        },
        inputTokens: {
          type: "number",
          description: "Total input tokens used so far",
        },
        outputTokens: {
          type: "number",
          description: "Total output tokens used so far",
        },
        lastCommitSha: {
          type: "string",
          description: "Latest commit SHA on the branch (from git rev-parse HEAD)",
        },
        commitCount: {
          type: "number",
          description: "Number of commits on branch (from git rev-list --count HEAD ^main)",
        },
        filesChanged: {
          type: "number",
          description: "Number of files changed (from git diff --stat main)",
        },
        linesAdded: {
          type: "number",
          description: "Lines added (green) from git diff --numstat",
        },
        linesRemoved: {
          type: "number",
          description: "Lines removed (red) from git diff --numstat",
        },
      },
      required: ["workerId", "progress"],
    },
  },
  {
    name: "buildd_complete_task",
    description: "Mark a task as completed. Call after finishing all work, committing changes, and creating a PR. Include a summary of what was done.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "The worker ID from claim_task",
        },
        summary: {
          type: "string",
          description: "Summary of what was done",
        },
      },
      required: ["workerId"],
    },
  },
  {
    name: "buildd_fail_task",
    description: "Mark a task as failed. Use when blocked, unable to complete the work, or the task is invalid. Provide a clear error message explaining what went wrong.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "The worker ID from claim_task",
        },
        error: {
          type: "string",
          description: "Error message explaining what went wrong",
        },
      },
      required: ["workerId", "error"],
    },
  },
  {
    name: "buildd_create_pr",
    description: "Create a GitHub pull request for a worker's branch. Requires workspace to be linked to a GitHub repo. Call after pushing commits and before completing the task.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "The worker ID from claim_task",
        },
        title: {
          type: "string",
          description: "PR title",
        },
        body: {
          type: "string",
          description: "PR description/body",
        },
        head: {
          type: "string",
          description: "The branch containing the changes (usually the worker's branch)",
        },
        base: {
          type: "string",
          description: "The branch to merge into (default: main)",
        },
        draft: {
          type: "boolean",
          description: "Create as draft PR (default: false)",
        },
      },
      required: ["workerId", "title", "head"],
    },
  },
  {
    name: "buildd_search_memory",
    description: "Search workspace memory for relevant observations. Returns compact index (id, title, type, files) - use buildd_get_memory for full details. Search at the start of a task for relevant context about the files and concepts you'll be working with.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text search query to find relevant observations",
        },
        type: {
          type: "string",
          description: "Filter by type: gotcha, pattern, decision, discovery, architecture, summary",
          enum: ["gotcha", "pattern", "decision", "discovery", "architecture", "summary"],
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Filter by file paths (matches observations referencing these files)",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 10, max: 50)",
          default: 10,
        },
      },
    },
  },
  {
    name: "buildd_get_memory",
    description: "Get full details for specific observations by ID. Use after searching to retrieve complete content.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Observation IDs from search results",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "buildd_submit_plan",
    description: "Submit an implementation plan for review. Use when an admin requests a plan or when working on a planning-mode task. The plan will be reviewed by the task author before implementation begins.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "The worker ID from claim_task",
        },
        plan: {
          type: "string",
          description: "Implementation plan in markdown format",
        },
      },
      required: ["workerId", "plan"],
    },
  },
  {
    name: "buildd_save_memory",
    description: "Save an observation to workspace memory. Use after encountering gotchas, making architectural decisions, discovering non-obvious patterns, or learning something that would help future workers. Include related file paths and concepts for searchability.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Type of observation",
          enum: ["gotcha", "pattern", "decision", "discovery", "architecture"],
        },
        title: {
          type: "string",
          description: "Short descriptive title",
        },
        content: {
          type: "string",
          description: "Full observation content with details",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Related file paths",
        },
        concepts: {
          type: "array",
          items: { type: "string" },
          description: "Related concepts/tags for categorization",
        },
      },
      required: ["type", "title", "content"],
    },
  },
];

// Admin-only tools
const adminTools = [
  {
    name: "buildd_create_task",
    description: "Create a new task in buildd. Use when the user describes work to be done, asks to create/add a task, or wants to break a project into trackable units. Workspace is auto-detected from git remote.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Task title",
        },
        description: {
          type: "string",
          description: "Task description with details of what needs to be done",
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID (optional - uses detected workspace if not provided)",
        },
        priority: {
          type: "number",
          description: "Priority (0-10, higher = more urgent)",
          default: 5,
        },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "buildd_reassign_task",
    description: "Force-reassign a stuck task. Marks current workers as failed and resets task to pending.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to reassign",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "buildd_send_instruction",
    description: "Send an instruction to a worker. The worker will receive it on their next progress update.",
    inputSchema: {
      type: "object",
      properties: {
        workerId: {
          type: "string",
          description: "The worker ID to send instructions to",
        },
        message: {
          type: "string",
          description: "The instruction message for the worker",
        },
      },
      required: ["workerId", "message"],
    },
  },
  {
    name: "buildd_run_cleanup",
    description: "Clean up stale workers and orphaned tasks. Marks timed-out workers as failed, resets orphaned tasks to pending, and expires old plan approvals.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "buildd_create_schedule",
    description: "Create a recurring task schedule. Tasks will be automatically created on the specified cron cadence. Workspace is auto-detected from git remote.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Schedule name (e.g., 'Nightly test suite')",
        },
        cronExpression: {
          type: "string",
          description: "Cron expression (5-field: minute hour day-of-month month day-of-week). Examples: '0 9 * * *' (daily 9am), '0 */6 * * *' (every 6 hours), '0 9 * * 1' (Mondays 9am)",
        },
        timezone: {
          type: "string",
          description: "Timezone (default: UTC). Examples: 'America/New_York', 'Europe/London'",
          default: "UTC",
        },
        title: {
          type: "string",
          description: "Task title to create on each run",
        },
        description: {
          type: "string",
          description: "Task description",
        },
        priority: {
          type: "number",
          description: "Task priority (0-10)",
          default: 5,
        },
        mode: {
          type: "string",
          description: "Task mode: 'execution' or 'planning'",
          default: "execution",
          enum: ["execution", "planning"],
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID (optional - uses detected workspace if not provided)",
        },
      },
      required: ["name", "cronExpression", "title"],
    },
  },
  {
    name: "buildd_list_schedules",
    description: "List task schedules for the workspace. Shows schedule names, cron expressions, next run times, and status.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "Workspace ID (optional - uses detected workspace if not provided)",
        },
      },
    },
  },
  {
    name: "buildd_decompose_task",
    description: "Decompose a large task into subtasks by creating a special decomposition task. A worker will claim this task, investigate the codebase, and create 3-7 implementable subtasks.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to decompose",
        },
      },
      required: ["taskId"],
    },
  },
];

// List available tools (dynamically based on account level)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const level = await getAccountLevel();
  const tools = level === 'admin' ? [...baseTools, ...adminTools] : baseTools;
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "buildd_list_tasks": {
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
        const offset = Math.max(args?.offset || 0, 0);
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

      case "buildd_claim_task": {
        // Use explicit arg, or fall back to auto-detected workspace
        const workspaceId = args?.workspaceId || await getWorkspaceId();
        const data = await apiCall("/api/workers/claim", {
          method: "POST",
          body: JSON.stringify({
            maxTasks: args?.maxTasks || 1,
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
                memorySection = `\n\n## Relevant Memory\nREAD these observations before starting work:\n${memoryLines.join('\n')}\n\nUse \`buildd_search_memory\` for more context.`;
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

      case "buildd_update_progress": {
        if (!args?.workerId) {
          throw new Error("workerId is required");
        }

        let response;
        try {
          response = await apiCall(`/api/workers/${args.workerId}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: "running",
              progress: args.progress || 0,
              // Token usage (optional)
              ...(typeof args.inputTokens === 'number' && { inputTokens: args.inputTokens }),
              ...(typeof args.outputTokens === 'number' && { outputTokens: args.outputTokens }),
              // Git stats (optional)
              ...(args.lastCommitSha && { lastCommitSha: args.lastCommitSha }),
              ...(typeof args.commitCount === 'number' && { commitCount: args.commitCount }),
              ...(typeof args.filesChanged === 'number' && { filesChanged: args.filesChanged }),
              ...(typeof args.linesAdded === 'number' && { linesAdded: args.linesAdded }),
              ...(typeof args.linesRemoved === 'number' && { linesRemoved: args.linesRemoved }),
            }),
          });
        } catch (err: any) {
          // Check if this is an abort signal (409 Conflict)
          if (err.message?.includes("409")) {
            return {
              content: [
                {
                  type: "text",
                  text: `**ABORT: Your worker has been terminated.** The task may have been reassigned by an admin. STOP working on this task immediately - do not push, commit, or create PRs. Use buildd_fail_task or simply stop.`,
                },
              ],
              isError: true,
            };
          }
          throw err;
        }

        // Check for admin instructions in response
        const instructions = response.instructions;
        let resultText = `Progress updated: ${args.progress}%${args.message ? ` - ${args.message}` : ""}`;

        if (instructions) {
          // Check if this is a structured instruction (e.g., request_plan)
          let parsedInstruction: { type?: string; message?: string } | null = null;
          try {
            parsedInstruction = JSON.parse(instructions);
          } catch {
            // Not JSON - treat as plain text instruction
          }

          if (parsedInstruction?.type === 'request_plan') {
            resultText += `\n\n**PLAN REQUESTED:** Please pause implementation. Investigate the codebase, then call buildd_submit_plan with your implementation plan in markdown format. ${parsedInstruction.message || ''}`;
          } else {
            resultText += `\n\n**ADMIN INSTRUCTION:** ${instructions}`;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: resultText,
            },
          ],
        };
      }

      case "buildd_complete_task": {
        if (!args?.workerId) {
          throw new Error("workerId is required");
        }

        try {
          await apiCall(`/api/workers/${args.workerId}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: "completed",
              ...(args.summary ? { summary: args.summary } : {}),
            }),
          });
        } catch (err: any) {
          // Check if this is an abort signal (409 Conflict)
          if (err.message?.includes("409")) {
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
              text: `Task completed successfully!${args.summary ? `\n\nSummary: ${args.summary}` : ""}`,
            },
          ],
        };
      }

      case "buildd_fail_task": {
        if (!args?.workerId || !args?.error) {
          throw new Error("workerId and error are required");
        }

        await apiCall(`/api/workers/${args.workerId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "failed",
            error: args.error,
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: `Task marked as failed: ${args.error}`,
            },
          ],
        };
      }

      case "buildd_create_pr": {
        if (!args?.workerId || !args?.title || !args?.head) {
          throw new Error("workerId, title, and head branch are required");
        }

        const data = await apiCall("/api/github/pr", {
          method: "POST",
          body: JSON.stringify({
            workerId: args.workerId,
            title: args.title,
            body: args.body,
            head: args.head,
            base: args.base,
            draft: args.draft,
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

      case "buildd_create_task": {
        // Admin-only tool - verify level first
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        if (!args?.title || !args?.description) {
          throw new Error("title and description are required");
        }

        // Use provided workspace or detect from git
        const workspaceId = args.workspaceId || await getWorkspaceId();
        if (!workspaceId) {
          throw new Error("Could not determine workspace. Provide workspaceId or run from a git repo linked to a workspace.");
        }

        // Build request body with creator tracking
        const taskBody: Record<string, unknown> = {
          workspaceId,
          title: args.title,
          description: args.description,
          priority: args.priority || 5,
          creationSource: 'mcp',
        };

        // If running in context of a worker, include worker context
        if (WORKER_ID) {
          taskBody.createdByWorkerId = WORKER_ID;
          // parentTaskId will be auto-derived from worker's current task by the API
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

      case "buildd_reassign_task": {
        // Admin-only tool - verify level first
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        if (!args?.taskId) {
          throw new Error("taskId is required");
        }

        await apiCall(`/api/tasks/${args.taskId}/reassign`, {
          method: "POST",
        });

        return {
          content: [
            {
              type: "text",
              text: `Task ${args.taskId} has been reassigned. Any active workers have been marked as failed and the task is now available for claiming.`,
            },
          ],
        };
      }

      case "buildd_send_instruction": {
        // Admin-only tool - verify level first
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        if (!args?.workerId || !args?.message) {
          throw new Error("workerId and message are required");
        }

        await apiCall(`/api/workers/${args.workerId}/instruct`, {
          method: "POST",
          body: JSON.stringify({
            message: args.message,
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: `Instruction queued for worker ${args.workerId}. They will receive it on their next progress update.`,
            },
          ],
        };
      }

      case "buildd_run_cleanup": {
        // Admin-only tool - verify level first
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        const data = await apiCall("/api/tasks/cleanup", {
          method: "POST",
        });

        const cleaned = data.cleaned || {};
        return {
          content: [
            {
              type: "text",
              text: `Cleanup completed:\n- Stalled workers marked failed: ${cleaned.stalledWorkers || 0}\n- Orphaned tasks reset to pending: ${cleaned.orphanedTasks || 0}\n- Expired plan approvals failed: ${cleaned.expiredPlans || 0}`,
            },
          ],
        };
      }

      case "buildd_create_schedule": {
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        if (!args?.name || !args?.cronExpression || !args?.title) {
          throw new Error("name, cronExpression, and title are required");
        }

        const workspaceId = args.workspaceId || await getWorkspaceId();
        if (!workspaceId) {
          throw new Error("Could not determine workspace. Provide workspaceId or run from a git repo linked to a workspace.");
        }

        const schedule = await apiCall(`/api/workspaces/${workspaceId}/schedules`, {
          method: "POST",
          body: JSON.stringify({
            name: args.name,
            cronExpression: args.cronExpression,
            timezone: args.timezone || 'UTC',
            taskTemplate: {
              title: args.title,
              description: args.description,
              priority: args.priority || 5,
              mode: args.mode || 'execution',
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

      case "buildd_list_schedules": {
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        const workspaceId = args?.workspaceId || await getWorkspaceId();
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

      case "buildd_decompose_task": {
        // Admin-only tool - verify level first
        const level = await getAccountLevel();
        if (level !== 'admin') {
          throw new Error("This operation requires an admin-level token");
        }

        if (!args?.taskId) {
          throw new Error("taskId is required");
        }

        // Fetch the parent task details
        const taskData = await apiCall(`/api/tasks/${args.taskId}`);
        const parentTask = taskData;

        if (!parentTask || !parentTask.id) {
          throw new Error(`Task ${args.taskId} not found`);
        }

        // Use provided workspace or detect from git
        const workspaceId = parentTask.workspaceId || await getWorkspaceId();
        if (!workspaceId) {
          throw new Error("Could not determine workspace.");
        }

        // Create a decomposition task
        const decompTask = await apiCall("/api/tasks", {
          method: "POST",
          body: JSON.stringify({
            workspaceId,
            title: `Decompose: ${parentTask.title}`,
            description: `Investigate the codebase and break down the parent task into 3-7 implementable subtasks.\n\n## Parent Task\n**${parentTask.title}**\n\n${parentTask.description || 'No description'}\n\n## Instructions\nFor each subtask, create it via the \`buildd_create_task\` tool. Focus on making subtasks independently implementable and well-scoped.\n\nAfter creating all subtasks, complete this task with a summary of what was created.`,
            priority: parentTask.priority || 5,
            parentTaskId: parentTask.id,
            creationSource: 'mcp',
            mode: 'execution',
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: `Decomposition task created: "${decompTask.title}" (ID: ${decompTask.id})\nParent: ${parentTask.title} (${parentTask.id})\n\nA worker will claim this task and create subtasks for the parent.`,
            },
          ],
        };
      }

      case "buildd_submit_plan": {
        if (!args?.workerId || !args?.plan) {
          throw new Error("workerId and plan are required");
        }

        await apiCall(`/api/workers/${args.workerId}/plan`, {
          method: "POST",
          body: JSON.stringify({ plan: args.plan }),
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

      case "buildd_search_memory": {
        const workspaceId = await getWorkspaceId();
        if (!workspaceId) {
          throw new Error("Could not determine workspace. Run from a git repo linked to a workspace or set BUILDD_WORKSPACE_ID.");
        }

        const params = new URLSearchParams();
        if (args?.query) params.set("query", args.query);
        if (args?.type) params.set("type", args.type);
        if (args?.files && Array.isArray(args.files) && args.files.length > 0) {
          params.set("files", args.files.join(","));
        }
        params.set("limit", String(Math.min(args?.limit || 10, 50)));

        const data = await apiCall(`/api/workspaces/${workspaceId}/observations/search?${params}`);

        if (!data.results || data.results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No observations found${args?.query ? ` matching "${args.query}"` : ""}. Use buildd_save_memory to record observations.`,
              },
            ],
          };
        }

        const summary = data.results.map((obs: { id: string; title: string; type: string; files: string[]; createdAt: string }) =>
          `- **${obs.type}**: ${obs.title}\n  ID: ${obs.id}\n  Files: ${obs.files?.slice(0, 3).join(", ") || "none"}`
        ).join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${data.total} observation(s)${data.total > data.results.length ? ` (showing ${data.results.length})` : ""}:\n\n${summary}\n\nUse buildd_get_memory with IDs for full details.`,
            },
          ],
        };
      }

      case "buildd_get_memory": {
        const workspaceId = await getWorkspaceId();
        if (!workspaceId) {
          throw new Error("Could not determine workspace. Run from a git repo linked to a workspace or set BUILDD_WORKSPACE_ID.");
        }

        if (!args?.ids || !Array.isArray(args.ids) || args.ids.length === 0) {
          throw new Error("ids array is required");
        }

        if (args.ids.length > 20) {
          throw new Error("Maximum 20 IDs per request");
        }

        const data = await apiCall(`/api/workspaces/${workspaceId}/observations/batch?ids=${args.ids.join(",")}`);

        if (!data.observations || data.observations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No observations found for the provided IDs.",
              },
            ],
          };
        }

        const details = data.observations.map((obs: { id: string; type: string; title: string; content: string; files: string[]; concepts: string[]; createdAt: string }) =>
          `## ${obs.type}: ${obs.title}\n**ID:** ${obs.id}\n**Files:** ${obs.files?.join(", ") || "none"}\n**Concepts:** ${obs.concepts?.join(", ") || "none"}\n\n${obs.content}`
        ).join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: details,
            },
          ],
        };
      }

      case "buildd_save_memory": {
        const workspaceId = await getWorkspaceId();
        if (!workspaceId) {
          throw new Error("Could not determine workspace. Run from a git repo linked to a workspace or set BUILDD_WORKSPACE_ID.");
        }

        if (!args?.type || !args?.title || !args?.content) {
          throw new Error("type, title, and content are required");
        }

        const validTypes = ["gotcha", "pattern", "decision", "discovery", "architecture"];
        if (!validTypes.includes(args.type)) {
          throw new Error(`Invalid type. Must be one of: ${validTypes.join(", ")}`);
        }

        const body: Record<string, unknown> = {
          type: args.type,
          title: args.title,
          content: args.content,
        };

        if (args.files && Array.isArray(args.files)) {
          body.files = args.files;
        }
        if (args.concepts && Array.isArray(args.concepts)) {
          body.concepts = args.concepts;
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
