#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";

const SERVER_URL = process.env.BUILDD_SERVER || "https://buildd-three.vercel.app";
const API_KEY = process.env.BUILDD_API_KEY || "";
const EXPLICIT_WORKSPACE_ID = process.env.BUILDD_WORKSPACE_ID || "";

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
  }
);

// Base tools available to all levels
const baseTools = [
  {
    name: "buildd_list_tasks",
    description: "List available tasks from buildd that can be claimed",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status (pending, assigned, completed, failed)",
          enum: ["pending", "assigned", "completed", "failed"],
        },
      },
    },
  },
  {
    name: "buildd_claim_task",
    description: "Claim a task from buildd to work on. Returns worker info with task details.",
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
    description: "Report progress on a claimed task. Include git stats when available for better tracking.",
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
    description: "Mark a task as completed",
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
    description: "Mark a task as failed",
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
    description: "Create a GitHub pull request for a worker's branch. Requires workspace to be linked to a GitHub repo.",
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
];

// Admin-only tools
const adminTools = [
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

        // Only filter by workspace if explicitly set via env var
        // (auto-detection from git caused confusion when workspace wasn't linked to repo)
        const explicitWorkspaceId = process.env.BUILDD_WORKSPACE_ID;
        let filtered = explicitWorkspaceId
          ? tasks.filter((t: Task) => t.workspaceId === explicitWorkspaceId)
          : tasks;

        // Filter by status if provided
        if (args?.status) {
          filtered = filtered.filter((t: Task) => t.status === args.status);
        }

        const summary = filtered.map((t: Task) =>
          `- [${t.status}] ${t.title} (id: ${t.id})\n  Workspace: ${t.workspace?.name || 'unknown'}\n  ${t.description?.slice(0, 100) || 'No description'}...`
        ).join("\n\n");

        // Show debug info
        let workspaceNote = "";
        if (explicitWorkspaceId && tasks.length > filtered.length) {
          workspaceNote = `\n\n(Filtered to workspace ${explicitWorkspaceId} - ${tasks.length - filtered.length} tasks hidden)`;
        } else if (explicitWorkspaceId) {
          workspaceNote = `\n\n(Filtered to BUILDD_WORKSPACE_ID)`;
        }

        return {
          content: [
            {
              type: "text",
              text: filtered.length > 0
                ? `Found ${filtered.length} tasks:\n\n${summary}${workspaceNote}`
                : `No tasks found.\n\nAPI returned ${tasks.length} tasks total. If you expect tasks, check that the API account is linked to workspaces via accountWorkspaces table.`,
            },
          ],
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

        return {
          content: [
            {
              type: "text",
              text: `Claimed ${workers.length} task(s):\n\n${claimed}\n\nUse the worker ID to report progress and completion.`,
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
          resultText += `\n\n**ADMIN INSTRUCTION:** ${instructions}`;
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
