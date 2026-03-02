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
  workerActions,
  adminActions,
  allActions as allActionsList,
  memoryActions,
  type ApiFn,
  type ActionContext,
} from './mcp-tools';
import { MemoryClient } from './memory-client';

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
  const filteredActions = level === 'admin'
    ? [...allActionsList]
    : [...workerActions];
  const filteredMemoryActions = [...memoryActions];

  const ctx: ActionContext = {
    workerId,
    workspaceId,
    getWorkspaceId: async () => workspaceId || null,
    getLevel: () => getAccountLevel(serverUrl, apiKey),
  };

  return createSdkMcpServer({
    name: 'buildd',
    version: '1.0.0',
    tools: [
      // ── buildd tool ──────────────────────────────────────────────────
      tool(
        'buildd',
        `Task coordination tool. Available actions: ${filteredActions.join(', ')}. Use action parameter to select operation, params for action-specific arguments.`,
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
        `Search, save, and manage shared team memories (code patterns, gotchas, decisions). Actions: ${filteredMemoryActions.join(', ')}`,
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
            return await handleMemoryAction(memClient, args.action, params, { project: memoryProject, workerId });
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
