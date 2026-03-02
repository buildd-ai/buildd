/**
 * Streamable HTTP MCP Server — remote, stateless, serverless-compatible.
 *
 * Handles JSON-RPC over HTTP using the MCP Streamable HTTP transport.
 * Auth: Bearer token (API key) validated via the same authenticateApiKey()
 * used by all other API routes.
 *
 * Key decisions:
 * - Stateless (no sessions) — compatible with Vercel serverless
 * - JSON responses (enableJsonResponse: true) — no SSE streaming timeout issues
 * - Server + transport created per request — standard serverless pattern
 * - Internal API calls use caller's Bearer token — no privilege escalation
 * - register_skill with filePath/repo: not supported (no filesystem access)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { authenticateApiKey } from "@/lib/api-auth";
import { db } from "@buildd/core/db";
import { workspaces } from "@buildd/core/db/schema";
import { eq } from "drizzle-orm";
import {
  handleBuilddAction,
  handleMemoryAction,
  workerActions,
  adminActions,
  allActions as allActionsList,
  memoryActions,
  buildToolDescription,
  buildParamsDescription,
  buildMemoryDescription,
  type ApiFn,
  type ActionContext,
} from "@buildd/core/mcp-tools";
import { MemoryClient } from "@buildd/core/memory-client";

// ── Auth Helper ──────────────────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// ── API Wrapper ──────────────────────────────────────────────────────────────

function createApi(apiKey: string): ApiFn {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXTAUTH_URL || "https://buildd.dev";

  return async (endpoint, options = {}) => {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    return response.json();
  };
}

// ── Account Level ────────────────────────────────────────────────────────────

async function getAccountLevel(api: ApiFn): Promise<'worker' | 'admin'> {
  try {
    const data = await api('/api/accounts/me');
    return data.level || 'worker';
  } catch {
    return 'worker';
  }
}

// ── Server Factory ───────────────────────────────────────────────────────────

function createMcpServer(api: ApiFn, accountLevel: 'worker' | 'admin', workspaceId?: string, repoName?: string) {
  const filteredActions = accountLevel === 'admin'
    ? [...allActionsList]
    : [...workerActions];

  const ctx: ActionContext = {
    workspaceId: workspaceId || undefined,
    getWorkspaceId: async () => workspaceId || null,
    getLevel: async () => accountLevel,
  };

  const server = new Server(
    { name: "buildd", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: `Buildd is a task coordination system for AI coding agents. Two tools: \`buildd\` (task actions) and \`buildd_memory\` (workspace knowledge).

**Worker workflow:**
1. \`buildd\` action=claim_task → checkout the returned branch → do the work.
2. Report progress at milestones (25%, 50%, 75%) via action=update_progress.
3. When done: push commits → action=create_pr → action=complete_task (with summary).

**Note:** This is a remote MCP server. register_skill with filePath/repo is not supported — use content param instead.

**Memory:** Use \`buildd_memory\` to search, save, update, or delete workspace observations.`,
    }
  );

  // ── Tools ────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "buildd",
        description: buildToolDescription(filteredActions),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object" as const,
          properties: {
            action: {
              type: "string" as const,
              description: `Action to perform: ${filteredActions.join(", ")}`,
              enum: filteredActions,
            },
            params: {
              type: "object" as const,
              description: buildParamsDescription(filteredActions),
            },
          },
          required: ["action"],
        },
      },
      {
        name: "buildd_memory",
        description: `Search, save, and manage shared team memories. Actions: ${[...memoryActions].join(', ')}`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object" as const,
          properties: {
            action: {
              type: "string" as const,
              description: `Action: ${[...memoryActions].join(', ')}`,
              enum: [...memoryActions],
            },
            params: {
              type: "object" as const,
              description: buildMemoryDescription(memoryActions),
            },
          },
          required: ["action"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "buildd") {
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        // Block filesystem-dependent actions in remote mode
        if (action === 'register_skill' && (params.filePath || params.repo)) {
          return {
            content: [{ type: "text" as const, text: "Error: filePath and repo params are not supported in the remote MCP server (no filesystem access). Use the content param instead, or use the local stdio MCP server." }],
            isError: true,
          };
        }

        return await handleBuilddAction(api, action, params, ctx);
      } else if (name === "buildd_memory") {
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        const memUrl = process.env.MEMORY_API_URL;
        const memKey = process.env.MEMORY_API_KEY;
        if (!memUrl || !memKey) {
          return {
            content: [{ type: "text" as const, text: "Memory service not configured on this server." }],
            isError: true,
          };
        }
        const memClient = new MemoryClient(memUrl, memKey);
        return await handleMemoryAction(memClient, action, params, { project: repoName });
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
        isError: true,
      };
    }
  });

  // ── Resources ──────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "buildd://tasks/pending",
        name: "Pending Tasks",
        description: "Pending tasks sorted by priority",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/memory",
        name: "Workspace Memory",
        description: "Team memories (patterns, gotchas, decisions)",
        mimeType: "text/plain",
      },
      {
        uri: "buildd://workspace/skills",
        name: "Workspace Skills",
        description: "Available skills",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    switch (uri) {
      case "buildd://tasks/pending": {
        const data = await api("/api/tasks");
        const pending = (data.tasks || [])
          .filter((t: any) => t.status === "pending")
          .sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));

        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: pending.length === 0
              ? "No pending tasks."
              : pending.map((t: any) =>
                  `[P${t.priority}] ${t.title} (${t.id})\n  ${t.description?.slice(0, 150) || 'No description'}`
                ).join("\n\n"),
          }],
        };
      }

      case "buildd://workspace/memory": {
        try {
          const memUrl = process.env.MEMORY_API_URL;
          const memKey = process.env.MEMORY_API_KEY;
          if (memUrl && memKey) {
            const memClient = new MemoryClient(memUrl, memKey);
            const data = await memClient.getContext(repoName);
            return {
              contents: [{ uri, mimeType: "text/plain", text: data.markdown || "No memories yet." }],
            };
          }
        } catch {
          // Fall through to default message
        }
        return {
          contents: [{ uri, mimeType: "text/plain", text: "Memory service not configured." }],
        };
      }

      case "buildd://workspace/skills":
        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: "Provide workspaceId in tool params to access workspace-scoped resources.",
          }],
        };

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  });

  return server;
}

// ── Request Handler ──────────────────────────────────────────────────────────

async function handleMcpRequest(req: Request): Promise<Response> {
  // Auth
  const apiKey = extractBearerToken(req);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve workspace from ?repo= query param
  const url = new URL(req.url);
  const repoParam = url.searchParams.get("repo");
  let workspaceId: string | undefined;

  if (repoParam) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.repo, repoParam),
      columns: { id: true },
    });
    workspaceId = workspace?.id;
  }

  // Create per-request API wrapper, server, and transport
  const api = createApi(apiKey);
  const accountLevel = account.level as 'worker' | 'admin' || 'worker';
  const server = createMcpServer(api, accountLevel, workspaceId, repoParam || undefined);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}

// ── Next.js Route Handlers ───────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
