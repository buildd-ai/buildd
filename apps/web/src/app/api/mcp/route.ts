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
import { workspaces, teams, workers as workersTable, tasks } from "@buildd/core/db/schema";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { pathsOverlap } from "@buildd/core/path-overlap";
import {
  handleBuilddAction,
  handleMemoryAction,
  handleRecallAction,
  handleLearnAction,
  triggerActions,
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
import { PgVectorStore, getVoyageEmbedder, getVoyageReranker } from "@buildd/core/knowledge-store";

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

async function getAccountLevel(api: ApiFn): Promise<'trigger' | 'worker' | 'admin'> {
  try {
    const data = await api('/api/accounts/me');
    return data.level || 'worker';
  } catch {
    return 'worker';
  }
}

// ── Memory Helper ────────────────────────────────────────────────────────────

/**
 * Resolve the team that owns a workspace's memories. Memories are team-scoped,
 * so the `memory` KnowledgeStore namespace keys on this id. Mirrors the same
 * workspace→team→fallback resolution as getMemoryClientForTeam.
 */
async function resolveTeamId(workspaceId: string | null | undefined, fallbackTeamId?: string): Promise<string | null> {
  if (workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    if (ws?.teamId) return ws.teamId;
  }
  return fallbackTeamId ?? null;
}

/**
 * Resolve workspace dataClass. Returns 'sensitive' on DB failure (fail-closed).
 */
async function resolveWorkspaceDataClass(workspaceId: string | null | undefined): Promise<'standard' | 'sensitive'> {
  if (!workspaceId) return 'standard';
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { dataClass: true },
    });
    return (ws?.dataClass as 'standard' | 'sensitive') ?? 'standard';
  } catch {
    return 'sensitive'; // fail-closed
  }
}

async function getMemoryClientForTeam(workspaceId: string | null | undefined, fallbackTeamId?: string): Promise<MemoryClient | null> {
  const url = process.env.MEMORY_API_URL;
  if (!url) return null;

  // Resolve teamId from workspace, or use fallback (e.g. from account)
  let teamId: string | undefined;
  if (workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { teamId: true },
    });
    teamId = ws?.teamId;
  }
  if (!teamId && fallbackTeamId) {
    teamId = fallbackTeamId;
  }
  if (!teamId) return null;

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { id: true, memoryApiKey: true },
  });
  if (!team) return null;

  if (team.memoryApiKey) {
    return new MemoryClient(url, team.memoryApiKey);
  }

  // Auto-provision: create a memory team + key for this Buildd team
  const rootKey = process.env.MEMORY_ROOT_KEY;
  if (rootKey) {
    try {
      const res = await fetch(`${url}/api/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rootKey}`,
        },
        body: JSON.stringify({ teamId: team.id, name: 'buildd-auto' }),
      });
      if (res.ok) {
        const data = await res.json();
        const newKey = data.key as string;
        await db.update(teams).set({ memoryApiKey: newKey }).where(eq(teams.id, team.id));
        return new MemoryClient(url, newKey);
      }
    } catch (err) {
      console.error('Failed to auto-provision memory key:', err);
    }
  }

  return null;
}

// ── Server Factory ───────────────────────────────────────────────────────────

