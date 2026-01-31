#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_URL = process.env.BUILDD_SERVER || "https://buildd-three.vercel.app";
const API_KEY = process.env.BUILDD_API_KEY || "";

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      description: "Report progress on a claimed task",
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
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "buildd_list_tasks": {
        const data = await apiCall("/api/tasks");
        const tasks = data.tasks || [];

        // Filter by status if provided
        const filtered = args?.status
          ? tasks.filter((t: Task) => t.status === args.status)
          : tasks;

        const summary = filtered.map((t: Task) =>
          `- [${t.status}] ${t.title} (${t.workspace?.name || 'no workspace'})\n  ${t.description?.slice(0, 100) || 'No description'}...`
        ).join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: filtered.length > 0
                ? `Found ${filtered.length} tasks:\n\n${summary}`
                : "No tasks found",
            },
          ],
        };
      }

      case "buildd_claim_task": {
        const data = await apiCall("/api/workers/claim", {
          method: "POST",
          body: JSON.stringify({
            maxTasks: args?.maxTasks || 1,
            workspaceId: args?.workspaceId,
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

        await apiCall(`/api/workers/${args.workerId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "running",
            progress: args.progress || 0,
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: `Progress updated: ${args.progress}%${args.message ? ` - ${args.message}` : ""}`,
            },
          ],
        };
      }

      case "buildd_complete_task": {
        if (!args?.workerId) {
          throw new Error("workerId is required");
        }

        await apiCall(`/api/workers/${args.workerId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
          }),
        });

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
