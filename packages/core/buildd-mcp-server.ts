/**
 * In-process MCP server for Buildd worker coordination.
 *
 * Uses the SDK's createSdkMcpServer() + tool() helpers to provide
 * buildd coordination tools (progress reporting, task updates, memory)
 * directly in the worker process — no subprocess overhead.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
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
  type ApiFn,
  type ActionContext,
} from './mcp-tools';
import { MemoryClient } from './memory-client';
import { PgVectorStore, getVoyageEmbedder, getVoyageReranker } from './knowledge-store/index';

export interface BuilddMcpServerOptions {
  /** Buildd API server URL */
  serverUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Pre-assigned worker ID (if any) */
  workerId?: string;
  /** Workspace ID override */
  workspaceId?: string;
  /** Memory service URL */
  memoryApiUrl?: string;
  /** Memory service API key */
  memoryApiKey?: string;
  /** Project identifier for memory scoping */
  memoryProject?: string;
  /** Task mode — planning workers get a restricted toolset */
  taskMode?: string;
  /** Public-facing app base URL for deep-link generation (e.g. https://buildd.dev) */
  appBaseUrl?: string;
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

async function getAccountLevel(serverUrl: string, apiKey: string): Promise<'trigger' | 'worker' | 'admin'> {
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
export async function createBuilddMcpServer(opts: BuilddMcpServerOptions) {
  const { serverUrl, apiKey, workerId, workspaceId, memoryApiUrl, memoryApiKey, memoryProject } = opts;

  const api: ApiFn = (endpoint, options?) =>
    apiCall(serverUrl, apiKey, endpoint, options);

  // Memory client (optional — gracefully degrades if not configured)
  const memUrl = memoryApiUrl || process.env.MEMORY_API_URL;
  const memKey = memoryApiKey || process.env.MEMORY_API_KEY;
  const memClient = memUrl && memKey ? new MemoryClient(memUrl, memKey) : null;

  // Determine account level once at creation for dynamic toolset
  const level = await getAccountLevel(serverUrl, apiKey);

  // Resolve the owning team — memories are team-scoped, so the `memory` corpus
  // is namespaced by teamId. Best-effort; memory mirroring no-ops without it.
  let resolvedTeamId: string | undefined;
  try {
    const me = await apiCall(serverUrl, apiKey, '/api/accounts/me');
    resolvedTeamId = me?.teamId;
  } catch { /* best-effort */ }
  let filteredActions = level === 'admin'
    ? [...allActionsList]
    : level === 'trigger'
    ? [...triggerActions]
    : [...workerActions];
  const filteredMemoryActions = [...memoryActions];

  // Planning workers output a structured plan — remove create_task so
  // they physically cannot bypass the approve_plan flow.
  if (opts.taskMode === 'planning') {
    filteredActions = filteredActions.filter(a => a !== 'create_task');
  }

  // KnowledgeStore for best-effort auto-indexing of agent work product
  // (completed tasks, PRs, artifacts, approved plans). Same store the memory
  // tool uses; null embedder falls back to lexical-only indexing.
  const ctxEmbedder = getVoyageEmbedder();
  const ctxKnowledgeStore = workspaceId
    ? new PgVectorStore(ctxEmbedder, getVoyageReranker())
    : undefined;

  const ctx: ActionContext = {
    workerId,
    workspaceId,
    teamId: resolvedTeamId,
    getWorkspaceId: async () => workspaceId || null,
    getLevel: () => getAccountLevel(serverUrl, apiKey),
    appBaseUrl: opts.appBaseUrl,
    knowledgeStore: ctxKnowledgeStore,
    embedder: ctxEmbedder,
  };

  return createSdkMcpServer({
    name: 'buildd',
    version: '1.0.0',
    tools: [
      // ── buildd tool ──────────────────────────────────────────────────
      tool(
        'buildd',
        `Task coordination tool. Available actions: ${filteredActions.join(', ')}. Use action parameter to select operation, params for action-specific arguments. complete_task also accepts supersedes: string[] — knowledge source_ids this outcome replaces (e.g. "task:<taskId>", "pr:<number>"); superseded chunks drop out of default knowledge retrieval.`,
        {
          action: z.enum(filteredActions as [string, ...string[]]),
          params: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          try {
            const params = (args.params || {}) as Record<string, unknown>;
            return await handleBuilddAction(api, args.action, params, ctx);
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
        `Search, save, and manage shared team memories (code patterns, gotchas, decisions). Actions: ${filteredMemoryActions.join(', ')}. save/update also accept supersedes: string[] — memory IDs the new entry replaces; superseded entries drop out of default knowledge retrieval.`,
        {
          action: z.enum(filteredMemoryActions as [string, ...string[]]),
          params: z.record(z.string(), z.unknown()).optional(),
        },
        async (args) => {
          try {
            if (!memClient) {
              return {
                content: [{ type: 'text' as const, text: 'Memory service not configured. Set MEMORY_API_URL and MEMORY_API_KEY.' }],
                isError: true,
              };
            }
            const params = (args.params || {}) as Record<string, unknown>;
            const embedder = getVoyageEmbedder();
            const ks = workspaceId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
            return await handleMemoryAction(memClient, args.action, params, {
              project: memoryProject,
              workerId,
              workspaceId,
              teamId: resolvedTeamId,
              knowledgeStore: ks,
              embedder,
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

      // ── recall tool ───────────────────────────────────────────────────────
      tool(
        'recall',
        'Team knowledge base. Query this BEFORE starting work or diagnosing a failure — it holds prior gotchas, architecture decisions, and outcomes of past tasks, and will frequently contain the answer already. Pass the task title and any error message.',
        {
          query: z.string().optional(),
          scope: z.enum(['memory', 'task', 'pr', 'plan', 'artifact', 'code', 'docs', 'spec']).optional(),
          type: z.string().optional(),
          files: z.array(z.string()).optional(),
          limit: z.number().optional(),
          id: z.string().optional(),
        },
        async (args) => {
          try {
            if (!memClient) {
              return {
                content: [{ type: 'text' as const, text: 'Memory service not configured. Set MEMORY_API_URL and MEMORY_API_KEY.' }],
                isError: true,
              };
            }
            const embedder = getVoyageEmbedder();
            const ks = workspaceId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
            return await handleRecallAction(memClient, args as Record<string, unknown>, {
              project: memoryProject,
              workerId,
              workspaceId,
              teamId: resolvedTeamId,
              knowledgeStore: ks,
              embedder,
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
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
      ),

      // ── learn tool ────────────────────────────────────────────────────────
      tool(
        'learn',
        'Record a durable lesson for the team — a gotcha, pattern, decision, discovery, or architecture fact. Write what the next agent would have wanted to know. Near-duplicates are merged automatically.',
        {
          type: z.enum(['gotcha', 'pattern', 'decision', 'discovery', 'architecture']),
          title: z.string(),
          content: z.string(),
          files: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
          scope: z.string().optional(),
          supersedes: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            if (!memClient) {
              return {
                content: [{ type: 'text' as const, text: 'Memory service not configured. Set MEMORY_API_URL and MEMORY_API_KEY.' }],
                isError: true,
              };
            }
            const embedder = getVoyageEmbedder();
            const ks = workspaceId ? new PgVectorStore(embedder, getVoyageReranker()) : undefined;
            return await handleLearnAction(memClient, args as Record<string, unknown>, {
              project: memoryProject,
              workerId,
              workspaceId,
              teamId: resolvedTeamId,
              knowledgeStore: ks,
              embedder,
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
            openWorldHint: false,
          },
        },
      ),
    ],
  });
}