function createMcpServer(api: ApiFn, accountLevel: 'trigger' | 'worker' | 'admin', workspaceId?: string, repoName?: string, accountTeamId?: string, workerId?: string, authType?: 'api' | 'oauth', appBaseUrl?: string, isSensitive?: boolean) {
  const filteredActions = accountLevel === 'admin'
    ? [...allActionsList]
    : accountLevel === 'trigger'
    ? [...triggerActions]
    : [...workerActions];

  // Lazy workspace resolver: if URL param didn't resolve, try the account's workspaces
  let resolvedWorkspaceId: string | null = workspaceId || null;
  const getWorkspaceId = async (): Promise<string | null> => {
    if (resolvedWorkspaceId) return resolvedWorkspaceId;

    // Fallback: query account's accessible workspaces via API
    try {
      const data = await api('/api/tasks');
      const taskWorkspaces = (data.tasks || [])
        .map((t: any) => t.workspaceId)
        .filter(Boolean);
      const uniqueIds = Array.from(new Set(taskWorkspaces)) as string[];

      if (uniqueIds.length === 1) {
        resolvedWorkspaceId = uniqueIds[0];
        return resolvedWorkspaceId;
      }

      // If repo hint provided, try matching workspace by repo name from task data
      if (repoName) {
        const wsWithRepo = (data.tasks || []).find((t: any) => t.workspace?.repo === repoName);
        if (wsWithRepo?.workspaceId) {
          resolvedWorkspaceId = wsWithRepo.workspaceId ?? null;
          return resolvedWorkspaceId;
        }
      }
    } catch {
      // API call failed, can't resolve
    }

    return null;
  };

  // KnowledgeStore for best-effort auto-indexing of agent work product
  // (completed tasks, PRs, artifacts, approved plans). The namespace's
  // workspaceId is resolved lazily inside the mirror, so the store can be
  // constructed unconditionally; null embedder falls back to lexical indexing.
  const ctxEmbedder = getVoyageEmbedder();
  const ctxKnowledgeStore = new PgVectorStore(ctxEmbedder, getVoyageReranker());

  const ctx: ActionContext = {
    workerId,
    workspaceId: resolvedWorkspaceId ?? undefined,
    authType,
    getWorkspaceId,
    getLevel: async () => accountLevel,
    appBaseUrl,
    knowledgeStore: ctxKnowledgeStore,
    embedder: ctxEmbedder,
  };

  const server = new Server(
    { name: "buildd", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: `Buildd is a task coordination system for AI coding agents. Tools: \`buildd\` (task actions), \`recall\` (read knowledge), \`learn\` (write knowledge). \`buildd_memory\` is deprecated — use \`recall\`/\`learn\` instead; it remains callable for compatibility.

**Token level:** ${accountLevel} — this determines which \`buildd\` actions are available. Actions not listed in the \`buildd\` tool schema require a higher-privilege token; calling them returns \`{"error":"forbidden",...}\` (a privilege failure, NOT an expired/invalid token).

**Worker workflow:**
1. \`recall\` (query: task title) BEFORE starting — check for prior gotchas and patterns.
2. \`buildd\` action=claim_task → checkout the returned branch → do the work.
3. Report progress at milestones (25%, 50%, 75%) via action=update_progress.
4. When done: push commits → action=create_pr → optionally action=get_pr to check CI/review state → action=merge_pr to merge once green.
5. Before completing: write a summary artifact (\`buildd\` action=create_artifact, type=summary) and save relevant lessons (\`learn\`).
6. \`buildd\` action=complete_task (with summary).

**Note:** This is a remote MCP server. register_skill with filePath/repo is not supported — use content param instead.

**Knowledge:** Use \`recall\` to query prior lessons before starting work. Use \`learn\` to record gotchas, patterns, and decisions for future agents. Admin-level tokens can also use \`buildd\` action=consolidate_knowledge and action=memory_delete.

**Artifacts:** Use \`buildd\` action=create_artifact to attach deliverables (summaries, reports, data) to your task.`,
    }
  );

  // ── Tools ────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: object[] = [
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
    ];

    // check_path_claim is available to worker and admin tokens (not trigger-only tokens).
    // Trigger tokens don't run agent work so they never need mid-task path expansion.
    if (accountLevel === 'worker' || accountLevel === 'admin') {
      tools.push({
        name: "check_path_claim",
        description: `Mid-task path-claim check. Call this when you discover you need to touch a file outside your declared pathManifest.

If the path is unclaimed by any active sibling task, your task's pathManifest is atomically extended and you can proceed.
If the path is already claimed by a sibling task, you receive blockingTaskId and must report blocked so a dependsOn edge can be added.

Requires a worker context (?worker=<workerId> in the MCP URL).`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: "object" as const,
          properties: {
            paths: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "File paths (or directory prefixes) you need to claim. Non-empty array of strings.",
            },
          },
          required: ["paths"],
        },
      });
    }

    if (!isSensitive) {
      tools.push(
        {
          name: "buildd_memory",
          description: `Legacy knowledge tool; recall (query) and learn (write) are the current interface — use those in new sessions. Kept callable for compatibility. Actions: ${[...memoryActions].join(', ')}`,
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
        {
          name: "recall",
          description: "Team knowledge base. Query this BEFORE starting work or diagnosing a failure — it holds prior gotchas, architecture decisions, and outcomes of past tasks, and will frequently contain the answer already. Pass the task title and any error message.",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          inputSchema: {
            type: "object" as const,
            properties: {
              query: {
                type: "string" as const,
                description: "Natural language query — the task title, error text, or concept to look up. Required unless id is provided.",
              },
              scope: {
                type: "string" as const,
                description: "Corpus to search. Default: memory. Options: memory | task | pr | plan | artifact | code | docs | spec",
                enum: ["memory", "task", "pr", "plan", "artifact", "code", "docs", "spec"],
              },
              type: {
                type: "string" as const,
                description: "Filter by memory type: gotcha | pattern | decision | discovery | architecture",
              },
              files: {
                type: "array" as const,
                items: { type: "string" as const },
                description: "Narrow results to entries touching these file paths.",
              },
              limit: {
                type: "number" as const,
                description: "Max results to return. Default: 10.",
              },
              id: {
                type: "string" as const,
                description: "Direct fetch by memory ID — bypasses ranking; all other params ignored.",
              },
            },
          },
        },
        {
          name: "learn",
          description: "Record a durable lesson for the team — a gotcha, pattern, decision, discovery, or architecture fact. Write what the next agent would have wanted to know. Near-duplicates are merged automatically.",
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
          inputSchema: {
            type: "object" as const,
            properties: {
              type: {
                type: "string" as const,
                description: "Memory type. One of: gotcha | pattern | decision | discovery | architecture",
                enum: ["gotcha", "pattern", "decision", "discovery", "architecture"],
              },
              title: {
                type: "string" as const,
                description: "Short title for this lesson.",
              },
              content: {
                type: "string" as const,
                description: "The lesson content — what the next agent should know.",
              },
              files: {
                type: "array" as const,
                items: { type: "string" as const },
                description: "File paths this lesson relates to.",
              },
              tags: {
                type: "array" as const,
                items: { type: "string" as const },
                description: "Tags for categorisation.",
              },
              scope: {
                type: "string" as const,
                description: "Project/monorepo scope for this memory.",
              },
              supersedes: {
                type: "array" as const,
                items: { type: "string" as const },
                description: "Memory IDs this entry replaces. Superseded entries drop out of default retrieval.",
              },
            },
            required: ["type", "title", "content"],
          },
        },
      );
    }

    return { tools };
  });

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

        // Admin-only knowledge management ops — moved out of buildd_memory to reduce builder schema cost
        if (action === 'consolidate_knowledge' || action === 'memory_delete') {
          // Guard: these are admin-only; non-admin tokens get a structured 403 (not a bare 401)
          if (accountLevel !== 'admin') {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: 'forbidden',
                  reason: `action '${action}' requires admin token level`,
                  tokenLevel: accountLevel,
                  requiredLevel: 'admin',
                }),
              }],
              isError: true,
            };
          }
          const wsId = await getWorkspaceId();
          if (!wsId && authType === 'oauth') {
            return {
              content: [{ type: "text" as const, text: "Cannot resolve workspace. Re-connect with ?workspace=<id> or use the workspace-pinned endpoint." }],
              isError: true,
            };
          }
          const memClient = await getMemoryClientForTeam(wsId, accountTeamId);
          if (!memClient && action === 'memory_delete') {
            return {
              content: [{ type: "text" as const, text: "Memory service not configured on this server." }],
              isError: true,
            };
          }
          const embedder = getVoyageEmbedder();
          const knowledgeStore = wsId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
          const memTeamId = await resolveTeamId(wsId, accountTeamId);
          return await handleMemoryAction(memClient, action === 'memory_delete' ? 'delete' : 'consolidate_knowledge', params, {
            project: repoName,
            workerId,
            workspaceId: wsId ?? undefined,
            teamId: memTeamId ?? undefined,
            knowledgeStore,
            embedder,
            api,
          });
        }

        return await handleBuilddAction(api, action, params, ctx);
      } else if (name === "buildd_memory") {
        // Defense-in-depth: gate even if the tool was somehow called despite being
        // absent from the ListTools response for sensitive workspaces.
        if (isSensitive) {
          return {
            content: [{ type: "text" as const, text: "Error: buildd_memory is not available in sensitive workspaces." }],
            isError: true,
          };
        }
        const action = args?.action as string;
        const params = (args?.params || {}) as Record<string, unknown>;

        // Refuse memory writes when the workspace is ambiguous for an OAuth
        // multi-workspace token. Same bug class as the claim/create_task
        // misroute (2026-05-25 incident): falling back to accountTeamId would
        // silently write memories to the wrong team's vault.
        const wsId = await getWorkspaceId();
        if (!wsId && authType === 'oauth') {
          return {
            content: [{ type: "text" as const, text: "Cannot resolve workspace for memory action. This OAuth token has access to multiple workspaces — re-connect with ?workspace=<id> or use the workspace-pinned /api/mcp-oauth/[workspace]/ endpoint." }],
            isError: true,
          };
        }
        const memClient = await getMemoryClientForTeam(wsId, accountTeamId);
        if (!memClient) {
          return {
            content: [{ type: "text" as const, text: "Memory service not configured on this server." }],
            isError: true,
          };
        }
        const embedder = getVoyageEmbedder();
        const knowledgeStore = wsId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
        const memTeamId = await resolveTeamId(wsId, accountTeamId);
        return await handleMemoryAction(memClient, action, params, {
          project: repoName,
          workerId,
          workspaceId: wsId ?? undefined,
          teamId: memTeamId ?? undefined,
          knowledgeStore,
          embedder,
          api,
          isSensitive,
        });
      } else if (name === "recall" || name === "learn") {
        // Defense-in-depth: gate even if the tool was somehow called despite being
        // absent from the ListTools response for sensitive workspaces.
        if (isSensitive) {
          return {
            content: [{ type: "text" as const, text: `Error: ${name} is not available in sensitive workspaces.` }],
            isError: true,
          };
        }
        // Workspace / memory client resolution shared with buildd_memory
        const wsId = await getWorkspaceId();
        if (!wsId && authType === 'oauth') {
          return {
            content: [{ type: "text" as const, text: "Cannot resolve workspace for knowledge action. This OAuth token has access to multiple workspaces — re-connect with ?workspace=<id> or use the workspace-pinned /api/mcp-oauth/[workspace]/ endpoint." }],
            isError: true,
          };
        }
        const memClient = await getMemoryClientForTeam(wsId, accountTeamId);
        if (!memClient) {
          return {
            content: [{ type: "text" as const, text: "Memory service not configured on this server." }],
            isError: true,
          };
        }
        const embedder = getVoyageEmbedder();
        const knowledgeStore = wsId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
        const memTeamId = await resolveTeamId(wsId, accountTeamId);

        const memCtx = {
          project: repoName,
          workerId,
          workspaceId: wsId ?? undefined,
          teamId: memTeamId ?? undefined,
          knowledgeStore,
          embedder,
          api,
          isSensitive,
        };

        if (name === "recall") {
          return await handleRecallAction(memClient, args as Record<string, unknown>, memCtx);
        } else {
          return await handleLearnAction(memClient, args as Record<string, unknown>, memCtx);
        }
      } else if (name === "check_path_claim") {
        if (!workerId) {
          return {
            content: [{ type: "text" as const, text: "check_path_claim requires a worker context. Reconnect with ?worker=<workerId> in the MCP URL." }],
            isError: true,
          };
        }

        const rawPaths = args?.paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
          return {
            content: [{ type: "text" as const, text: "paths must be a non-empty array of strings." }],
            isError: true,
          };
        }
        const paths = rawPaths as string[];

        // Resolve taskId from the worker row
        const workerRow = await db.query.workers.findFirst({
          where: eq(workersTable.id, workerId),
          columns: { taskId: true },
        });
        if (!workerRow?.taskId) {
          return {
            content: [{ type: "text" as const, text: "No active task found for this worker." }],
            isError: true,
          };
        }
        const taskId = workerRow.taskId;

        let mcpTask = await db.query.tasks.findFirst({
          where: eq(tasks.id, taskId),
          columns: { id: true, workspaceId: true, missionId: true, pathManifest: true, status: true },
        });
        if (!mcpTask) {
          return {
            content: [{ type: "text" as const, text: "Task not found." }],
            isError: true,
          };
        }
        if (!['pending', 'assigned', 'in_progress'].includes(mcpTask.status)) {
          return {
            content: [{ type: "text" as const, text: `Cannot claim paths for a task with status "${mcpTask.status}".` }],
            isError: true,
          };
        }

        const MCP_CLAIM_RETRIES = 3;
        for (let attempt = 0; attempt < MCP_CLAIM_RETRIES; attempt++) {
          // Scope is always workspace-wide — same logic as the REST path-claim
          // route. missionId is included so the response can distinguish
          // in-mission vs. cross-mission blockers for the caller.
          const siblings = await db.query.tasks.findMany({
            where: and(
              eq(tasks.workspaceId, mcpTask.workspaceId),
              inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
              isNotNull(tasks.pathManifest),
              ne(tasks.id, taskId),
            ),
            columns: { id: true, title: true, pathManifest: true, missionId: true },
          });

          for (const sibling of siblings) {
            if (!sibling.pathManifest?.length) continue;
            if (pathsOverlap(paths, sibling.pathManifest as string[])) {
              const isCrossMission =
                sibling.missionId !== null &&
                mcpTask.missionId !== null &&
                sibling.missionId !== mcpTask.missionId;
              const message = isCrossMission
                ? `Paths overlap with task "${sibling.title}" (${sibling.id.slice(0, 8)}) in a different mission (${sibling.missionId!.slice(0, 8)}). Report blocked with blockingTaskId and blockingMissionId — a dependsOn edge across missions is a significant coordination decision; escalate to a human or the organizer.`
                : `Paths overlap with sibling task "${sibling.title}" (${sibling.id.slice(0, 8)}). Report blocked with blockingTaskId so a dependsOn edge can be added.`;
              const result = {
                claimed: false,
                blockingTaskId: sibling.id,
                blockingTaskTitle: sibling.title,
                blockingMissionId: sibling.missionId ?? null,
                message,
              };
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            }
          }

          const existingManifest = (mcpTask.pathManifest as string[] | null) ?? [];
          const existingSet = new Set(existingManifest);
          const newPaths = paths.filter((p) => !existingSet.has(p));

          if (newPaths.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ claimed: true, pathManifest: existingManifest }) }],
            };
          }

          const updatedManifest = [...existingManifest, ...newPaths];

          // Atomic CAS: write only if pathManifest hasn't changed since we read it.
          const [updated] = await db
            .update(tasks)
            .set({ pathManifest: updatedManifest })
            .where(
              and(
                eq(tasks.id, taskId),
                sql`path_manifest IS NOT DISTINCT FROM ${JSON.stringify(existingManifest)}::jsonb`,
              )
            )
            .returning({ id: tasks.id });

          if (updated) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ claimed: true, pathManifest: updatedManifest }) }],
            };
          }

          // CAS failed — re-read and retry if attempts remain.
          if (attempt < MCP_CLAIM_RETRIES - 1) {
            const refreshed = await db.query.tasks.findFirst({
              where: eq(tasks.id, taskId),
              columns: { id: true, workspaceId: true, missionId: true, pathManifest: true, status: true },
            });
            if (!refreshed) {
              return {
                content: [{ type: "text" as const, text: "Task not found." }],
                isError: true,
              };
            }
            mcpTask = refreshed;
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ claimed: false, error: "Concurrent update conflict. Please retry." }) }],
        };
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
          const wsId = await getWorkspaceId();
          const memClient = await getMemoryClientForTeam(wsId, accountTeamId);
          if (memClient) {
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

  // Resolve workspace from query params: ?workspace= (ID) or ?repo= (repo name)
  const url = new URL(req.url);
  const workspaceParam = url.searchParams.get("workspace");
  const repoParam = url.searchParams.get("repo");
  let workspaceId: string | undefined;

  if (workspaceParam) {
    workspaceId = workspaceParam;
  } else if (repoParam) {
    // Try exact match first, then case-insensitive
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.repo, repoParam),
      columns: { id: true },
    });
    if (workspace) {
      workspaceId = workspace.id;
    } else {
      // Case-insensitive fallback
      const [wsRow] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(sql`LOWER(${workspaces.repo}) = LOWER(${repoParam})`)
        .limit(1);
      workspaceId = wsRow?.id;
      if (!workspaceId) {
        console.warn(`[MCP] No workspace found for repo="${repoParam}"`);
      }
    }
  }

  // Create per-request API wrapper, server, and transport
  const api = createApi(apiKey);
  const accountLevel = account.level as 'trigger' | 'worker' | 'admin' || 'worker';
  const workerParam = url.searchParams.get("worker");
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
  const dataClass = await resolveWorkspaceDataClass(workspaceId);
  const isSensitive = dataClass === 'sensitive';
  const server = createMcpServer(api, accountLevel, workspaceId, repoParam || undefined, account.teamId, workerParam || undefined, account.authType, appBaseUrl, isSensitive);

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

export async function GET(_req: Request): Promise<Response> {
  // Stateless server — no SSE notifications to push.
  // Returning 405 stops MCP clients from polling the SSE endpoint
  // (which otherwise reconnects every ~1s on serverless, burning invocations).
  return new Response("SSE not supported on stateless server", { status: 405 });
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
